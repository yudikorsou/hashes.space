import fs from 'fs';
import { ChainSource, median, percentiles } from './chain-source';
import { ChainBlock, ProjectedBlock } from '../types';

/**
 * Reads chain data straight from your own Bitcoin Core or Bitcoin Knots node
 * over JSON-RPC. Both implementations expose the same RPCs used here:
 *   getblockchaininfo, getbestblockhash, getblockhash, getblockheader,
 *   getblockstats, getblocktemplate, getmempoolinfo
 *
 * The "block being mined" is taken from getblocktemplate – i.e. exactly the
 * template your own node would hand to your miners (or to DATUM Gateway).
 * Further projected blocks are estimated from the remaining mempool size.
 */
export class NodeSource extends ChainSource {
  private timer?: NodeJS.Timeout;
  private lastTip = '';
  private busy = false;

  constructor(
    private opts: { rpcUrl: string; rpcUser?: string; rpcPassword?: string; cookieFile?: string; pollMs: number },
    label: string,
  ) {
    super(label);
  }

  /**
   * Check the RPC settings before they are saved.
   * Returns e.g. "Bitcoin Knots 28.1 (main) at height 968,568".
   */
  static async test(opts: { rpcUrl: string; rpcUser?: string; rpcPassword?: string }): Promise<string> {
    const src = new NodeSource({ ...opts, pollMs: 0 }, 'test');
    const info = await src.rpc('getblockchaininfo');
    const net = await src.rpc('getnetworkinfo').catch(() => null);
    const sub: string = net?.subversion ?? '';
    const knots = /knots/i.test(sub);
    const version = (sub.match(/Satoshi:([\d.]+)/) ?? [])[1];
    const name = `${knots ? 'Bitcoin Knots' : 'Bitcoin Core'}${version ? ' ' + version : ''}`;
    return `${name} (${info.chain}) at height ${Number(info.blocks).toLocaleString('en-US')}`;
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.opts.pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private auth(): string {
    let user = this.opts.rpcUser ?? '';
    let pass = this.opts.rpcPassword ?? '';
    if (this.opts.cookieFile) {
      const [u, p] = fs.readFileSync(this.opts.cookieFile, 'utf8').trim().split(':');
      user = u;
      pass = p;
    }
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.opts.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.auth() },
      body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) throw new Error('the node refused the RPC user or password');
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const info = await this.rpc('getblockchaininfo');
      if (this.state.network !== info.chain) this.state.network = info.chain;

      const tip: string = info.bestblockhash;
      if (tip !== this.lastTip) {
        const first = !this.lastTip;
        this.lastTip = tip;
        if (first) {
          const blocks: ChainBlock[] = [];
          for (let h = info.blocks; h > info.blocks - 8 && h >= 0; h--) blocks.push(await this.readBlock(h));
          this.publish({ blocks, tipHeight: info.blocks });
        } else {
          this.pushBlock(await this.readBlock(info.blocks));
        }
      }

      this.publish({ projected: await this.readProjected() });
    } catch (e) {
      console.warn('[node] poll failed:', (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private async readBlock(height: number): Promise<ChainBlock> {
    const s = await this.rpc('getblockstats', [height]);
    return {
      height,
      hash: s.blockhash,
      timestamp: s.time,
      txCount: s.txs,
      size: s.total_size,
      weight: s.total_weight,
      medianFee: s.feerate_percentiles?.[2] ?? 0,
      feeRange: [s.minfeerate ?? 0, ...(s.feerate_percentiles ?? []), s.maxfeerate ?? 0],
      totalFees: s.totalfee,
    };
  }

  private async readProjected(): Promise<ProjectedBlock[]> {
    // Block 0 = the template this node is handing out right now.
    const tpl = await this.rpc('getblocktemplate', [{ rules: ['segwit'] }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txs: any[] = tpl.transactions;
    const rates = txs.map((t) => t.fee / (t.weight / 4));
    const vsize = txs.reduce((a, t) => a + t.weight / 4, 0);
    const next: ProjectedBlock = {
      index: 0,
      nTx: txs.length,
      vsize,
      medianFee: median(rates),
      feeRange: percentiles(rates),
      totalFees: txs.reduce((a, t) => a + t.fee, 0),
    };

    // Rough estimate of further blocks from the remaining mempool backlog.
    const mp = await this.rpc('getmempoolinfo');
    const remaining = Math.max(0, mp.bytes - vsize);
    const extra = Math.min(7, Math.ceil(remaining / 1_000_000));
    const minFee = (mp.mempoolminfee ?? 0.00001) * 1e5; // BTC/kvB -> sat/vB
    const projected = [next];
    for (let i = 1; i <= extra; i++) {
      const fee = Math.max(minFee, next.medianFee / (i + 1));
      projected.push({
        index: i,
        nTx: Math.round((next.nTx || 3000) * 0.9),
        vsize: Math.min(1_000_000, remaining - (i - 1) * 1_000_000),
        medianFee: fee,
        feeRange: [minFee, fee, fee * 1.5],
        totalFees: Math.round(fee * 1_000_000),
      });
    }
    return projected;
  }
}
