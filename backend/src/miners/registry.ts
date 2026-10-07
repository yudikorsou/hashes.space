import crypto from 'crypto';
import { HashrateHistory } from './hashrate-history';
import { MinerAuth } from './auth';
import { MAX_FLEET_ADD, parseIpList } from './ip-list';
import { EventEmitter } from 'events';
import { config } from '../config';
import { algoLabel, chainName, DEFAULT_ALGO } from '../networks';
import { HashAlgo, Miner, NetworkId, MinerSettings, MinerStatus, PoolConfig, PoolStrategy, SettingsGroupId, ShareEvent, Tenant } from '../types';
import { checkGroup, defaultSettings, findGroup } from '../settings-schema';

export type MinerInput = Partial<Miner> & Pick<Miner, 'id' | 'tenantId'>;

/** IPv4 address or a plain host name (miner.local). */
const HOST_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$|^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export class RegistryError extends Error {}

export interface FleetView {
  name: string;
  miners: Miner[];
  summary: { total: number; hashing: number; notSubmitting: number; notHashing: number; hashrateThs: Partial<Record<HashAlgo, number>> };
}

/** is this miner ready to join the fleet? login → set up → ready */
export interface FleetCheck {
  ip: string;
  ready: boolean;
  /** login: not logged in to it yet (Manage) · setup: logged in, but not connected and hashing yet · ready */
  step: 'login' | 'setup' | 'ready';
  model?: string;
  status?: MinerStatus;
  reason: string;
}

export class FleetNotReadyError extends Error {
  constructor(readonly checks: FleetCheck[]) {
    const open = checks.filter((c) => !c.ready).length;
    super(`${open} ${open === 1 ? 'miner is' : 'miners are'} not set up yet. Manage each one on Find ASIC: log in and make it Connected and hashing, then Generate.`);
  }
}

export interface FleetAddResult {
  added: string[];
  /** already in the fleet */
  already: string[];
  invalid: { entry: string; reason: string }[];
  duplicates: string[];
  fleet: FleetView;
}

/**
 * In-memory miner registry (swap for Postgres/Redis in production).
 *
 * Every miner is identified by its IP address, which must be unique within an
 * account: two miners can never share an IP. Each time a miner reports in, its
 * mode (hashing / not-submitting / not-hashing) is decided here in evaluate().
 *
 * Emits:
 *   'miner' (Miner)       – a miner's state changed
 *   'share' (ShareEvent)  – a share reached your node
 *   'config' (Miner)      – the owner saved new pool settings
 *   'connect' (Miner)     – a page connected to a miner (poll it right away)
 */
export class MinerRegistry extends EventEmitter {
  private miners = new Map<string, Miner>();
  /** each account's fleet: a name and its miners (by id), in the order they were added */
  private fleets = new Map<string, { name: string; ids: string[] }>();
  /** accepted / rejected verdicts of each miner's latest shares */
  private verdicts = new Map<string, { ts: number; accepted: boolean }[]>();
  /** hashrate over time, for the Hashrate health chart */
  readonly history = new HashrateHistory();
  /** each miner's login (username + password) and sessions */
  readonly auth = new MinerAuth();
  private tenants = new Map<string, Tenant>();
  private sweep?: NodeJS.Timeout;

  constructor(tenants: Tenant[]) {
    super();
    tenants.forEach((t) => this.tenants.set(t.id, t));
    this.sweep = setInterval(() => this.reevaluateAll(), 5000);
  }

  stop(): void {
    clearInterval(this.sweep);
  }

  tenant(id: string): Tenant | undefined {
    return this.tenants.get(id);
  }

  tenantByKey(apiKey: string): Tenant | undefined {
    return [...this.tenants.values()].find((t) => t.apiKey === apiKey);
  }

  allTenants(): Tenant[] {
    return [...this.tenants.values()];
  }

  list(tenantId: string): Miner[] {
    return [...this.miners.values()].filter((m) => m.tenantId === tenantId).sort((a, b) => (a.host ?? a.id).localeCompare(b.host ?? b.id, undefined, { numeric: true }));
  }

