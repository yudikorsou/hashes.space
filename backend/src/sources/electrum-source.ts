import crypto from 'crypto';
import net from 'net';
import tls from 'tls';
import { ChainSource } from './chain-source';
import { ChainBlock, HashAlgo, ProjectedBlock } from '../types';

export interface ElectrumOptions {
  host: string;
  port: number;
  tls: boolean;
  algo: HashAlgo;
}

/**
 * Chain data from an Electrum server (Electrs, Fulcrum, ElectrumX).
 * Protocol: newline-delimited JSON-RPC over TCP or TLS.
 *
 *   server.version                  handshake
 *   blockchain.headers.subscribe    tip + a push for every new block
 *   blockchain.block.header         80-byte header of a height (for the time)
 *   mempool.get_fee_histogram       [[sat/vB, vsize], …] → projected blocks
 *
 * Electrum doesn't know block sizes, tx counts or fees, so mined blocks are
 * marked `partial`. Pair it with node RPC for full detail.
 */
export class ElectrumSource extends ChainSource {
  private sock?: net.Socket;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private retry = 0;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private opts: ElectrumOptions, label: string) {
    super(label);
  }

  /** Connect and handshake once; used to test the settings before saving them. */
  static async test(opts: ElectrumOptions, timeoutMs = 6000): Promise<string> {
    const src = new ElectrumSource(opts, 'test');
    src.stopped = true; // a test connection never reconnects
    try {
      await src.open(timeoutMs);
      const v = (await src.call('server.version', ['hashes.space', '1.4'], timeoutMs)) as string[];
      const tip = (await src.call('blockchain.headers.subscribe', [], timeoutMs)) as { height: number };
      return `${v?.[0] ?? 'Electrum server'} at height ${tip.height.toLocaleString('en-US')}`;
    } finally {
      src.stop();
    }
  }

  start(): void {
    this.stopped = false;
    this.run().catch(() => this.reconnect());
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    this.sock?.destroy();
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
  }

  private async run(): Promise<void> {
    await this.open(8000);
    this.retry = 0;
    await this.call('server.version', ['hashes.space', '1.4']);
    const tip = (await this.call('blockchain.headers.subscribe', [])) as { height: number; hex: string };
    await this.loadRecent(tip.height);
    await this.loadProjected();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.loadProjected().catch(() => undefined), 10_000);
  }

  private reconnect(): void {
    clearInterval(this.timer);
    this.sock?.destroy();
    if (this.stopped || this.reconnectTimer) return; // one pending retry at a time
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.start();
    }, delay);
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const { host, port } = this.opts;
      const sock = this.opts.tls
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
        : net.createConnection({ host, port });
      this.sock = sock;
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`no answer from ${host}:${port}`));
      }, timeoutMs);
      sock.once(this.opts.tls ? 'secureConnect' : 'connect', () => {
        clearTimeout(t);
        resolve();
      });
      sock.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
      sock.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('connection closed'));
        this.pending.clear();
        if (!this.stopped) this.reconnect();
      });
      sock.on('data', (d) => this.onData(d.toString()));
    });
  }

  private call(method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.sock?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? String(msg.error)));
          else p.resolve(msg.result);
        } else if (msg.method === 'blockchain.headers.subscribe') {
          const h = msg.params?.[0] as { height: number; hex: string };
          if (h) this.pushBlock(this.blockFromHeader(h.height, h.hex));
        }
      } catch {
        /* ignore malformed line */
      }
    }
  }

  private async loadRecent(tip: number): Promise<void> {
    const blocks: ChainBlock[] = [];
    for (let h = tip; h > tip - 8 && h >= 0; h--) {
      const hex = (await this.call('blockchain.block.header', [h])) as string;
      blocks.push(this.blockFromHeader(h, hex));
    }
    this.publish({ blocks, tipHeight: tip });
  }

  /** Split the mempool fee histogram into 1 MvB blocks, highest fee first. */
  private async loadProjected(): Promise<void> {
    const hist = ((await this.call('mempool.get_fee_histogram', [])) as [number, number][]).sort((a, b) => b[0] - a[0]);
    const projected: ProjectedBlock[] = [];
    let cur: { vsize: number; fees: number[]; weights: number[] } = { vsize: 0, fees: [], weights: [] };
    const flush = () => {
      if (!cur.vsize) return;
      const half = cur.vsize / 2;
      let acc = 0;
      let medianFee = cur.fees[cur.fees.length - 1];
      for (let i = 0; i < cur.fees.length; i++) {
        acc += cur.weights[i];
        if (acc >= half) {
          medianFee = cur.fees[i];
          break;
        }
      }
      projected.push({
        index: projected.length,
        nTx: 0,
        vsize: cur.vsize,
        medianFee,
        feeRange: [cur.fees[cur.fees.length - 1], cur.fees[0]],
        totalFees: Math.round(cur.fees.reduce((a, f, i) => a + f * cur.weights[i], 0)),
      });
      cur = { vsize: 0, fees: [], weights: [] };
    };
    for (let [fee, vsize] of hist) {
      while (vsize > 0 && projected.length < 8) {
        const room = 1_000_000 - cur.vsize;
        const take = Math.min(room, vsize);
        cur.vsize += take;
        cur.fees.push(fee);
        cur.weights.push(take);
        vsize -= take;
        if (cur.vsize >= 1_000_000) flush();
      }
    }
    if (projected.length < 8) flush();
    this.publish({ projected });
  }

  private blockFromHeader(height: number, hex: string): ChainBlock {
    const header = Buffer.from(hex, 'hex');
    const timestamp = header.length >= 72 ? header.readUInt32LE(68) : Math.floor(Date.now() / 1000);
    // the BLAKE2b block hash isn't derived here; the height identifies the block
    const hash = `height-${height}`;
    return { height, hash, timestamp, txCount: 0, size: 0, weight: 0, medianFee: 0, feeRange: [0, 0], totalFees: 0, partial: true };
  }
}
