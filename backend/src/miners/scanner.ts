import net from 'net';
import os from 'os';
import { cgminerCommand, liveMhs } from './cgminer-poller';
import { HashAlgo, MinerStatus } from '../types';

/** One miner that answered on the local network. */
export interface FoundMiner {
  ip: string;
  model: string;
  hashrateThs: number;
  poolUrl?: string;
  firmware?: string;
  algo?: HashAlgo;
  /** true when it's already known to this account */
  known?: boolean;
  /** true for the built-in demo miners */
  simulated?: boolean;
  /** the miner's mode, once the dashboard reads it (shown on its Connected button after you log in) */
  status?: MinerStatus;
  statusReason?: string;
}

export interface ScanResult {
  subnets: string[];
  miners: FoundMiner[];
  scannedAt: number;
  durationMs: number;
}

/**
 * Find ASIC: find every ASIC that is powered on in the local network, like
 * Bitmain's IP Reporter or Goldshell's find tool.
 *
 * Browsers can't scan a local network, so this runs in the backend, which must
 * run on a computer in the same network as the miners. For each private /24
 * subnet of this computer it tries TCP 4028 (the cgminer-compatible API most
 * firmwares expose) on every address, then asks the ones that answer who they are.
 */
export async function scanLocalNetwork(opts: { port?: number; connectTimeoutMs?: number; concurrency?: number; extraSubnets?: string[] } = {}): Promise<ScanResult> {
  const started = Date.now();
  const port = opts.port ?? 4028;
  const subnets = [...new Set([...localSubnets(), ...(opts.extraSubnets ?? [])])];
  const targets = subnets.flatMap((s) => Array.from({ length: 254 }, (_, i) => `${s}.${i + 1}`));

  const open: string[] = [];
  await pool(targets, opts.concurrency ?? 96, async (ip) => {
    if (await portOpen(ip, port, opts.connectTimeoutMs ?? 350)) open.push(ip);
  });

  const miners: FoundMiner[] = [];
  await pool(open, 16, async (ip) => {
    const m = await identify(ip, port);
    if (m) miners.push(m);
  });

  miners.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return { subnets: subnets.map((s) => `${s}.0/24`), miners, scannedAt: Date.now(), durationMs: Date.now() - started };
}

/** "192.168.1" for every private IPv4 interface of this computer. */
export function localSubnets(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue; // private ranges only
      out.push(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...new Set(out)];
}

async function identify(ip: string, port: number): Promise<FoundMiner | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary: any = await cgminerCommand(ip, port, 'summary', 2000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [version, stats, pools]: any[] = await Promise.all([
      cgminerCommand(ip, port, 'version', 2000).catch(() => null),
      cgminerCommand(ip, port, 'stats', 2000).catch(() => null),
      cgminerCommand(ip, port, 'pools', 2000).catch(() => null),
    ]);
    const s = summary?.SUMMARY?.[0] ?? {};
    const v = version?.VERSION?.[0] ?? {};
    const mhs = liveMhs(s);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const active = (pools?.POOLS ?? []).find((p: any) => p['Stratum Active']) ?? pools?.POOLS?.[0];
    const model = v.Type ?? stats?.STATS?.[0]?.Type ?? stats?.STATS?.[1]?.Type ?? (v.Miner ? `${String(v.Miner).replace(/-unknown$/, '')} firmware` : 'ASIC miner');
    return {
      ip,
      model: String(model),
      hashrateThs: Number(mhs) / 1e6 || 0,
      poolUrl: active?.URL,
      firmware: v.CompileTime ?? v.BMMiner ?? v.CGMiner ?? v.LUXminer ?? v.BOSminer,
    };
  } catch {
    return null; // port open, but not a miner API
  }
}

function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
