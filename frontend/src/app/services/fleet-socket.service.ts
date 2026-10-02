import { Injectable, NgZone, OnDestroy, computed, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ChainBlock, ChainState, ClientMessage, Miner, NetworkId, NetworkInfo, ServerMessage, ShareEvent, Tenant, HashAlgo } from '../models';

export type ConnectionState = 'connecting' | 'live' | 'offline' | 'unauthorised';

/**
 * Single WebSocket to the backend (/ws?token=…).
 *
 * The page is connected to ONE miner at a time, chosen by its IP address:
 * watch('192.168.1.101') replaces whatever miner was connected before, and
 * disconnect() drops it. The backend decides the miner's mode (hashing /
 * not-submitting / not-hashing); this service only exposes it.
 *
 * The page shows one of the backend's networks (networks.json: any proof-of-work
 * hash function, e.g. SHA-256, Scrypt, BLAKE2b) or the account's own node.
 *
 * The last IP and stream are remembered in the browser for the next visit.
 *
 * Every miner is protected by its own login. watch() sends this browser's
 * session for that miner; without a valid one the backend answers
 * 'login-required' and the dashboard asks for the username and password.
 * Sessions are kept per miner IP, so every miner you logged in to shows as
 * Connected on Find ASIC.
 */
@Injectable({ providedIn: 'root' })
export class FleetSocketService implements OnDestroy {
  readonly connection = signal<ConnectionState>('connecting');
  readonly tenant = signal<Omit<Tenant, 'apiKey'> | null>(null);
  readonly chain = signal<ChainState | null>(null);

  /** streams this account can show, and the one this page shows */
  readonly networks = signal<NetworkInfo[]>([]);
  readonly networkId = signal<NetworkId>(this.stored('network') ?? '');
  /** every hash function a miner can be set to: [{algo, label}] */
  readonly algorithms = signal<{ algo: HashAlgo; label: string }[]>([]);
  readonly network = computed(() => this.networks().find((n) => n.id === this.networkId()) ?? null);

  /** the connected miner (null = none) */
  readonly miner = signal<Miner | null>(null);
  /** IP we asked to connect to and are waiting on */
  readonly pendingHost = signal<string | null>(null);
  /** why the last connect attempt failed */
  readonly watchError = signal<string | null>(null);
  /** the miner the page wants to open, but the login for it is missing or expired */
  readonly loginRequired = signal<{ host: string; minerId: string; defaultLogin: boolean; username: string } | null>(null);
  /** login sessions per miner IP (kept in this browser) */
  private sessions = signal<Record<string, string>>(this.readSessions());
  /** miner IPs this browser is logged in to: they show as Connected on Find ASIC */
  readonly unlocked = computed(() => new Set(Object.keys(this.sessions())));

  readonly shares$ = new Subject<ShareEvent[]>();

  /** fleet dashboard: live state of every fleet miner (by id) and their shares */
  readonly fleetMiners = signal<Record<string, Miner>>({});
  readonly fleetShares$ = new Subject<ShareEvent[]>();
  private fleetWatching = false;
  readonly blockFound$ = new Subject<ChainBlock>();

  private ws?: WebSocket;
  private retry = 0;
  private closed = false;

  constructor(private zone: NgZone) {
    this.connect();
  }

  ngOnDestroy(): void {
    this.closed = true;
    this.ws?.close();
  }

  /** access token for this dashboard (also used for REST calls) */
  token(): string {
    const fromUrl = new URLSearchParams(location.search).get('token');
    try {
      if (fromUrl) localStorage.setItem('fleet-token', fromUrl);
      return fromUrl ?? localStorage.getItem('fleet-token') ?? 'demo-key';
    } catch {
      return fromUrl ?? 'demo-key';
    }
  }

  /** Connect the page to the miner at this IP (replaces the current one). Asks for its login when needed. */
  watch(host: string): void {
    const h = host.trim();
    if (!h) return;
    this.watchError.set(null);
    this.loginRequired.set(null);
    this.pendingHost.set(h);
    this.remember(h);
    this.send({ type: 'watch', host: h, session: this.sessionFor(h) });
  }

  /** every login this browser has, by miner IP (sent along when checking or generating a fleet) */
  allSessions(): Record<string, string> {
    return { ...this.sessions() };
  }

  /** the login session for this miner IP, if this browser has one */
  sessionFor(host: string | undefined): string | undefined {
    return host ? this.sessions()[host] : undefined;
  }

  /** remember a login for this miner IP (after a correct username and password) */
  setSession(host: string, token: string): void {
    this.sessions.update((all) => ({ ...all, [host]: token }));
    this.writeSessions();
  }

  /** forget the login for this miner IP; if it's the open miner, the page closes it */
  clearSession(host: string): void {
    this.sessions.update(({ [host]: _gone, ...rest }) => rest);
    this.writeSessions();
    if (this.miner()?.host === host) this.disconnect();
  }

  /** fleet dashboard: start getting every fleet miner's updates and shares */
  watchFleet(miners: Miner[]): void {
    this.fleetMiners.set(Object.fromEntries(miners.map((m) => [m.id, m])));
    this.fleetWatching = true;
    this.send({ type: 'watch-fleet' });
  }

  unwatchFleet(): void {
    this.fleetWatching = false;
    this.send({ type: 'unwatch-fleet' });
  }

