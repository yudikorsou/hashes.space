import { Injectable, inject } from '@angular/core';
import { HashAlgo, Miner, MinerStatus, MinerAction, NetworkInfo, OwnNodeConfig, PoolConfig, PoolStrategy, SettingsGroupId } from '../models';
import { FleetSocketService } from './fleet-socket.service';

export interface MinerConfigInput {
  name: string;
  port: number | null;
  nominalThs: number | null;
  algo: HashAlgo;
  poolStrategy: PoolStrategy;
  pools: PoolConfig[];
  /** also push the pools to the rig ("Save & apply") */
  apply: boolean;
}

/** Find ASIC: one miner powered on in the local network */
export interface FoundMiner {
  ip: string;
  model: string;
  hashrateThs: number;
  poolUrl?: string;
  firmware?: string;
  algo?: HashAlgo;
  known?: boolean;
  simulated?: boolean;
  /** the miner's mode, once the dashboard reads it: colours its Connected button after you log in */
  status?: MinerStatus;
  statusReason?: string;
}

export interface ScanResult {
  subnets: string[];
  miners: FoundMiner[];
  scannedAt: number;
  durationMs: number;
}

/** the account's fleet, with each miner's live mode */
export interface FleetView {
  name: string;
  miners: Miner[];
  summary: { total: number; hashing: number; notSubmitting: number; notHashing: number; hashrateThs: Partial<Record<HashAlgo, number>> };
}

/** a miner's way into the fleet: log in (Manage) → set it up until it is connected and hashing → ready */
export interface FleetCheck {
  ip: string;
  ready: boolean;
  step: 'login' | 'setup' | 'ready';
  model?: string;
  status?: MinerStatus;
  reason: string;
}

export interface FleetAddResult {
  added: string[];
  already: string[];
  invalid: { entry: string; reason: string }[];
  duplicates: string[];
  fleet: FleetView;
}

export interface SaveResult {
  miner: Miner;
  applied?: { ok: boolean; message: string };
}

/** REST calls to the backend (same origin, same token as the WebSocket). */
@Injectable({ providedIn: 'root' })
export class FleetApiService {
  private socket = inject(FleetSocketService);

  /** Find ASIC: every miner powered on in the local network (refresh = scan again now) */
  scan(refresh = false): Promise<ScanResult> {
    return this.request<ScanResult>('GET', `/api/v1/scan${refresh ? '?refresh=1' : ''}`);
  }

  /** Hashrate health chart: [bucket start ms, reported TH/s | null, submitted to your node TH/s | null] */
  hashrate(id: string, range: 'live' | '1h' | '24h'): Promise<{ range: string; bucketMs: number; windowMs: number; points: [number, number | null, number | null][]; nominalThs: number }> {
    return this.request('GET', `/api/v1/miners/${encodeURIComponent(id)}/hashrate?range=${range}`);
  }

  /** the fleet: name, miners and a count per mode */
  getFleet(): Promise<FleetView> {
    return this.request<FleetView>('GET', '/api/v1/fleet');
  }

  /** add miners from a pasted list of IP addresses (commas, spaces, new lines, ranges like 192.168.1.110-120) */
  /** Generate: only works when every miner is logged in to and connected and hashing (else it throws with the checks) */
  async addToFleet(ips: string, name?: string): Promise<FleetAddResult> {
    return this.request<FleetAddResult>('POST', '/api/v1/fleet', { ips, name, sessions: this.socket.allSessions() });
  }

  /** is each miner ready for the fleet? login → set up → ready */
  fleetCheck(ips: string): Promise<{ checks: FleetCheck[]; invalid: { entry: string; reason: string }[]; duplicates: string[] }> {
    return this.request('POST', '/api/v1/fleet/check', { ips, sessions: this.socket.allSessions() });
  }

  removeFromFleet(ip: string): Promise<FleetView> {
    return this.request<FleetView>('DELETE', `/api/v1/fleet/${encodeURIComponent(ip)}`);
  }

  renameFleet(name: string): Promise<FleetView> {
    return this.request<FleetView>('PUT', '/api/v1/fleet', { name });
  }

  /** miners on this account */
  listMiners(): Promise<Miner[]> {
    return this.request<Miner[]>('GET', '/api/v1/miners');
  }

  getMiner(id: string): Promise<Miner> {
    return this.request<Miner>('GET', `/api/v1/miners/${encodeURIComponent(id)}`);
  }

  saveConfig(id: string, cfg: MinerConfigInput): Promise<SaveResult> {
    return this.request<SaveResult>('PUT', `/api/v1/miners/${encodeURIComponent(id)}/config`, cfg);
  }

  /** Save one settings group (performance, cooling, network, security, system); apply = also send it to the miner. */
  saveSettings(id: string, group: SettingsGroupId, values: Record<string, unknown>, apply: boolean): Promise<SaveResult> {
    return this.request<SaveResult>('PUT', `/api/v1/miners/${encodeURIComponent(id)}/settings/${group}`, { values, apply });
  }

  /** locate | reboot | power-off | power-on | factory-reset | password */
  runAction(id: string, action: MinerAction, body: Record<string, unknown> = {}): Promise<{ miner: Miner; result: { ok: boolean; message: string } }> {
    return this.request('POST', `/api/v1/miners/${encodeURIComponent(id)}/actions/${action}`, body);
  }

  /** own node settings (password left out), or null */
  getOwnNode(): Promise<Omit<OwnNodeConfig, 'rpcPassword'> | null> {
    return this.request('GET', '/api/v1/own-node');
  }

  /** test and connect the account's own node and/or Electrum server */
  connectOwnNode(cfg: OwnNodeConfig): Promise<{ ok: true; network: NetworkInfo; message: string }> {
    return this.request('PUT', '/api/v1/own-node', cfg);
  }

  disconnectOwnNode(): Promise<{ ok: true }> {
    return this.request('DELETE', '/api/v1/own-node');
  }

  // ---- miner login ----

  /** log in to one miner; on success this browser keeps the session and opens the miner */
  async login(minerId: string, host: string, username: string, password: string): Promise<{ defaultLogin: boolean }> {
    const r = await this.request<{ token: string; expiresAt: number; defaultLogin: boolean }>('POST', `/api/v1/miners/${encodeURIComponent(minerId)}/login`, { username, password });
    this.socket.setSession(host, r.token);
    this.socket.watch(host);
    return r;
  }

  /** end this browser's session for the miner at this IP */
  async logout(host: string): Promise<void> {
    const id = this.socket.tenant() ? `${this.socket.tenant()!.id}:${host}` : host;
    try {
      await this.request('POST', `/api/v1/miners/${encodeURIComponent(id)}/logout`);
    } finally {
      this.socket.clearSession(host);
    }
  }

  /** new username and/or password for this miner (the current password is required) */
  changeLogin(id: string, input: { username: string; currentPassword: string; newPassword: string; confirmPassword: string }): Promise<{ miner: Miner; username: string; message: string }> {
    return this.request('PUT', `/api/v1/miners/${encodeURIComponent(id)}/login`, input);
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    // calls about one miner carry this browser's login session for it
    const minerId = /^\/api\/v1\/miners\/([^/?]+)/.exec(url)?.[1];
    const host = minerId ? decodeURIComponent(minerId).replace(/^[^:]*:/, '') : undefined;
    const session = this.socket.sessionFor(host);
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': this.socket.token(), ...(session && { 'x-miner-session': session }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.loginRequired && host) this.socket.clearSession(host); // expired or changed elsewhere
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data as T;
  }
}