  get(id: string): Miner | undefined {
    return this.miners.get(id);
  }

  byHost(tenantId: string, host: string): Miner | undefined {
    const h = host.trim().toLowerCase();
    return [...this.miners.values()].find((m) => m.tenantId === tenantId && m.host?.toLowerCase() === h);
  }

  /**
   * Connect a page to the miner at this IP. Known miners are returned as-is;
   * a new IP is registered so the poller starts reading it straight away.
   */
  connect(tenantId: string, rawHost: string): Miner {
    const host = normaliseHost(rawHost);
    const existing = this.byHost(tenantId, host);
    const miner = existing ?? this.upsert({ id: `${tenantId}:${host}`, tenantId, host, port: 4028, name: host, model: 'ASIC miner', algo: DEFAULT_ALGO });
    this.emit('connect', miner);
    return miner;
  }

  /** The account's fleet with each miner's live state and a count per mode. */
  fleet(tenantId: string): FleetView {
    const f = this.fleets.get(tenantId) ?? { name: 'My fleet', ids: [] };
    const miners = f.ids.map((id) => this.miners.get(id)).filter((m): m is Miner => !!m);
    const count = (s: MinerStatus) => miners.filter((m) => m.status === s).length;
    return {
      name: f.name,
      miners,
      summary: {
        total: miners.length,
        hashing: count('hashing'),
        notSubmitting: count('not-submitting'),
        notHashing: count('not-hashing'),
        // the work that counts: miners that are connected and hashing, per hash function
        hashrateThs: miners
          .filter((m) => m.status === 'hashing')
          .reduce<Partial<Record<HashAlgo, number>>>((acc, m) => {
            const a = m.algo ?? DEFAULT_ALGO;
            acc[a] = Number(((acc[a] ?? 0) + (m.hashrateThs || 0)).toPrecision(4));
            return acc;
          }, {}),
      },
    };
  }

  /** ids of the miners in this account's fleet */
  fleetIds(tenantId: string): Set<string> {
    return new Set(this.fleets.get(tenantId)?.ids ?? []);
  }

  /**
   * Add miners to the fleet from a pasted list of IP addresses (commas, spaces,
   * new lines, ranges like 192.168.1.110-120). Each new IP is registered and read
   * straight away, like connecting to it. Returns what was added and why the rest wasn't.
   */
  /**
   * A fleet only takes miners that were set up through Find ASIC → Manage:
   * logged in to (a valid session for that IP) and Connected and hashing, i.e.
   * submitting shares to your node on the right port and blockchain.
   */
  fleetReadiness(tenantId: string, ips: string[], sessions: Record<string, string> = {}): FleetCheck[] {
    return ips.map((ip) => {
      const m = this.byHost(tenantId, ip);
      if (!m || !this.auth.check(sessions[ip], m.id)) {
        return { ip, ready: false, step: 'login', model: m?.model, status: m?.status, reason: 'Log in first: click Manage for this miner on Find ASIC.' };
      }
      if (m.status !== 'hashing') return { ip, ready: false, step: 'setup', model: m.model, status: m.status, reason: m.statusReason };
      return { ip, ready: true, step: 'ready', model: m.model, status: m.status, reason: m.statusReason };
    });
  }

  addToFleet(tenantId: string, text: string, name?: string, sessions: Record<string, string> = {}): FleetAddResult {
    const parsed = parseIpList(text);
    if (parsed.ips.length > MAX_FLEET_ADD) throw new RegistryError(`That is ${parsed.ips.length} addresses. Add at most ${MAX_FLEET_ADD} at a time.`);
    // Generate only when every miner is logged in to and connected and hashing
    const checks = this.fleetReadiness(tenantId, parsed.ips, sessions);
    if (checks.some((c) => !c.ready)) throw new FleetNotReadyError(checks);
    const f = this.fleets.get(tenantId) ?? { name: 'My fleet', ids: [] };
    if (name?.trim()) f.name = name.trim().slice(0, 60);
    const added: string[] = [];
    const already: string[] = [];
    for (const ip of parsed.ips) {
      const m = this.byHost(tenantId, ip)!;
      if (f.ids.includes(m.id)) already.push(ip);
      else {
        f.ids.push(m.id);
        added.push(ip);
      }
    }
    this.fleets.set(tenantId, f);
    return { added, already, invalid: parsed.invalid, duplicates: parsed.duplicates, fleet: this.fleet(tenantId) };
  }

