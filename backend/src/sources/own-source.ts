import { ChainSource } from './chain-source';
import { NodeSource } from './node-source';
import { ElectrumSource } from './electrum-source';
import { ChainState, OwnNodeConfig } from '../types';

/**
 * "Your node": Bitcoin Core / Knots RPC and/or an Electrum server, merged.
 *
 *   mined blocks     node RPC (full detail) – else Electrum headers
 *   block being mined  node's getblocktemplate – the template YOUR miners get
 *   later blocks     Electrum fee histogram – else estimated by the node
 */
export class OwnSource extends ChainSource {
  private node?: NodeSource;
  private electrum?: ElectrumSource;

  constructor(cfg: OwnNodeConfig, label: string, pollMs = 5000) {
    super(label);
    if (cfg.rpcUrl) this.node = new NodeSource({ rpcUrl: cfg.rpcUrl, rpcUser: cfg.rpcUser, rpcPassword: cfg.rpcPassword, pollMs }, label);
    if (cfg.electrumHost && cfg.electrumPort) {
      this.electrum = new ElectrumSource({ host: cfg.electrumHost, port: cfg.electrumPort, tls: !!cfg.electrumTls, algo: cfg.algo }, label);
    }
    this.node?.on('state', () => this.merge());
    this.electrum?.on('state', () => this.merge());
    // a new block from either side
    const seen = new Set<string>();
    const onBlock = (b: { hash: string; height: number }) => {
      const key = String(b.height);
      if (seen.has(key)) return;
      seen.add(key);
      this.emit('block', b);
    };
    this.node?.on('block', onBlock);
    this.electrum?.on('block', onBlock);
  }

  start(): void {
    this.node?.start();
    this.electrum?.start();
  }

  stop(): void {
    this.node?.stop();
    this.electrum?.stop();
  }

  private merge(): void {
    const n: ChainState | undefined = this.node?.getState();
    const e: ChainState | undefined = this.electrum?.getState();
    const blocks = n?.blocks.length ? n.blocks : (e?.blocks ?? []);
    const projected = n?.projected.length
      ? [n.projected[0], ...(e?.projected.length ? e.projected.slice(1) : n.projected.slice(1))].map((b, index) => ({ ...b, index }))
      : (e?.projected ?? []);
    this.publish({
      blocks,
      projected,
      tipHeight: Math.max(n?.tipHeight ?? 0, e?.tipHeight ?? 0),
      network: n?.network ?? this.state.network,
    });
  }
}