  /** "SHA-256" for "sha256" */
  algoLabel(algo?: HashAlgo | null): string {
    if (!algo) return '';
    return this.networks().find((n) => n.algo === algo && n.id !== 'own')?.label ?? this.algorithms().find((a) => a.algo === algo)?.label ?? algo.toUpperCase();
  }

  /** Show another blockchain stream (a network from networks.json, or your own node). */
  setNetwork(id: NetworkId): void {
    this.store('network', id);
    this.networkId.set(id);
    this.send({ type: 'network', id });
  }

  disconnect(): void {
    this.remember(null);
    this.pendingHost.set(null);
    this.loginRequired.set(null);
    this.miner.set(null);
    this.send({ type: 'unwatch' });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private remembered(): string | null {
    return new URLSearchParams(location.search).get('miner') ?? this.stored('miner-host');
  }

  /** a miner was connected on this browser before (it reconnects on load) */
  hasRemembered(): boolean {
    return !!this.stored('miner-host');
  }

  private remember(host: string | null): void {
    this.store('miner-host', host);
  }

  private readSessions(): Record<string, string> {
    try {
      const v = JSON.parse(this.stored('miner-sessions') ?? '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  private writeSessions(): void {
    const all = this.sessions();
    this.store('miner-sessions', Object.keys(all).length ? JSON.stringify(all) : null);
  }

  /** drop sessions the backend no longer knows (expired, or the login was changed elsewhere) */
  private async checkSessions(): Promise<void> {
    const tokens = Object.values(this.sessions());
    if (!tokens.length) return;
    try {
      const res = await fetch('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': this.token() }, body: JSON.stringify({ tokens }) });
      if (!res.ok) return;
      const { valid } = (await res.json()) as { valid: { token: string; host?: string }[] };
      const ok = new Set(valid.map((v) => v.token));
      this.sessions.update((all) => Object.fromEntries(Object.entries(all).filter(([, t]) => ok.has(t))));
      this.writeSessions();
    } catch {
      /* offline: keep them, the backend checks every use anyway */
    }
  }

  private stored(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private store(key: string, value: string | null): void {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* storage unavailable: the page just starts with defaults next time */
    }
  }

  private async loadAlgorithms(): Promise<void> {
    if (this.algorithms().length) return;
    try {
      const r = await fetch('/api/v1/algorithms');
      if (r.ok) this.algorithms.set(await r.json());
    } catch {
      /* the list of networks is enough to show labels */
    }
  }

  private connect(): void {
    this.connection.set('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token())}&network=${encodeURIComponent(this.networkId())}`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.connection.set('live');
      // reconnect to the miner we were watching (after a reload or a dropped socket)
      const host = this.miner()?.host ?? this.pendingHost() ?? this.remembered();
      if (host) this.watch(host);
      if (this.fleetWatching) this.send({ type: 'watch-fleet' });
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data) as ServerMessage);
    ws.onclose = (ev) => {
      if (ev.code === 4401) {
        this.connection.set('unauthorised');
        return;
      }
      this.connection.set('offline');
      if (this.closed) return;
      setTimeout(() => this.connect(), Math.min(15_000, 1000 * 2 ** this.retry++));
    };
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello':
        this.tenant.set(msg.tenant);
        this.networks.set(msg.networks);
        // a network this server doesn't have (any more): the server starts on its first one
        if (!msg.networks.some((n) => n.id === this.networkId())) this.networkId.set(msg.networks[0]?.id ?? '');
        this.checkSessions();
        this.loadAlgorithms();
        break;
      case 'networks':
        this.networks.set(msg.networks);
        if (!msg.networks.some((n) => n.id === this.networkId())) this.networkId.set(msg.networks[0]?.id ?? '');
        break;
      case 'network':
        this.networkId.set(msg.id);
        break;
      case 'chain':
        if (msg.networkId === this.networkId()) this.chain.set(msg.chain);
        break;
      case 'watching':
        this.miner.set(msg.miner);
        this.pendingHost.set(null);
        this.loginRequired.set(null);
        break;
      case 'login-required':
        // no (valid) login for this miner: the dashboard shows the login form
        this.sessions.update(({ [msg.host]: _gone, ...rest }) => rest);
        this.writeSessions();
        this.miner.set(null);
        this.pendingHost.set(null);
        this.loginRequired.set({ host: msg.host, minerId: msg.minerId, defaultLogin: msg.defaultLogin, username: msg.username });
        break;
      case 'watch-error':
        this.watchError.set(msg.message);
        this.pendingHost.set(null);
        break;
      case 'miner':
        if (msg.miner.id === this.miner()?.id) this.miner.set(msg.miner);
        break;
      case 'shares': {
        const id = this.miner()?.id;
        const mine = msg.shares.filter((s) => s.minerId === id);
        // Animation subscribers run outside Angular; no change detection per share.
        if (mine.length) this.zone.runOutsideAngular(() => this.shares$.next(mine));
        break;
      }
      case 'fleet-miners':
        this.fleetMiners.update((all) => ({ ...all, ...Object.fromEntries(msg.miners.map((m) => [m.id, m])) }));
        break;
      case 'fleet-shares':
        // animation subscribers run outside Angular
        this.zone.runOutsideAngular(() => this.fleetShares$.next(msg.shares));
        break;
      case 'block-found':
        this.blockFound$.next(msg.block);
        break;
    }
  }
}
