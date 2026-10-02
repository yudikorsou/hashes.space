import http from 'http';
import { URL } from 'url';
import WebSocket, { WebSocketServer } from 'ws';
import { ChainHub } from './sources/chain-hub';
import { MinerRegistry, RegistryError } from './miners/registry';
import { ChainBlock, ChainState, ClientMessage, Miner, NetworkId, ServerMessage, ShareEvent, Tenant } from './types';

interface Client {
  ws: WebSocket;
  tenant: Tenant;
  alive: boolean;
  /** the ONE miner this page is connected to (undefined = none) */
  minerId?: string;
  /** the login session this page opened that miner with */
  session?: string;
  /** this page shows the fleet dashboard: it gets every fleet miner's updates and shares */
  fleet?: boolean;
  /** the blockchain stream this page shows */
  network: NetworkId;
}

/**
 * WebSocket endpoint /ws?token=<account api key>[&miner=<ip>].
 *
 * Every page is connected to at most one miner at a time:
 *   client -> {type:'watch', host:'192.168.1.101'}   connect (replaces the previous miner)
 *   client -> {type:'unwatch'}                       disconnect
 *   client -> {type:'watch-fleet'} / {type:'unwatch-fleet'}   fleet dashboard: all fleet miners' updates and shares
 *
 *   client -> {type:'network', id:'<network id>'|'own'}   pick the blockchain stream (networks.json)
 *
 * Each page gets the chain of the network it picked, and only the updates and
 * shares of its own miner (shares batched every 150 ms).
 * Optional query: &network=<network id>
 */
export class PushServer {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private shareQueue = new Map<string, ShareEvent[]>(); // minerId -> shares
  private minerQueue = new Map<string, Miner>(); // minerId -> latest state
  private flushTimer: NodeJS.Timeout;
  private heartbeat: NodeJS.Timeout;

