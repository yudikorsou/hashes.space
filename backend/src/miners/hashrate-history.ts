/**
 * Hashrate history per miner, for the "Hashrate health" chart (like the
 * hashrate graph on a miner's own manage page). Two measures:
 *
 *   reported   what the miner says it hashes (poller, telemetry push, simulator)
 *   submitted  the hashrate proven by the shares that reached YOUR node:
 *              sum(share difficulty) × 2^32 / seconds
 *
 * Reported readings are averaged into time buckets per range:
 *   live → 10-second buckets over 5 minutes (30 points)
 *   1h   → 30-second buckets (120 points)
 *   24h  → 10-minute buckets (144 points)
 * Submitted is summed from 10-second share buckets over a sliding window
 * (1 min live, 5 min for 1h, 10 min for 24h) so it doesn't jump with every share.
 * A bucket without a reported reading (miner off or unreachable) stays empty,
 * so the chart shows a gap instead of a made-up value. Kept in memory.
 */
export type HashrateRange = 'live' | '1h' | '24h';

export const RANGES: Record<HashrateRange, { bucketMs: number; spanMs: number; windowMs: number }> = {
  live: { bucketMs: 10_000, spanMs: 300_000, windowMs: 60_000 },
  '1h': { bucketMs: 30_000, spanMs: 3_600_000, windowMs: 300_000 },
  '24h': { bucketMs: 600_000, spanMs: 86_400_000, windowMs: 600_000 },
};

const SHARE_BUCKET = 10_000;
const KEEP_MS = RANGES['24h'].spanMs + RANGES['24h'].windowMs;

/** [bucket start ms, reported TH/s | null, submitted TH/s | null] */
export type HashratePoint = [number, number | null, number | null];

export interface HashrateSeries {
  range: HashrateRange;
  bucketMs: number;
  /** sliding window the submitted hashrate is measured over */
  windowMs: number;
  /** oldest first */
  points: HashratePoint[];
}

type Buckets = Map<number, { sum: number; n: number }>;
interface MinerData {
  reported: Record<HashrateRange, Buckets>;
  /** share-bucket start → difficulty credited to your node */
  work: Map<number, number>;
}

export class HashrateHistory {
  private data = new Map<string, MinerData>();

  /** a hashrate reading from the miner itself */
  record(id: string, ths: number, t = Date.now()): void {
    if (!Number.isFinite(ths) || ths < 0) return;
    const d = this.get(id);
    for (const r of Object.keys(RANGES) as HashrateRange[]) {
      const { bucketMs, spanMs } = RANGES[r];
      const b = d.reported[r];
      const k = Math.floor(t / bucketMs) * bucketMs;
      const cur = b.get(k) ?? { sum: 0, n: 0 };
      cur.sum += ths;
      cur.n++;
      b.set(k, cur);
      if (b.size > spanMs / bucketMs + 4) for (const key of b.keys()) if (key < t - spanMs - bucketMs) b.delete(key);
    }
  }

  /** work that reached your node: the share's credited difficulty */
  recordShare(id: string, difficulty: number, t = Date.now()): void {
    if (!Number.isFinite(difficulty) || difficulty <= 0) return;
    const w = this.get(id).work;
    const k = Math.floor(t / SHARE_BUCKET) * SHARE_BUCKET;
    w.set(k, (w.get(k) ?? 0) + difficulty);
    if (w.size > KEEP_MS / SHARE_BUCKET + 10) for (const key of w.keys()) if (key < t - KEEP_MS) w.delete(key);
  }

  series(id: string, range: HashrateRange, now = Date.now()): HashrateSeries {
    const { bucketMs, spanMs, windowMs } = RANGES[range];
    const d = this.data.get(id);
    const last = Math.floor(now / bucketMs) * bucketMs;
    const points: HashratePoint[] = [];
    for (let k = last - spanMs + bucketMs; k <= last; k += bucketMs) {
      const v = d?.reported[range].get(k);
      const reported = v ? +(v.sum / v.n).toFixed(3) : null;
      points.push([k, reported, reported === null ? null : this.submitted(d, Math.min(k + bucketMs, now), windowMs)]);
    }
    return { range, bucketMs, windowMs, points };
  }

  /** fill the past with values (demo miners open with a day of history) */
  backfill(id: string, valueAt: (t: number) => { reported: number; submitted: number } | null, now = Date.now()): void {
    const step = 5_000;
    for (let t = now - KEEP_MS; t < now; t += step) {
      const v = valueAt(t);
      if (!v) continue;
      this.record(id, v.reported, t);
      if (v.submitted > 0) this.recordShare(id, (v.submitted * 1e12 * (step / 1000)) / 2 ** 32, t);
    }
  }

  forget(id: string): void {
    this.data.delete(id);
  }

  /** TH/s proven by shares in (end - window, end] */
  private submitted(d: MinerData | undefined, end: number, windowMs: number): number {
    if (!d) return 0;
    let work = 0;
    const from = Math.floor((end - windowMs) / SHARE_BUCKET) * SHARE_BUCKET;
    for (let k = from; k < end; k += SHARE_BUCKET) work += d.work.get(k) ?? 0;
    const secs = (end - from) / 1000;
    return +((work * 2 ** 32) / secs / 1e12).toFixed(3);
  }

  private get(id: string): MinerData {
    let d = this.data.get(id);
    if (!d) this.data.set(id, (d = { reported: { live: new Map(), '1h': new Map(), '24h': new Map() }, work: new Map() }));
    return d;
  }
}
