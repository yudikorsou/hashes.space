import type { MinerAction, MinerSettings, PoolStrategy, SettingsGroupId } from './settings-schema';
export type { MinerAction, MinerSettings, PoolStrategy, SettingsGroupId } from './settings-schema';

// Shared, normalised data model. Every chain source (mempool.guide,
// Bitcoin Core, Bitcoin Knots, simulator) is mapped onto these shapes so the
// frontend never needs to know where the data came from.

/** Proof-of-work hash function, e.g. "sha256", "scrypt", "blake2b" (any id from networks.json, or another one). */
export type HashAlgo = string;

/** Which blockchain stream a page shows: a network id from networks.json, or 'own' (the account's own node). */
export type NetworkId = string;

export interface NetworkInfo {
  id: NetworkId;
  algo: HashAlgo;
  label: string; // "SHA-256"
  chain: string; // "Bitcoin"
  ticker: string; // "BTC"
  source: string; // "mempool.guide", "Your node (Bitcoin Knots)"
  /** block page link prefix, if the stream has a public explorer */
  explorerBlockUrl?: string;
}

/** "Connect your own node and Electrum server" – per account. */
export interface OwnNodeConfig {
  algo: HashAlgo;
  /** Bitcoin Core / Bitcoin Knots JSON-RPC, e.g. http://192.168.1.20:8332 */
  rpcUrl?: string;
  rpcUser?: string;
  rpcPassword?: string;
  /** Electrum server (Electrs, Fulcrum, ElectrumX) */
  electrumHost?: string;
  electrumPort?: number;
  electrumTls?: boolean;
}

export interface ChainBlock {
  height: number;
  hash: string;
  timestamp: number; // unix seconds
  txCount: number;
  size: number; // bytes
  weight: number; // WU
  medianFee: number; // sat/vB
  feeRange: number[]; // [min, ..., max] sat/vB
  totalFees: number; // sats
  pool?: string;
  /** true when the source can't tell size, tx count or fees (Electrum-only) */
  partial?: boolean;
}

export interface ProjectedBlock {
  index: number; // 0 = the block currently being mined
  nTx: number; // 0 when unknown (Electrum fee histogram)
  vsize: number;
  medianFee: number;
  feeRange: number[];
  totalFees: number;
}

export interface ChainState {
  source: string; // human readable, e.g. "mempool.guide" or "Bitcoin Knots @ 10.0.0.5"
  network: string;
  tipHeight: number;
  blocks: ChainBlock[]; // newest first
  projected: ProjectedBlock[]; // next block first
  updatedAt: number;
}

/**
 * The three modes a miner can be in. The backend decides the mode
 * (MinerRegistry.evaluate) every time the miner reports in; the page only shows it.
 *
 *   hashing         green   "Connected and hashing"             hashing for the right blockchain, your node accepts its shares
 *   not-submitting  orange  "Hashing, not submitting shares"    hashrate > 0, but no shares reach your node
 *                                                               (wrong pool, wrong port, rejected shares…)
 *   not-hashing     red     "Not hashing, go to miner settings" unreachable, 0 hashrate or no pool; fan stopped
 */
export type MinerStatus = 'hashing' | 'not-submitting' | 'not-hashing';

/** One pool slot as on a Bitmain / Goldshell "Miner configuration" page. */
export interface PoolConfig {
  url: string; // e.g. stratum+tcp://datum.local:23334
  user: string; // worker name, often <address>.<worker>
  pass: string; // usually "x"
}