  constructor(server: http.Server, private hub: ChainHub, private registry: MinerRegistry) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '', 'http://x');
      const tenant = registry.tenantByKey(url.searchParams.get('token') ?? '');
      if (!tenant) {
        ws.close(4401, 'invalid token');
        return;
      }
      const wanted = url.searchParams.get('network') as NetworkId | null;
      const client: Client = { ws, tenant, alive: true, network: wanted && hub.key(tenant.id, wanted) ? wanted : hub.defaultNetwork };
      this.clients.add(client);
      ws.on('pong', () => (client.alive = true));
      ws.on('close', () => this.clients.delete(client));
      ws.on('message', (raw) => {
        try {
          this.onMessage(client, JSON.parse(raw.toString()) as ClientMessage);
        } catch {
          /* ignore malformed messages */
        }
      });

      const { apiKey: _omit, ...publicTenant } = tenant;
      this.send(client, { type: 'hello', tenant: publicTenant, networks: hub.networks(tenant.id) });
      this.sendChain(client);
      const host = url.searchParams.get('miner');
      if (host) this.watch(client, host);
      else this.send(client, { type: 'watching', miner: null });
    });

    hub.on('state', (key: string, state: ChainState) => {
      for (const c of this.clients) if (hub.key(c.tenant.id, c.network) === key) this.send(c, { type: 'chain', networkId: c.network, chain: state });
    });
    hub.on('block', (key: string, block: ChainBlock) => {
      for (const c of this.clients) if (hub.key(c.tenant.id, c.network) === key) this.send(c, { type: 'block-found', networkId: c.network, block });
    });
    // own node connected or removed: refresh the list, move pages off a stream that's gone
    hub.on('networks', (tenantId: string) => {
      for (const c of this.clients) {
        if (c.tenant.id !== tenantId) continue;
        this.send(c, { type: 'networks', networks: hub.networks(tenantId) });
        if (!hub.key(tenantId, c.network)) {
          c.network = this.hub.defaultNetwork;
          this.sendChain(c);
          this.applyNetwork(c);
        }
      }
    });

    registry.on('miner', (m: Miner) => this.minerQueue.set(m.id, m));
    // login changed or reset: pages whose session is no longer valid must log in again
    registry.on('sessions', (minerId: string) => {
      for (const c of this.clients) {
        if (c.minerId !== minerId || registry.auth.check(c.session, minerId)) continue;
        const m = registry.get(minerId);
        c.minerId = undefined;
        this.send(c, { type: 'login-required', host: m?.host ?? '', minerId, ...this.loginHint(minerId) });
      }
    });
    registry.on('share', (s: ShareEvent) => {
      if (!this.shareQueue.has(s.minerId)) this.shareQueue.set(s.minerId, []);
      this.shareQueue.get(s.minerId)!.push(s);
    });

    this.flushTimer = setInterval(() => this.flush(), 150);
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          this.clients.delete(c);
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, 30_000);
  }

  close(): void {
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeat);
    this.wss.close();
  }

  private onMessage(c: Client, msg: ClientMessage): void {
    if (msg.type === 'watch' && typeof msg.host === 'string') this.watch(c, msg.host, typeof msg.session === 'string' ? msg.session : undefined);
    if (msg.type === 'network') {
      if (!this.hub.key(c.tenant.id, msg.id)) return;
      c.network = msg.id;
      this.sendChain(c);
      this.applyNetwork(c); // the connected miner is now on this blockchain network
    }
    if (msg.type === 'watch-fleet') c.fleet = true;
    if (msg.type === 'unwatch-fleet') c.fleet = false;
    if (msg.type === 'unwatch') {
      c.minerId = undefined;
      this.send(c, { type: 'watching', miner: null });
    }
  }

  private watch(c: Client, host: string, session?: string): void {
    try {
      const miner = this.registry.connect(c.tenant.id, host);
      // only with this miner's login: nobody else opens it and changes its pools or settings
      if (!this.registry.auth.check(session, miner.id)) {
        c.minerId = undefined;
        c.session = undefined;
        this.send(c, { type: 'login-required', host: miner.host ?? host, minerId: miner.id, ...this.loginHint(miner.id) });
        return;
      }
      c.minerId = miner.id; // replaces any miner this page was connected to before
      c.session = session;
      this.applyNetwork(c);
      this.send(c, { type: 'watching', miner: this.registry.get(miner.id) ?? miner });
    } catch (e) {
      const message = e instanceof RegistryError ? e.message : 'Could not connect to that miner.';
      this.send(c, { type: 'watch-error', host, message });
    }
  }

  /** tell the registry which blockchain network this page's miner is on, so its mode follows the dropdown */
  private applyNetwork(c: Client): void {
    if (!c.minerId) return;
    const info = this.hub.networks(c.tenant.id).find((n) => n.id === c.network);
    if (info) this.registry.setNetwork(c.minerId, info);
  }

  /** the default login is shown in the login form; a changed username is never given away */
  private loginHint(minerId: string): { defaultLogin: boolean; username: string } {
    const isDefault = this.registry.auth.isDefault(minerId);
    return { defaultLogin: isDefault, username: isDefault ? this.registry.auth.username(minerId) : '' };
  }

  private sendChain(c: Client): void {
    const key = this.hub.key(c.tenant.id, c.network);
    const state = key ? this.hub.state(key) : undefined;
    this.send(c, { type: 'network', id: c.network });
    if (state) this.send(c, { type: 'chain', networkId: c.network, chain: state });
  }

  private flush(): void {
    // fleet dashboards: every fleet miner's changes and shares (capped per batch, the page thins them out further)
    const fleetIdsByTenant = new Map<string, Set<string>>();
    for (const c of this.clients) {
      if (!c.fleet) continue;
      let ids = fleetIdsByTenant.get(c.tenant.id);
      if (!ids) fleetIdsByTenant.set(c.tenant.id, (ids = this.registry.fleetIds(c.tenant.id)));
      if (!ids.size) continue;
      const miners = [...this.minerQueue.values()].filter((m) => ids!.has(m.id));
      if (miners.length) this.send(c, { type: 'fleet-miners', miners });
      const shares = [...ids].flatMap((id) => this.shareQueue.get(id) ?? []).slice(0, 80);
      if (shares.length) this.send(c, { type: 'fleet-shares', shares });
    }
    for (const c of this.clients) {
      if (!c.minerId) continue;
      const m = this.minerQueue.get(c.minerId);
      if (m) this.send(c, { type: 'miner', miner: m });
      const shares = this.shareQueue.get(c.minerId);
      if (shares?.length) this.send(c, { type: 'shares', shares });
    }
    this.shareQueue.clear();
    this.minerQueue.clear();
  }

  private send(c: Client, msg: ServerMessage): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }
}
