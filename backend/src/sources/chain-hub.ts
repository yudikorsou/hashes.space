import { EventEmitter } from 'events';
import { config } from '../config';
import { ChainSource } from './chain-source';
import { MempoolSource } from './mempool-source';
import { NodeSource } from './node-source';
import { SimulatedSource } from './simulated-source';
import { XmrchainSource } from './xmrchain-source';
import { ElectrumSource } from './electrum-source';
import { OwnSource } from './own-source';
import { ChainBlock, ChainState, NetworkId, NetworkInfo, OwnNodeConfig } from '../types';
import { algoLabel, allAlgos, chainName, DEFAULT_ALGO, NETWORKS } from '../networks';

export class OwnNodeError extends Error {}

interface Own {
  cfg: OwnNodeConfig;
  info: NetworkInfo;
  source: OwnSource;
}

/**
 * The blockchain streams: one per network in networks.json (any proof-of-work hash function),
 * plus per account "own": the account's own node and/or Electrum server.
 *
 * Emits 'state' (key, ChainState) and 'block' (key, ChainBlock), where key is
 * a network id or 'own:<tenantId>'.
 */
export class ChainHub extends EventEmitter {
  private sources = new Map<string, ChainSource>();
  private own = new Map<string, Own>();
  readonly publicNetworks: NetworkInfo[];

  constructor() {
    super();
    const allSim = config.chainSource === 'simulated';
    this.publicNetworks = NETWORKS.map((n) => {
      const kind = allSim ? 'simulated' : n.source;
      const src: ChainSource =
        kind === 'node'
          ? new NodeSource({ ...config.node, ...(n.rpcUrl && { rpcUrl: n.rpcUrl, rpcUser: n.rpcUser, rpcPassword: n.rpcPassword, cookieFile: n.cookieFile }) }, n.sourceLabel ?? `${n.chain} node`)
          : kind === 'xmrchain'
            ? new XmrchainSource(n.apiUrl!, n.sourceLabel ?? new URL(n.apiUrl!).host)
          : kind === 'simulated'
            ? new SimulatedSource(`Simulated ${n.chain} chain`, undefined, Math.max(20_000, (n.blockSeconds ?? 600) * 125))
            : new MempoolSource(n.wsUrl!, n.sourceLabel ?? new URL(n.wsUrl!).host, n.datumPools);
      this.add(n.id, src);
      return { id: n.id, algo: n.algo, label: n.label, chain: n.chain, ticker: n.ticker, source: src.getState().source, explorerBlockUrl: kind === 'mempool' || kind === 'xmrchain' ? n.explorer : undefined };
    });
  }

  /** the network a page starts on */
  get defaultNetwork(): NetworkId {
    return this.publicNetworks[0].id;
  }

  start(): void {
    for (const s of this.sources.values()) s.start();
  }

  stop(): void {
    for (const s of this.sources.values()) s.stop();
  }

  /** Networks a page of this account can choose from. */
  networks(tenantId: string): NetworkInfo[] {
    const own = this.own.get(tenantId);
    return own ? [...this.publicNetworks, own.info] : this.publicNetworks;
  }

  /** key of the source behind a network for this account (undefined = not available) */
  key(tenantId: string, id: NetworkId): string | undefined {
    if (id === 'own') return this.own.has(tenantId) ? `own:${tenantId}` : undefined;
    return this.sources.has(id) ? id : undefined;
  }

  state(key: string): ChainState | undefined {
    return this.sources.get(key)?.getState();
  }

  ownConfig(tenantId: string): Omit<OwnNodeConfig, 'rpcPassword'> | undefined {
    const o = this.own.get(tenantId);
    if (!o) return undefined;
    const { rpcPassword: _hidden, ...rest } = o.cfg;
    return rest;
  }