export interface Miner {
  id: string;
  tenantId: string;
  name: string;
  model: string;
  /** the miner's IP address on its network; unique per account – this is how the page connects to it */
  host?: string;
  port?: number; // cgminer API port, usually 4028
  status: MinerStatus;
  /** one-line explanation of the status, e.g. "No response from 192.168.1.103" */
  statusReason: string;
  poolUrl?: string; // pool the rig reports it is mining on right now
  /** configured pools: [0] = main pool, [1] = failover pool */
  pools?: PoolConfig[];
  /** hash function the ASIC computes – its shares only land on a chain with the same one */
  algo?: HashAlgo;
  /** still uses the default login (admin / 123456789): the page asks the owner to change it */
  defaultLogin?: boolean;
  /**
   * The blockchain network the dashboard has this miner on (the network dropdown).
   * A miner on a network of another hash function can't hash there: not-hashing.
   */
  network?: { id: NetworkId; algo: HashAlgo; label: string; chain: string };
  /** always 'failover': the miner switches to the failover pool only if the main pool goes down */
  poolStrategy?: PoolStrategy;
  /** every other setting on the Miner settings page (see settings-schema.ts) */
  settings?: MinerSettings;
  /** which settings groups and actions this miner's driver can change remotely */
  capabilities?: Partial<Record<SettingsGroupId | MinerAction | 'pools', boolean>>;
  /** name of the driver that talks to it, e.g. "cgminer API" */
  driver?: string;
  firmwareVersion?: string;
  /** name of the firmware plugin to use (backend/firmware/*.js); empty = the first plugin whose match() says yes */
  firmware?: string;
  /** LED blinking ("Find this miner") until this time, ms */
  locateUntil?: number;
  /** rebooting until this time, ms */
  rebootUntil?: number;
  /** turned off under Maintenance: the hashboards and fans are off, the control board still answers */
  poweredOff?: boolean;
  hashrateThs: number;
  nominalThs: number;
  temperatureC?: number;
  fanRpm?: number;
  sharesAccepted: number;
  sharesRejected: number;
  bestShareDiff: number;
  lastShareAt?: number; // ms
  lastSeenAt?: number; // ms
}

export interface ShareEvent {
  minerId: string;
  tenantId: string;
  difficulty: number;
  /** 64-char hex share hash when the firmware reports it, else synthesised */
  hash: string;
  accepted: boolean;
  ts: number;
}

export interface Tenant {
  id: string;
  name: string; // manufacturer brand name
  apiKey: string; // used by firmware/agents to push telemetry & by dashboards to log in
  accentColor: string;
  logoUrl?: string;
  /** your BLAKE2b node's stratum address, offered as "Use my node" on the settings page */
  stratumUrl?: string;
  /**
   * your node's stratum address per hash function, e.g.
   * { "blake2b": "stratum+tcp://datum.local:23335" }.
   * A miner only counts as "Connected and hashing" when it points at the node for ITS hash function.
   * A node that takes shares on several ports (e.g. one DATUM gateway per miner) gets a list:
   * { "blake2b": ["stratum+tcp://192.168.1.10:23340", "stratum+tcp://192.168.1.10:23339"] }.
   * The first address is the one "Use my node" fills in.
   */
  nodes?: Partial<Record<HashAlgo, string | string[]>>;
  /** substrings a miner's pool URL must contain to count as "connected to your node" */
  expectedPoolHosts: string[];
}

// ---- WebSocket protocol ----
// A page watches ONE miner at a time. It sends {type:'watch', host} to connect
// (a new watch replaces the previous one) and {type:'unwatch'} to disconnect.
// It also picks which blockchain stream to show with {type:'network', id}.
export type ClientMessage = { type: 'watch'; host: string; /** login session for this miner */ session?: string } | { type: 'unwatch' } | { type: 'watch-fleet' } | { type: 'unwatch-fleet' } | { type: 'network'; id: NetworkId };

export type ServerMessage =
  | { type: 'hello'; tenant: Omit<Tenant, 'apiKey'>; networks: NetworkInfo[] }
  | { type: 'networks'; networks: NetworkInfo[] } // list changed (own node connected / removed)
  | { type: 'network'; id: NetworkId } // the stream this page now shows
  | { type: 'chain'; networkId: NetworkId; chain: ChainState }
  | { type: 'watching'; miner: Miner | null } // the connected miner (null = disconnected)
  | { type: 'watch-error'; host: string; message: string }
  | { type: 'login-required'; host: string; minerId: string; defaultLogin: boolean; username: string } // log in to this miner first
  | { type: 'miner'; miner: Miner } // update of the connected miner
  | { type: 'shares'; shares: ShareEvent[] } // shares of the connected miner
  | { type: 'fleet-miners'; miners: Miner[] } // fleet dashboard: updates of fleet miners
  | { type: 'fleet-shares'; shares: ShareEvent[] } // fleet dashboard: shares of fleet miners
  | { type: 'block-found'; networkId: NetworkId; block: ChainBlock };
