import WebSocket from 'ws';
import { ChainSource } from './chain-source';
import { ChainBlock, ProjectedBlock } from '../types';

/**
 * Relays the public WebSocket of any mempool-compatible instance
 * (mempool.guide, or a self-hosted mempool).
 *
 * Protocol (the standard mempool frontend protocol):
 *   -> {"action":"init"}
 *   -> {"action":"want","data":["blocks","mempool-blocks"]}
 *   <- {"blocks":[...], "mempool-blocks":[...], "block":{...}}
 */
export class MempoolSource extends ChainSource {
  private ws?: WebSocket;
  private retry = 0;
  private pingTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private url: string, label: string, private datumPools: string[] = []) {
    super(label);
  }

  private mapBlock(b: any): ChainBlock {
    return mapBlock(b, this.datumPools);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(this.url, { headers: { 'User-Agent': 'asic-fleet-dashboard' } });
    this.ws = ws;

    ws.on('open', () => {
      this.retry = 0;
      console.log(`[mempool] connected to ${this.url}`);
      ws.send(JSON.stringify({ action: 'init' }));
      ws.send(JSON.stringify({ action: 'want', data: ['blocks', 'mempool-blocks'] }));
      // keep-alive: mempool drops idle sockets
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"action":"ping"}'), 30_000);
    });

    ws.on('message', (raw) => {
      try {
        this.handle(JSON.parse(raw.toString()));
      } catch (e) {
        console.warn('[mempool] bad message', (e as Error).message);
      }
    });

    const reconnect = () => {
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      console.warn(`[mempool] disconnected, retrying in ${delay} ms`);
      setTimeout(() => this.connect(), delay);
    };
    ws.on('close', reconnect);
    ws.on('error', (e) => {
      console.warn('[mempool] error', e.message);
      ws.terminate();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handle(msg: any): void {
    if (Array.isArray(msg.blocks)) {
      const blocks = msg.blocks.map((b: any) => this.mapBlock(b)).sort((a: ChainBlock, b: ChainBlock) => b.height - a.height).slice(0, 8);
      this.publish({ blocks, tipHeight: blocks[0]?.height ?? this.state.tipHeight });
    }
    if (msg.block) {
      this.pushBlock(this.mapBlock(msg.block));
    }
    if (Array.isArray(msg['mempool-blocks'])) {
      const projected: ProjectedBlock[] = msg['mempool-blocks'].slice(0, 8).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (b: any, index: number) => ({
          index,
          nTx: b.nTx,
          vsize: b.blockVSize,
          medianFee: b.medianFee,
          feeRange: b.feeRange ?? [],
          totalFees: b.totalFees,
        }),
      );
      this.publish({ projected });
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** the coinbase's readable text (mempool sends it as hex in extras.coinbaseRaw) */
function coinbaseText(hex: unknown): string {
  return typeof hex === 'string' ? Buffer.from(hex, 'hex').toString('latin1') : '';
}

/**
 * DATUM Verified: mined through DATUM Gateway. Either solo, with the miner's own node and gateway
 * (DATUM Gateway writes its tag into the coinbase, mempool names the miner "DATUM …"), or in one of
 * this network's DATUM pools (OCEAN on Bitcoin, CONVOY on Bitcoin BLAKE2b).
 */
export function isDatumBlock(pool: string | undefined, coinbase: string, datumPools: string[]): boolean {
  const p = (pool ?? '').trim().toLowerCase();
  if (p && datumPools.some((d) => d.toLowerCase() === p)) return true;
  return /\bdatum\b/i.test(pool ?? '') || /DATUM Gateway/i.test(coinbase);
}

function mapBlock(b: any, datumPools: string[]): ChainBlock {
  return {
    height: b.height,
    hash: b.id,
    timestamp: b.timestamp,
    txCount: b.tx_count,
    size: b.size,
    weight: b.weight,
    medianFee: b.extras?.medianFee ?? 0,
    feeRange: b.extras?.feeRange ?? [],
    totalFees: b.extras?.totalFees ?? 0,
    pool: b.extras?.pool?.name,
    datum: isDatumBlock(b.extras?.pool?.name, coinbaseText(b.extras?.coinbaseRaw), datumPools),
  };
}
