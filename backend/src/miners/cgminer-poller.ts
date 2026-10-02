import net from 'net';
import { MinerRegistry } from './registry';
import { Miner } from '../types';

/** What one poll of a miner returns. Firmware plugins (backend/firmware/*.js) return the same shape from read(). */
export interface MinerReading {
  hashrateThs: number;
  /** total shares the pool accepted since the miner started (the dashboard animates the increase) */
  sharesAccepted?: number;
  sharesRejected?: number;
  /** the pool's current share difficulty */
  shareDifficulty?: number;
  poolUrl?: string;
  pools?: { url: string; user: string }[];
  temperatureC?: number;
  fanRpm?: number;
  model?: string;
  firmwareVersion?: string;
}
export type MinerReader = (m: Miner) => Promise<MinerReading>;

/**
 * Polls the cgminer-compatible API (TCP 4028) exposed by most ASIC firmwares:
 * Bitmain bmminer/cgminer, Braiins OS (BOSminer), Vnish, LuxOS, Canaan, …
 * Whatsminer uses a different, token-based API – add a driver next to this one.
 *
 * For every accepted-share increase we emit share events, so the dashboard
 * streams bits even without firmware changes.
 */
export class CgminerPoller {
  private timer?: NodeJS.Timeout;
  private lastAccepted = new Map<string, number>();

  /** skip = miners that are not real hardware (e.g. the simulator's) */
  /** readerFor: a firmware plugin's own read() for this miner, if it has one; otherwise the cgminer API is used */
  constructor(
    private registry: MinerRegistry,
    private pollMs: number,
    private skip: (id: string) => boolean = () => false,
    private readerFor: (m: Miner) => MinerReader | undefined = () => undefined,
  ) {}

  /** Poll one miner right away, e.g. the moment a page connects to it. */
  pollNow(id: string): void {
    const m = this.registry.get(id);
    if (m?.host && !this.skip(id)) this.pollOne(m.id, m.host, m.port ?? 4028).catch(() => undefined);
  }

  start(): void {
    this.timer = setInterval(() => this.pollAll(), this.pollMs);
    this.pollAll();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private pollAll(): void {
    for (const t of this.registry.allTenants()) {
      for (const m of this.registry.list(t.id)) {
        if (m.host && !this.skip(m.id)) this.pollOne(m.id, m.host, m.port ?? 4028).catch(() => undefined);
      }
    }
  }

  private async pollOne(id: string, host: string, port: number): Promise<void> {
    const miner = this.registry.get(id);
    if (!miner) return;
    const reader = this.readerFor(miner);
    const r = reader ? await reader(miner) : await readCgminer(host, port);
    this.apply(miner, r);
  }

  /** store one reading and turn new accepted shares into share events */
  private apply(miner: Miner, r: MinerReading): void {
    const id = miner.id;
    const now = Date.now();
    const accepted = Number(r.sharesAccepted ?? 0);
    const prevAccepted = this.lastAccepted.get(id);
    this.lastAccepted.set(id, accepted);

    this.registry.upsert({
      id,
      tenantId: miner.tenantId,
      lastSeenAt: now,
      // fill in the model unless the owner named it (a firmware name is only a placeholder)
      model: r.model && (miner.model === 'ASIC miner' || / firmware$/.test(miner.model ?? '')) ? r.model : undefined,
      firmwareVersion: r.firmwareVersion,
      // show the pools that are on the rig until the owner saves their own
      pools: miner.pools || !r.pools ? undefined : r.pools.slice(0, 2).map((p) => ({ url: p.url, user: p.user, pass: 'x' })),
      poolUrl: r.poolUrl,
      hashrateThs: r.hashrateThs,
      sharesRejected: r.sharesRejected,
      fanRpm: r.fanRpm,
      temperatureC: r.temperatureC,
    });

    // Turn the accepted-counter delta into individual share events (capped).
    if (prevAccepted !== undefined && accepted > prevAccepted) {
      const n = Math.min(accepted - prevAccepted, 25);
      const diff = Number(r.shareDifficulty ?? 1);
      for (let i = 0; i < n; i++) {
        // spread them over the poll window so the animation looks continuous
        // the first event credits all the work since the last poll, so capping the animation doesn't lose hashrate
        const credit = i === 0 ? diff * (accepted - prevAccepted) : 0;
        setTimeout(() => this.registry.recordShare(id, diff, { credit }), (i / n) * this.pollMs);
      }
    }
  }
}

/** One reading through the cgminer-compatible API (TCP 4028). */
export async function readCgminer(host: string, port: number): Promise<MinerReading> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary: any = await cgminerCommand(host, port, 'summary');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pools: any = await cgminerCommand(host, port, 'pools');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats: any = await cgminerCommand(host, port, 'stats').catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const devs: any = await cgminerCommand(host, port, 'devs').catch(() => null);

