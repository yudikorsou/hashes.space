import fs from 'fs';
import path from 'path';
import { Tenant } from './types';

export type ChainSourceKind = 'mempool' | 'node' | 'simulated';

const env = (k: string, d?: string) => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8080')),

  /**
   * The networks and their sources are listed in networks.json (NETWORKS_FILE).
   * CHAIN_SOURCE=simulated makes every network simulated (offline classrooms, development);
   * the default uses each network's own source.
   */
  chainSource: env('CHAIN_SOURCE', 'networks') as ChainSourceKind | 'networks',

  /** allow "Connect your own node and Electrum server" (the server then connects to addresses users type in) */
  allowOwnNode: env('ALLOW_OWN_NODE', 'true') === 'true',

  // the server's own node (Bitcoin Core / Knots-style JSON-RPC), for networks with "source": "node" and no rpcUrl of their own
  node: {
    rpcUrl: env('BITCOIN_RPC_URL', 'http://127.0.0.1:8332')!,
    rpcUser: env('BITCOIN_RPC_USER', ''),
    rpcPassword: env('BITCOIN_RPC_PASSWORD', ''),
    cookieFile: env('BITCOIN_RPC_COOKIE', ''), // e.g. ~/.bitcoin/.cookie
    label: env('NODE_LABEL', 'Bitcoin node')!,
    pollMs: Number(env('NODE_POLL_MS', '5000')),
  },

  miners: {
    /** poll cgminer/bmminer/BOSminer API (TCP 4028) every n ms */
    pollMs: Number(env('MINER_POLL_MS', '5000')),
    /** no share within this window => idle */
    idleAfterMs: Number(env('MINER_IDLE_MS', '120000')),
    /** no contact within this window => offline */
    offlineAfterMs: Number(env('MINER_OFFLINE_MS', '60000')),
    /** spawn simulated miners for tenants that have none (demo mode) */
    simulate: env('SIMULATE_MINERS', 'true') === 'true',
  },

  /**
   * Find ASIC: find the miners that are powered on in the local network.
   * Only works when this backend runs on a computer in the miners' network.
   */
  scan: {
    enabled: env('ALLOW_SCAN', 'true') === 'true',
    /** the miner API port that is probed (cgminer-compatible) */
    port: Number(env('SCAN_PORT', '4028')),
    /** extra /24 networks to scan besides this computer's own, e.g. "192.168.2,10.0.5" */
    extraSubnets: (env('SCAN_SUBNETS', '') ?? '').split(',').map((x) => x.trim().replace(/^(\d+\.\d+\.\d+)\.\d+(\/24)?$/, '$1')).filter((x) => /^\d+\.\d+\.\d+$/.test(x)),
    /** HTTP ports where XMRig's API may answer (CPU miners), e.g. "18088,8080"; empty = don't look */
    xmrigPorts: (env('SCAN_XMRIG_PORTS', '18088') ?? '').split(',').map((x) => Number(x.trim())).filter((x) => x > 0 && x < 65536),
    /** reuse a scan for this long unless ?refresh=1 */
    cacheMs: Number(env('SCAN_CACHE_MS', '15000')),
  },

  tenantsFile: env('TENANTS_FILE', path.join(__dirname, '..', 'tenants.json'))!,
  minersFile: env('MINERS_FILE', path.join(__dirname, '..', 'miners.json'))!,
  /** firmware plugins: one .js file per firmware (see backend/firmware/README.md) */
  firmwareDir: env('FIRMWARE_DIR', path.join(__dirname, '..', 'firmware'))!,
  frontendDist: env('FRONTEND_DIST', path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser'))!,
};

export function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function loadTenants(): Tenant[] {
  return loadJson<Tenant[]>(config.tenantsFile, [
    {
      id: 'demo',
      name: 'hashes.space',
      apiKey: 'demo-key',
      accentColor: '#f7931a',
      nodes: { sha256: 'stratum+tcp://datum.local:23334', scrypt: 'stratum+tcp://datum.local:23336', blake2b: 'stratum+tcp://datum.local:23335', randomx: 'stratum+tcp://p2pool.local:3333' },
      expectedPoolHosts: ['127.0.0.1', 'localhost', 'datum'],
    },
  ]);
}
