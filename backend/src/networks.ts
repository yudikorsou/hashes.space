import fs from 'fs';
import path from 'path';

/**
 * The proof-of-work networks this dashboard can show, from networks.json (NETWORKS_FILE).
 *
 * hashes.space works with any proof-of-work hash function: SHA-256, Scrypt, BLAKE2b,
 * kHeavyHash, Equihash, RandomX, … Each network says which hash function (algo) it is
 * validated with, which blockchain it is and where its blocks come from:
 *   mempool    a mempool.space-style WebSocket (mempool.space, litecoinspace.org, mempool.guide, your own mempool)
 *   node       a node's JSON-RPC (Bitcoin Core / Knots style: getblocktemplate, getblock)
 *   xmrchain   a Monero onion-blockchain-explorer API (xmrchain.net or your own), fed by a synced monerod
 *   simulated  made-up blocks, for classrooms without internet or chains without an explorer
 * A miner only counts as "Connected and hashing" on a network of its own hash function.
 */
export interface NetworkConfig {
  /** unique id, e.g. "sha256" or "litecoin" ("own" is reserved for "Your node") */
  id: string;
  /** the hash function, e.g. "sha256", "scrypt", "blake2b", "kheavyhash" */
  algo: string;
  /** how the hash function is written: "SHA-256" */
  label: string;
  chain: string;
  ticker: string;
  source: 'mempool' | 'node' | 'xmrchain' | 'simulated';
  /** mempool: the WebSocket, e.g. wss://mempool.space/api/v1/ws */
  wsUrl?: string;
  /** xmrchain: an onion-monero-blockchain-explorer API, e.g. https://xmrchain.net/api */
  apiUrl?: string;
  /** shown as the data source, e.g. "mempool.space" */
  sourceLabel?: string;
  /**
   * DATUM Verified: blocks from these pools get a glow and a "DATUM Verified" notice (pools whose
   * miners build their own block templates with DATUM Gateway), e.g. ["OCEAN"] on Bitcoin SHA-256,
   * ["CONVOY"] on Bitcoin BLAKE2b. Solo blocks from a DATUM Gateway (its tag in the coinbase) always count.
   */
  datumPools?: string[];
  /** block page link prefix, e.g. https://mempool.space/block/ */
  explorer?: string;
  /** node: JSON-RPC address and login (default: the BITCOIN_RPC_* settings) */
  rpcUrl?: string;
  rpcUser?: string;
  rpcPassword?: string;
  cookieFile?: string;
  /** average time between blocks, for the simulated chain (default 600) */
  blockSeconds?: number;
}

const BUILT_IN: NetworkConfig[] = [
  { id: 'blake2b', algo: 'blake2b', label: 'BLAKE2b', chain: 'Bitcoin BLAKE2b', ticker: 'BTCB2', source: 'mempool', wsUrl: 'wss://mempool.guide/api/v1/ws', sourceLabel: 'mempool.guide', explorer: 'https://mempool.guide/block/', datumPools: ['CONVOY'] },
];

/** labels for hash functions without a network in networks.json (a miner can still be set to them) */
const KNOWN_ALGOS: Record<string, string> = {
  blake2b: 'BLAKE2b',
  kheavyhash: 'kHeavyHash',
  equihash: 'Equihash',
  randomx: 'RandomX',
  x11: 'X11',
  eaglesong: 'Eaglesong',
  kadena: 'Blake2s (Kadena)',
  etchash: 'Etchash',
};

function load(): NetworkConfig[] {
  const file = process.env.NETWORKS_FILE ?? path.join(__dirname, '..', 'networks.json');
  let list: NetworkConfig[];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fs.existsSync(file)) console.warn(`[networks] could not read ${file}: ${(e as Error).message}. Using Bitcoin BLAKE2b only.`);
    return BUILT_IN;
  }
  const seen = new Set<string>();
  const ok = (Array.isArray(list) ? list : []).filter((n) => {
    const problem =
      !n || typeof n !== 'object' ? 'not an object'
      : !/^[a-z0-9-]{1,32}$/.test(n.id ?? '') || n.id === 'own' ? 'id must be 1–32 lowercase letters, digits or "-" (not "own")'
      : seen.has(n.id) ? 'id used twice'
      : !/^[a-z0-9-]{1,32}$/.test(n.algo ?? '') ? 'algo must be 1–32 lowercase letters, digits or "-"'
      : !['mempool', 'node', 'xmrchain', 'simulated'].includes(n.source) ? 'source must be mempool, node, xmrchain or simulated'
      : n.source === 'mempool' && !/^wss?:\/\//.test(n.wsUrl ?? '') ? 'a mempool source needs a wsUrl (wss://…/api/v1/ws)'
      : n.source === 'xmrchain' && !/^https?:\/\//.test(n.apiUrl ?? '') ? 'an xmrchain source needs an apiUrl (https://xmrchain.net/api)'
      : null;
    if (problem) console.warn(`[networks] skipped ${n?.id ?? '?'}: ${problem}`);
    else seen.add(n.id);
    return !problem;
  });
  return ok.length ? ok.map((n) => ({ ...n, label: n.label || KNOWN_ALGOS[n.algo] || n.algo, chain: n.chain || n.id, ticker: n.ticker || n.id.toUpperCase() })) : BUILT_IN;
}

export const NETWORKS: NetworkConfig[] = load();

/** the hash function of miners that don't say (DEFAULT_ALGO, else the first network's) */
export const DEFAULT_ALGO: string = process.env.DEFAULT_ALGO || NETWORKS[0].algo;

/** "SHA-256" for "sha256" */
export function algoLabel(algo: string): string {
  return NETWORKS.find((n) => n.algo === algo)?.label ?? KNOWN_ALGOS[algo] ?? algo.toUpperCase();
}

/** "Bitcoin" for "sha256" (the first network of that hash function) */
export function chainName(algo: string): string {
  return NETWORKS.find((n) => n.algo === algo)?.chain ?? `${algoLabel(algo)} blockchain`;
}

/** every hash function the dashboard knows: the networks' first, then the other common ones */
export function allAlgos(): { algo: string; label: string }[] {
  const ids = [...new Set([...NETWORKS.map((n) => n.algo), ...Object.keys(KNOWN_ALGOS)])];
  return ids.map((algo) => ({ algo, label: algoLabel(algo) }));
}
