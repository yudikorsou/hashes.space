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
  /** the API port it answered on (4028 for cgminer, the HTTP port for XMRig) */
  port?: number;
  /** 'cpu' for CPU miners (XMRig) */
  kind?: 'asic' | 'cpu';
  cpu?: { brand: string; cores: number; threads: number; miningThreads: number };
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
export async function scanLocalNetwork(opts: { port?: number; xmrigPorts?: number[]; connectTimeoutMs?: number; concurrency?: number; extraSubnets?: string[] } = {}): Promise<ScanResult> {
  const started = Date.now();
  const port = opts.port ?? 4028;
  const subnets = [...new Set([...localSubnets(), ...(opts.extraSubnets ?? [])])];
  const targets = subnets.flatMap((s) => Array.from({ length: 254 }, (_, i) => `${s}.${i + 1}`));

  const open: string[] = [];
  const openHttp: [string, number][] = [];
  const xmrigPorts = opts.xmrigPorts ?? [];
  await pool(targets, opts.concurrency ?? 96, async (ip) => {
    if (await portOpen(ip, port, opts.connectTimeoutMs ?? 350)) open.push(ip);
    for (const p of xmrigPorts) if (await portOpen(ip, p, opts.connectTimeoutMs ?? 350)) openHttp.push([ip, p]);
  });

  const miners: FoundMiner[] = [];
  await pool(open, 16, async (ip) => {
    const m = await identify(ip, port);
    if (m) miners.push(m);
  });
  // CPU miners: XMRig's HTTP API (GET /2/summary)
  await pool(openHttp, 16, async ([ip, p]) => {
    if (miners.some((m) => m.ip === ip)) return;
    const m = await identifyXmrig(ip, p);
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

/** XMRig answers GET /2/summary on its HTTP port with its version, algorithm and CPU */
export async function identifyXmrig(ip: string, port: number): Promise<FoundMiner | null> {
  try {
    let token = process.env.XMRIG_ACCESS_TOKEN || '';
    try {
      token = JSON.parse(process.env.XMRIG_TOKENS || '{}')[ip] || token;
    } catch {
      /* ignore a broken XMRIG_TOKENS */
    }
    const res = await fetch(`http://${ip}:${port}/2/summary`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s: any = await res.json();
    if (!/xmrig/i.test(String(s?.ua ?? '')) && !(s?.hashrate && s?.cpu)) return null;
    const hs = Number(s.hashrate?.total?.[0] ?? s.hashrate?.total?.[1] ?? 0) || 0;
    const threads = Array.isArray(s.hashrate?.threads) ? s.hashrate.threads.length : 0;
    const algo = String(s.algo ?? '').startsWith('rx/') ? 'randomx' : undefined;
    return {
      ip,
      port,
      kind: 'cpu',
      model: String(s.cpu?.brand ?? 'CPU miner').replace(/\s+/g, ' ').trim(),
      hashrateThs: s.paused ? 0 : hs / 1e12,
      poolUrl: s.connection?.pool ? `stratum+tcp://${s.connection.pool}` : undefined,
      firmware: `XMRig ${s.version ?? ''}`.trim(),
      algo,
      cpu: { brand: String(s.cpu?.brand ?? 'CPU').replace(/\s+/g, ' ').trim(), cores: Number(s.cpu?.cores) || threads || 1, threads: Number(s.cpu?.threads) || threads || 1, miningThreads: s.paused ? 0 : threads },
    };
  } catch {
    return null;
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