  removeFromFleet(tenantId: string, host: string): FleetView {
    const f = this.fleets.get(tenantId);
    const m = this.byHost(tenantId, host);
    if (f && m) f.ids = f.ids.filter((id) => id !== m.id);
    return this.fleet(tenantId);
  }

  renameFleet(tenantId: string, name: string): FleetView {
    const f = this.fleets.get(tenantId) ?? { name: 'My fleet', ids: [] };
    f.name = name.trim().slice(0, 60) || 'My fleet';
    this.fleets.set(tenantId, f);
    return this.fleet(tenantId);
  }

  upsert(input: MinerInput): Miner {
    const prev = this.miners.get(input.id);
    if (input.host !== undefined) {
      input.host = normaliseHost(input.host);
      const clash = this.byHost(input.tenantId, input.host);
      if (clash && clash.id !== input.id) throw new RegistryError(`${input.host} already belongs to ${clash.name}. Every miner needs its own IP address.`);
    }
    const miner: Miner = {
      name: input.id,
      model: 'ASIC miner',
      status: 'not-hashing',
      statusReason: '',
      hashrateThs: 0,
      nominalThs: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      bestShareDiff: 0,
      poolStrategy: 'failover',
      ...prev,
      ...stripUndefined(input),
    } as Miner;
    miner.settings ??= defaultSettings();
    miner.defaultLogin = this.auth.isDefault(miner.id);
    Object.assign(miner, this.evaluate(miner));
    this.miners.set(miner.id, miner);
    // a miner that can't hash here (e.g. on the other blockchain network) does no useful work: record 0
    if (input.hashrateThs !== undefined) this.history.record(miner.id, miner.status === 'not-hashing' ? 0 : miner.hashrateThs);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(miner)) this.emit('miner', miner);
    return miner;
  }

  /** Save the settings from the Miner settings page. */
  configure(id: string, cfg: { name?: string; port?: number; nominalThs?: number; algo?: HashAlgo; poolStrategy?: PoolStrategy; pools: PoolConfig[] }): Miner | undefined {
    const m = this.miners.get(id);
    if (!m) return undefined;
    const pools = cfg.pools
      .slice(0, 2) // a main pool and one failover pool
      .map((p) => ({ url: (p.url ?? '').trim(), user: (p.user ?? '').trim(), pass: (p.pass ?? '').trim() || 'x' }))
      .filter((p) => p.url);
    const updated = this.upsert({ id, tenantId: m.tenantId, name: cfg.name?.trim() || m.name, port: cfg.port, nominalThs: cfg.nominalThs, algo: cfg.algo, poolStrategy: 'failover', pools });
    this.emit('config', updated);
    return updated;
  }

  /**
   * Save one settings group (performance, cooling, network, security, system)
   * after checking it with the shared schema. Throws RegistryError listing
   * what is wrong.
   */
  saveSettings(id: string, groupId: SettingsGroupId, raw: Record<string, unknown>): Miner {
    const m = this.miners.get(id);
    const group = findGroup(groupId);
    if (!m || !group) throw new RegistryError('Unknown miner or settings group.');
    const current = (m.settings ?? defaultSettings())[groupId] as unknown as Record<string, unknown>;
    // only keys the schema knows; missing ones keep their current value
    const merged: Record<string, unknown> = { ...current };
    for (const f of group.fields) if (f.key in raw) merged[f.key] = raw[f.key];
    const r = checkGroup(group, merged);
    if (!r.ok) {
      const first = Object.entries(r.fieldErrors)[0];
      const label = first && group.fields.find((f) => f.key === first[0])?.label;
      throw new RegistryError(first ? `${label}: ${first[1]}` : r.groupError!);
    }
    const settings = { ...(m.settings ?? defaultSettings()), [groupId]: r.values } as MinerSettings;
    return this.upsert({ id, tenantId: m.tenantId, settings });
  }

  /** Back to factory settings: no pools, default settings. */
  factoryReset(id: string, keepSession?: string): Miner | undefined {
    const m = this.miners.get(id);
    if (!m) return undefined;
    this.auth.reset(id, keepSession); // the login goes back to admin / 123456789 too
    this.emit('sessions', id);
    return this.upsert({ id, tenantId: m.tenantId, pools: [], poolUrl: '', poolStrategy: 'failover', settings: defaultSettings(), poweredOff: false });
  }

  /** true when a pool URL points at this account's own node */
  isOwnNode(tenantId: string, url?: string): boolean {
    const t = this.tenants.get(tenantId);
    if (!t || !url || !t.expectedPoolHosts.length) return false;
    return t.expectedPoolHosts.some((h) => url.toLowerCase().includes(h.toLowerCase()));
  }

  /**
   * The page switched the blockchain network this miner is on (a network from networks.json, or your own node).
   * The mode is re-evaluated straight away: a miner on the wrong network turns red.
   */
  setNetwork(id: string, net: { id: NetworkId; algo: HashAlgo; label: string; chain: string }): Miner | undefined {
    const m = this.miners.get(id);
    if (!m) return undefined;
    if (m.network?.id === net.id && m.network.algo === net.algo) return m;
    return this.upsert({ id, tenantId: m.tenantId, network: { id: net.id, algo: net.algo, label: net.label, chain: net.chain } });
  }

  /** Your node's stratum address per hash function (tenant.nodes, or stratumUrl for the default hash function). */
  nodes(tenantId: string): Partial<Record<HashAlgo, string>> {
    const out: Partial<Record<HashAlgo, string>> = {};
    for (const [algo, url] of this.nodeAddresses(tenantId)) out[algo] ??= url; // the first address per hash function
    return out;
  }

  /** Every stratum address of your nodes, also when a node takes shares on several ports. */
  nodeAddresses(tenantId: string): [HashAlgo, string][] {
    const t = this.tenants.get(tenantId);
    if (!t) return [];
    const nodes = t.nodes ?? (t.stratumUrl ? { [DEFAULT_ALGO]: t.stratumUrl } : {});
    return (Object.entries(nodes) as [HashAlgo, string | string[]][]).flatMap(([algo, u]) => (Array.isArray(u) ? u : [u]).filter(Boolean).map((x) => [algo, x] as [HashAlgo, string]));
  }

  /**
   * Which of your nodes a pool URL points at:
   *   node        one of your nodes (algo = the hash function that node mines; undefined if none configured)
   *   wrong-port  your node's host, but a port none of your nodes listens on
   *   other       someone else's pool
   */
  nodeFor(tenantId: string, url?: string): { kind: 'node'; algo?: HashAlgo } | { kind: 'wrong-port'; port: string } | { kind: 'other' } {
    const t = this.tenants.get(tenantId);
    if (!t || !url) return { kind: 'other' };
    const p = parseStratum(url);
    const nodes = this.nodeAddresses(tenantId);
    const ownHost = (h: string) => t.expectedPoolHosts.some((x) => h.includes(x.toLowerCase())) || nodes.some(([, u]) => parseStratum(u).host === h);
    if (!ownHost(p.host)) return { kind: 'other' };
    if (!nodes.length) return { kind: 'node' };
    const hit = nodes.find(([, u]) => {
      const q = parseStratum(u);
      return q.port === p.port && (q.host === p.host || ownHost(q.host));
    });
    return hit ? { kind: 'node', algo: hit[0] } : { kind: 'wrong-port', port: p.port || 'none' };
  }

  /** Record one submitted share (from firmware push, pool log, poller or simulator). */
  recordShare(minerId: string, difficulty: number, opts: { hash?: string; accepted?: boolean; ts?: number; credit?: number } = {}): void {
    const m = this.miners.get(minerId);
    if (!m) return;
    // Only shares for the blockchain network the miner is on, sent to your node for its own hash function,
    // can land in *your* block.
    if (m.network && m.network.algo !== (m.algo ?? DEFAULT_ALGO)) return;
    if (m.poolUrl) {
      const n = this.nodeFor(m.tenantId, m.poolUrl);
      if (n.kind !== 'node' || (n.algo && n.algo !== (m.algo ?? DEFAULT_ALGO))) return;
    }
    const accepted = opts.accepted ?? true;
    const ts = opts.ts ?? Date.now();
    // the last shares' verdicts: a node that rejects most of them means the work is not being used
    const log = this.verdicts.get(minerId) ?? [];
    log.push({ ts, accepted });
    if (log.length > 30) log.shift();
    this.verdicts.set(minerId, log);
    // submitted hashrate: credit the pool's share difficulty (a lucky high share still counts once)
    if (accepted) this.history.recordShare(minerId, opts.credit ?? difficulty, ts);
    const share: ShareEvent = {
      minerId,
      tenantId: m.tenantId,
      difficulty,
      hash: opts.hash ?? synthesiseShareHash(difficulty),
      accepted,
      ts,
    };
    this.upsert({
      id: minerId,
      tenantId: m.tenantId,
      lastSeenAt: ts,
      lastShareAt: accepted ? ts : m.lastShareAt,
      sharesAccepted: m.sharesAccepted + (accepted ? 1 : 0),
      sharesRejected: m.sharesRejected + (accepted ? 0 : 1),
      bestShareDiff: Math.max(m.bestShareDiff, difficulty),
    });
    this.emit('share', share);
  }

  private reevaluateAll(): void {
    for (const m of this.miners.values()) {
      const next = this.evaluate(m);
      if (next.status !== m.status || next.statusReason !== m.statusReason) {
        Object.assign(m, next);
        if (next.status === 'not-hashing') m.hashrateThs = 0;
        this.emit('miner', m);
      }
    }
  }

  /**
   * The three modes. "Connected and hashing" (green) only when ALL of these hold:
   *   - the miner answers and does work (hashrate > 0, or shares prove it)
   *   - its pool is your node, on the node's port
   *   - that node mines the blockchain of the miner's hash function
   *     (a node for another hash function would get useless work)
   *   - your node accepted a share from it recently, and accepts most of them
   * Checked in this order:
   *  1. not-hashing     no answer, rebooting, turned off, on the wrong blockchain network, sleeping, or 0 hashrate
   *  2. not-submitting  another pool · wrong port · node for the other blockchain ·
   *                     node rejects most shares · no accepted share recently
   *  3. hashing         everything above is fine
   */
  evaluate(m: Miner, now = Date.now()): { status: MinerStatus; statusReason: string } {
    const where = m.host ? ` from ${m.host}` : '';
    if (m.rebootUntil && now < m.rebootUntil) return { status: 'not-hashing', statusReason: 'The miner is rebooting. It starts hashing again in about a minute.' };
    if (m.poweredOff) return { status: 'not-hashing', statusReason: 'The miner is turned off. Turn it on under Miner settings → Maintenance.' };
    if (!m.lastSeenAt || now - m.lastSeenAt > config.miners.offlineAfterMs) {
      return { status: 'not-hashing', statusReason: `No response${where}. Check that the miner is on and connected.` };
    }
    const minerAlgo = m.algo ?? DEFAULT_ALGO;
    if (m.network && m.network.algo !== minerAlgo) {
      return {
        status: 'not-hashing',
        statusReason: `A ${ALGO_LABEL[minerAlgo]} miner can't hash on the ${m.network.label} network (${m.network.chain}). Switch the network to ${ALGO_LABEL[minerAlgo]}, or connect a ${ALGO_LABEL[m.network.algo]} miner.`,
      };
    }
    if (m.settings?.performance.mode === 'sleep' && !m.hashrateThs) {
      return { status: 'not-hashing', statusReason: 'The miner is in sleep mode. Change the work mode under Performance to start it.' };
    }
    const recentShare = !!m.lastShareAt && now - m.lastShareAt < config.miners.idleAfterMs;
    if ((!m.hashrateThs || m.hashrateThs <= 0) && !recentShare) {
      const hasPool = !!(m.poolUrl || m.pools?.length);
      return { status: 'not-hashing', statusReason: hasPool ? 'The miner is on but reports 0 hashrate.' : 'No pool is set up on this miner.' };
    }

    const algo = m.algo ?? DEFAULT_ALGO;
    const nodes = this.nodes(m.tenantId);
    const own = nodes[algo];
    const useOwn = own ? ` Use your ${ALGO_LABEL[algo]} node: ${stripScheme(own)}.` : ` Set up a ${ALGO_LABEL[algo]} node first.`;
    if (m.poolUrl) {
      const n = this.nodeFor(m.tenantId, m.poolUrl);
      if (n.kind === 'other') return { status: 'not-submitting', statusReason: `Mining for another pool (${stripScheme(m.poolUrl)}), not your node.` };
      if (n.kind === 'wrong-port') return { status: 'not-submitting', statusReason: `Your node doesn't take shares on port ${n.port}.${useOwn}` };
      if (n.algo && n.algo !== algo) {
        return {
          status: 'not-submitting',
          statusReason: `This miner computes ${ALGO_LABEL[algo]}, but ${stripScheme(m.poolUrl)} is your ${chainName(n.algo)} node, so its shares are useless there.${useOwn}`,
        };
      }
    }
    const recent = (this.verdicts.get(m.id) ?? []).filter((v) => now - v.ts < config.miners.idleAfterMs * 5);
    const rejected = recent.filter((v) => !v.accepted).length;
    if (recent.length >= 10 && rejected > recent.length / 2) {
      return { status: 'not-submitting', statusReason: `Your node rejects most of its shares (${rejected} of the last ${recent.length}). Check the worker name and the pool password.` };
    }
    if (recentShare) return { status: 'hashing', statusReason: `Hashing ${ALGO_LABEL[algo]} for ${chainName(algo)}, and your node accepts its shares.` };
    const since = m.lastShareAt ? `for ${Math.round((now - m.lastShareAt) / 60_000)} min` : 'yet';
    return { status: 'not-submitting', statusReason: `No share has reached your node ${since}. Check the pool address, port and worker name.` };
  }
}