    const s = summary?.SUMMARY?.[0] ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const active = (pools?.POOLS ?? []).find((p: any) => p['Stratum Active']) ?? pools?.POOLS?.[0];
    const { fanRpm, temperatureC } = extractFanTemp(stats, devs);
    return {
      hashrateThs: liveMhs(s) / 1e6,
      sharesAccepted: Number(s['Accepted'] ?? 0),
      sharesRejected: Number(s['Rejected'] ?? 0),
      shareDifficulty: Number(active?.['Last Share Difficulty'] ?? active?.['Diff'] ?? 1),
      poolUrl: active?.URL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pools: (pools?.POOLS ?? []).map((p: any) => ({ url: String(p.URL ?? ''), user: String(p.User ?? '') })),
      fanRpm,
      temperatureC,
      // Bitmain & co. report a Type; intminer (Goldshell) firmware only its own name
      model: stats?.STATS?.[0]?.Type ?? stats?.STATS?.[1]?.Type ?? firmwareName(stats),
      firmwareVersion: stats?.STATS?.[0]?.Miner ? String(stats.STATS[0].Miner).replace(/-unknown$/, '') : undefined,
    };
}

/**
 * Send one API request. `command` is a plain command name ("summary"), or with
 * raw=true a complete JSON request such as {"command":"addpool","parameter":"…"}.
 */
export function cgminerCommand(host: string, port: number, command: string, timeoutMs = 3000, raw = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = '';
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error('timeout'));
    });
    sock.on('connect', () => sock.write(raw ? command : JSON.stringify({ command })));
    sock.on('data', (d) => (buf += d.toString()));
    sock.on('error', reject);
    sock.on('end', () => {
      try {
        // cgminer terminates with \0 and some firmwares emit invalid "}{" joins
        resolve(JSON.parse(buf.replace(/\0/g, '').replace(/}{/g, '},{')));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** the live hashrate in MH/s: 5 s or 20 s window first (intminer has no "MHS 5s" in its summary), then the average */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function liveMhs(s: any): number {
  return Number(s['MHS 5s'] ?? s['MHS 20s'] ?? s['MHS av'] ?? (s['GHS 5s'] ? Number(s['GHS 5s']) * 1000 : 0)) || 0;
}

/** "intminer 5.4.2-unknown" → "intminer 5.4.2 firmware", for miners that don't report a model */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firmwareName(stats: any): string | undefined {
  const m = String(stats?.STATS?.[0]?.Miner ?? '').replace(/-unknown$/, '').trim();
  return m ? `${m} firmware` : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractFanTemp(stats: any, devs?: any): { fanRpm?: number; temperatureC?: number } {
  const blocks: Record<string, unknown>[] = [...(stats?.STATS ?? []), ...(devs?.DEVS ?? [])];
  const fans: number[] = [];
  const temps: number[] = [];
  for (const b of blocks) {
    for (const [k, v] of Object.entries(b)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (/^fan\d+$/i.test(k)) fans.push(n);
      if (/^temp(2_)?\d+$/i.test(k) || /^temp_chip/i.test(k) || /^tstemp-\d+$/i.test(k)) temps.push(n); // tstemp-N: intminer (Goldshell)
    }
  }
  return {
    fanRpm: fans.length ? Math.round(fans.reduce((a, b) => a + b, 0) / fans.length) : undefined,
    temperatureC: temps.length ? Math.max(...temps) : undefined,
  };
}
