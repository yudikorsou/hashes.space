import { ChainSource, median, percentiles } from './chain-source';
import { ChainBlock, ProjectedBlock } from '../types';

/**
 * Monero (RandomX) from an onion-monero-blockchain-explorer, e.g. https://xmrchain.net,
 * which reads straight from a synced monerod node. Polls its JSON API:
 *   GET /api/networkinfo                 tip height, median block size, base fee
 *   GET /api/transactions?page=0&limit=8 the last blocks with their transactions
 *   GET /api/mempool?limit=…             transactions waiting for the next block
 *
 * Monero amounts are in piconero (1 XMR = 10^12). Fees are shown in nXMR/B
 * (nanonero per byte); the colour follows the fee as a multiple of the base fee,
 * on the same scale mempool uses for sat/vB.
 */
export class XmrchainSource extends ChainSource {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private medianBytes = 300_000;
  /** explorer APIs in order: your own first; a fallback (xmrchain.net) only while yours can't be reached */
  private bases: string[];
  private active = 0;
  private ticks = 0;
  private baseFeePerByte = 20_000; // piconero per byte, from networkinfo.fee_per_kb

  constructor(
    apiUrl: string,
    label: string,
    private pollMs = 15_000,
    fallbackApiUrl?: string,
  ) {
    super(label, 'mainnet');
    this.bases = [apiUrl, fallbackApiUrl].filter((u): u is string => !!u).map((u) => u.replace(/\/+$/, ''));
  }

  /** "xmr.hashes.space" for the API in use */
  private get apiUrl(): string {
    return this.bases[this.active];
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body?.status && body.status !== 'success') throw new Error(String(body.message ?? body.status));
    return (body?.data ?? body) as T;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // back to your own explorer as soon as it answers again (checked every 4th poll while on the fallback)
      if (this.active > 0 && this.ticks++ % 4 === 0) {
        const own = this.active;
        this.active = 0;
        try {
          await this.get<NetworkInfo>('/networkinfo');
          this.publish({ source: new URL(this.apiUrl).host, blocks: [] });
        } catch {
          this.active = own;
        }
      }
      let info: NetworkInfo;
      try {
        info = await this.get<NetworkInfo>('/networkinfo');
      } catch (e) {
        if (this.active + 1 >= this.bases.length) throw e;
        console.warn(`[xmrchain] ${this.apiUrl}: ${(e as Error).message}; using ${this.bases[this.active + 1]} until it answers`);
        this.active++;
        this.publish({ source: new URL(this.apiUrl).host, blocks: [] });
        info = await this.get<NetworkInfo>('/networkinfo');
      }
      if (info.block_size_median) this.medianBytes = Number(info.block_size_median);
      if (info.fee_per_kb) this.baseFeePerByte = Number(info.fee_per_kb);
      const tip = Number(info.height) - 1; // networkinfo.height is the next block's height

      if (tip !== this.state.tipHeight || !this.state.blocks.length) {
        const { blocks } = await this.get<{ blocks: XBlock[] }>('/transactions?page=0&limit=8');
        const mapped = blocks.map((b) => this.mapBlock(b)).sort((a, b) => b.height - a.height);
        const isNew = this.state.blocks.length > 0 && mapped[0] && mapped[0].height > this.state.tipHeight;
        this.publish({ blocks: mapped, tipHeight: Math.max(tip, mapped[0]?.height ?? 0), ...this.units() });
        if (isNew) this.emit('block', mapped[0]);
      }

      const pool = await this.get<{ txs: XTx[] }>('/mempool?limit=2000').catch(() => ({ txs: [] as XTx[] }));
      this.publish({ projected: this.project(pool.txs ?? []), ...this.units() });
    } catch (e) {
      if (!this.state.blocks.length) console.warn(`[xmrchain] ${this.apiUrl}: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** how the strip writes and colours Monero fees and sizes */
  private units() {
    return { feeUnit: 'nXMR/B', feeColorScale: 1000 / this.baseFeePerByte, fullBlockBytes: this.medianBytes };
  }

  /** piconero per byte → nXMR per byte */
  private feeRate(t: XTx): number {
    return t.tx_size ? Number(t.tx_fee) / Number(t.tx_size) / 1000 : 0;
  }

  private mapBlock(b: XBlock): ChainBlock {
    const txs = (b.txs ?? []).filter((t) => !t.coinbase);
    const rates = txs.map((t) => this.feeRate(t));
    return {
      height: Number(b.height),
      hash: String(b.hash),
      timestamp: Number(b.timestamp),
      txCount: txs.length,
      size: Number(b.size) || 0,
      // the strip fills a block by weight / 4,000,000; a Monero block is "full" at the median size
      weight: Math.min(4_000_000, ((Number(b.size) || 0) / this.medianBytes) * 4_000_000),
      medianFee: median(rates),
      feeRange: rates.length ? percentiles(rates) : [0, 0],
      totalFees: txs.reduce((a, t) => a + Number(t.tx_fee || 0), 0),
    };
  }

  /** fill the waiting transactions, best fee per byte first, into blocks of the median size */
  private project(txs: XTx[]): ProjectedBlock[] {
    const sorted = [...txs].sort((a, b) => this.feeRate(b) - this.feeRate(a));
    const out: ProjectedBlock[] = [];
    let cur: XTx[] = [];
    let bytes = 0;
    const flush = () => {
      if (!cur.length && out.length) return;
      const rates = cur.map((t) => this.feeRate(t));
      out.push({
        index: out.length,
        nTx: cur.length,
        // the strip fills a projected block by vsize / 1,000,000
        vsize: Math.min(1_000_000, (bytes / this.medianBytes) * 1_000_000),
        bytes,
        medianFee: median(rates),
        feeRange: rates.length ? percentiles(rates) : [0, 0],
        totalFees: cur.reduce((a, t) => a + Number(t.tx_fee || 0), 0),
      });
      cur = [];
      bytes = 0;
    };
    for (const t of sorted) {
      if (out.length >= 6) break;
      if (bytes + Number(t.tx_size) > this.medianBytes && cur.length) flush();
      cur.push(t);
      bytes += Number(t.tx_size) || 0;
    }
    if (out.length < 6) flush();
    return out;
  }
}

interface NetworkInfo {
  height: number | string;
  block_size_median?: number;
  fee_per_kb?: number;
}
interface XTx {
  coinbase?: boolean;
  tx_fee: number | string;
  tx_size: number | string;
}
interface XBlock {
  height: number;
  hash: string;
  timestamp: number;
  size: number;
  txs?: XTx[];
}