  /**
   * "Connect your own node and Electrum server": test what was entered, then
   * start streaming from it. Throws OwnNodeError with a readable message.
   */
  async connectOwn(tenantId: string, raw: OwnNodeConfig): Promise<{ info: NetworkInfo; message: string }> {
    if (!config.allowOwnNode) throw new OwnNodeError('Connecting your own node is turned off on this server.');
    const cfg = clean(raw);
    if (!cfg.rpcUrl && !cfg.electrumHost) throw new OwnNodeError('Enter your node’s RPC address, an Electrum server, or both.');

    const found: string[] = [];
    let nodeName = '';
    if (cfg.rpcUrl) {
      try {
        const r = await NodeSource.test(cfg as { rpcUrl: string });
        nodeName = r.replace(/ \(.*$/, '');
        found.push(`Node: ${r}.`);
      } catch (e) {
        throw new OwnNodeError(`Could not reach your node at ${cfg.rpcUrl} (${reason(e)}). Check the address, RPC user and password, and that rpcallowip lets this server in.`);
      }
    }
    if (cfg.electrumHost) {
      try {
        found.push(`Electrum: ${await ElectrumSource.test({ host: cfg.electrumHost, port: cfg.electrumPort!, tls: !!cfg.electrumTls, algo: cfg.algo })}.`);
      } catch (e) {
        throw new OwnNodeError(`Could not reach the Electrum server at ${cfg.electrumHost}:${cfg.electrumPort} (${reason(e)}). Check the address, port and SSL setting.`);
      }
    }

    this.disconnectOwn(tenantId);
    const label = `Your node${nodeName ? ` (${nodeName})` : ' (Electrum)'}`;
    const source = new OwnSource(cfg, label, config.node.pollMs);
    const info: NetworkInfo = {
      id: 'own',
      algo: cfg.algo,
      label: algoLabel(cfg.algo),
      chain: chainName(cfg.algo),
      ticker: NETWORKS.find((n) => n.algo === cfg.algo)?.ticker ?? cfg.algo.toUpperCase(),
      source: label,
    };
    this.own.set(tenantId, { cfg, info, source });
    this.add(`own:${tenantId}`, source);
    source.start();
    this.emit('networks', tenantId);
    return { info, message: found.join(' ') };
  }

  disconnectOwn(tenantId: string): boolean {
    const o = this.own.get(tenantId);
    if (!o) return false;
    o.source.stop();
    o.source.removeAllListeners();
    this.own.delete(tenantId);
    this.sources.delete(`own:${tenantId}`);
    this.emit('networks', tenantId);
    return true;
  }

  private add(key: string, s: ChainSource): void {
    this.sources.set(key, s);
    s.on('state', (st: ChainState) => this.emit('state', key, st));
    s.on('block', (b: ChainBlock) => this.emit('block', key, b));
  }
}

function clean(c: OwnNodeConfig): OwnNodeConfig {
  // the hash function of the chain your node validates (any one the dashboard knows)
  const algo = allAlgos().some((a) => a.algo === c.algo) ? c.algo : DEFAULT_ALGO;
  let rpcUrl = (c.rpcUrl ?? '').trim();
  if (rpcUrl && !/^https?:\/\//i.test(rpcUrl)) rpcUrl = `http://${rpcUrl}`;
  if (rpcUrl) {
    try {
      new URL(rpcUrl);
    } catch {
      throw new OwnNodeError(`"${c.rpcUrl}" is not a node address. Use the form http://192.168.1.20:8332`);
    }
  }
  const electrumHost = (c.electrumHost ?? '').trim().replace(/^(tcp|ssl|tls):\/\//i, '').replace(/:\d+$/, '');
  const electrumPort = Number(c.electrumPort) || (electrumHost ? (c.electrumTls ? 50002 : 50001) : undefined);
  if (electrumPort !== undefined && (electrumPort < 1 || electrumPort > 65535)) throw new OwnNodeError('The Electrum port must be between 1 and 65535.');
  return {
    algo,
    rpcUrl: rpcUrl || undefined,
    rpcUser: c.rpcUser?.trim() || undefined,
    rpcPassword: c.rpcPassword || undefined,
    electrumHost: electrumHost || undefined,
    electrumPort,
    electrumTls: !!c.electrumTls,
  };
}

function reason(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } };
  const code = err.cause?.code ?? (err as { code?: string }).code;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'address not found';
  if (err.name === 'TimeoutError' || /timed out|no answer/i.test(err.message)) return 'no answer';
  return err.message;
}