const ALGO_LABEL = new Proxy({} as Record<string, string>, { get: (_t, a: string) => algoLabel(a) });

/** host and port of a stratum URL: "stratum+tcp://Datum.local:23334" → { host: "datum.local", port: "23334" } */
export function parseStratum(url: string): { host: string; port: string } {
  const m = /^(?:[a-z0-9+.-]+:\/\/)?(?:[^@/]*@)?([^/:]+)(?::(\d+))?/i.exec(url.trim());
  return { host: (m?.[1] ?? '').toLowerCase(), port: m?.[2] ?? '' };
}

export function normaliseHost(raw: string): string {
  const host = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/:].*$/, '')
    .toLowerCase();
  if (!host || !HOST_RE.test(host)) throw new RegistryError(`"${raw}" is not an IP address. Use the form 192.168.1.101.`);
  return host;
}

function stripScheme(url: string): string {
  return url.replace(/^stratum\+(tcp|ssl|tls):\/\//i, '');
}

/**
 * A share at difficulty D has a hash below target1 / D, i.e. roughly
 * 32 + log2(D) leading zero bits. When firmware doesn't report the actual
 * hash we build a plausible one so the dashboard can render its bits.
 */
export function synthesiseShareHash(difficulty: number): string {
  const zeroBits = Math.min(255, 32 + Math.max(0, Math.floor(Math.log2(Math.max(1, difficulty)))));
  const bytes = crypto.randomBytes(32);
  for (let bit = 0; bit < zeroBits; bit++) bytes[bit >> 3] &= ~(0x80 >> (bit & 7));
  bytes[zeroBits >> 3] |= 0x80 >> (zeroBits & 7); // first 1-bit right after the zeros
  return bytes.toString('hex');
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
