import fs from 'fs';
import http from 'http';
import path from 'path';
import { MinerRegistry } from './miners/registry';
import { ChainHub, OwnNodeError } from './sources/chain-hub';
import { Miner, Tenant } from './types';
import { ApplyResult } from './miners/pool-writer';
import { MinerDriver } from './miners/drivers';
import { MINER_ACTIONS, SETTINGS_GROUPS } from './settings-schema';
import { allAlgos } from './networks';
import { MinerAction, SettingsGroupId } from './types';
import { ScanResult } from './miners/scanner';
import { AuthError } from './miners/auth';
import { FleetNotReadyError } from './miners/registry';
import { parseIpList } from './miners/ip-list';

/** the driver that can change settings on this miner (cgminer API, simulator, …) */
export type DriverFor = (miner: Miner) => MinerDriver;
/** Find ASIC: the miners powered on in the local network (for this account) */
export type ScanFor = (tenantId: string, refresh: boolean) => Promise<ScanResult>;

/**
 * Dependency-free REST API for manufacturers, firmware and pool-side agents.
 * Auth: header "x-api-key: <tenant api key>" (or ?token=).
 *
 *  GET  /api/v1/health
 *  GET  /api/v1/firmware           firmware plugins loaded from backend/firmware/ {plugins:[{file, name, capabilities, reads, error}]}
 *  GET  /api/v1/chain[?network=id]  chain state of a network (default: the first in networks.json)
 *  GET  /api/v1/networks           streams this account can show (networks.json + own node)
 *  GET  /api/v1/algorithms         every hash function a miner can be set to {algo, label}
 *  GET  /api/v1/own-node           own node settings (password left out)
 *  PUT  /api/v1/own-node           connect own node / Electrum {algo, rpcUrl, rpcUser, rpcPassword, electrumHost, electrumPort, electrumTls}
 *  DELETE /api/v1/own-node         disconnect it
 *  GET  /api/v1/scan[?refresh=1]   Find ASIC: every miner powered on in the local network {subnets, miners, scannedAt, durationMs}
 *  GET  /api/v1/fleet              the account's fleet: name, miners with their mode, counts per mode
 *  POST /api/v1/fleet/check        which miners are ready {ips, sessions:{ip: token}} → checks: login | setup | ready
 *  POST /api/v1/fleet              Generate {ips, name?, sessions:{ip: token}}: only when every miner is logged in to and connected and hashing (else 409 + checks)
 *  PUT  /api/v1/fleet              rename {name}
 *  DELETE /api/v1/fleet/:ip        take a miner out of the fleet
 *  GET  /api/v1/miners             miners on this account (known IP addresses)
 *  POST /api/v1/miners             register miners  [{id,name,model,host,port,nominalThs}]
 *  POST /api/v1/telemetry          firmware push    {minerId, poolUrl, hashrateThs, fanRpm, temperatureC, ...}
 *  POST /api/v1/shares             share push       {minerId, difficulty, hash?, accepted?} | [...]
 *  POST /api/v1/miners/:id/login   {username, password} → {token, expiresAt} (a session for this one miner)
 *  POST /api/v1/miners/:id/logout  end this session
 *  PUT  /api/v1/miners/:id/login   change the login {username, currentPassword, newPassword}   [session]
 *  POST /api/v1/sessions           which of these sessions are still valid {tokens:[…]} → {valid:[{token, minerId, host}]}
 *  GET  /api/v1/miners/:id         one rig incl. its pool settings                            [session]
 *  GET  /api/v1/miners/:id/hashrate?range=live|1h|24h   reported + submitted hashrate {range, bucketMs, windowMs, points:[[t, reported|null, submitted|null]], nominalThs}
 *  PUT  /api/v1/miners/:id/config  pools + identity {name, algo, port, nominalThs, poolStrategy, pools:[{url,user,pass}], apply}
 *  PUT  /api/v1/miners/:id/settings/:group   performance | cooling | network | security | system  {values, apply}
 *  POST /api/v1/miners/:id/actions/:action   locate | reboot | power-off | power-on | factory-reset | password  {newPassword}
 *
 * A miner's IP address is its identity and must be unique on the account;
 * registering a second miner on an IP that is taken returns 400.
 *
 * /api/v1/shares is the most reliable "is it hashing to MY node?" signal: feed it
 * from your stratum server / DATUM Gateway / ckpool share log, so a share only
 * shows up when it actually reached the template of your node.
 */
export function createRequestHandler(registry: MinerRegistry, hub: ChainHub, staticDir: string | undefined, driverFor: DriverFor, scan?: ScanFor, firmwareList?: () => unknown[]): http.RequestListener {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/v1/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-key, x-miner-session');
        if (req.method === 'OPTIONS') return end(res, 204);

        const route = `${req.method} ${p.slice('/api/v1'.length)}`;
        if (route === 'GET /health') {
          return json(res, 200, { ok: true, networks: hub.publicNetworks.map((n) => ({ id: n.id, source: n.source, tip: hub.state(n.id)?.tipHeight })) });
        }
        if (route === 'GET /algorithms') return json(res, 200, allAlgos());
        if (route === 'GET /firmware') return json(res, 200, { plugins: firmwareList?.() ?? [] });
        if (route === 'GET /chain') {
          return json(res, 200, hub.state(url.searchParams.get('network') ?? hub.defaultNetwork) ?? { error: 'unknown network' });
        }

        const tenant = registry.tenantByKey(req.headers['x-api-key']?.toString() ?? url.searchParams.get('token') ?? '');
        if (!tenant) return json(res, 401, { error: 'invalid api key' });

        const one = p.match(/^\/api\/v1\/miners\/([^/]+)(?:\/(config|settings|actions|hashrate|login|logout)(?:\/([a-z-]+))?)?$/);
        if (one) {
          const miner = registry.get(decodeURIComponent(one[1]));
          if (!miner || miner.tenantId !== tenant.id) return json(res, 404, { error: 'miner not found' });
          const [, , kind, sub] = one;
          const session = req.headers['x-miner-session']?.toString();

          // the miner's own login: nobody changes a miner without its username and password
          if (req.method === 'POST' && kind === 'login') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const b: any = await body(req);
            try {
              const s = registry.auth.login(miner.id, b?.username, b?.password);
              return json(res, 200, { ...s, minerId: miner.id, host: miner.host, defaultLogin: registry.auth.isDefault(miner.id) });
            } catch (e) {
              if (e instanceof AuthError) return json(res, e.status, { error: e.message });
              throw e;
            }
          }
          if (req.method === 'POST' && kind === 'logout') {
            if (session) registry.auth.logout(session);
            return json(res, 200, { ok: true });
          }
          if (!registry.auth.check(session, miner.id)) {
            return json(res, 401, { error: `Log in to ${miner.host ?? 'this miner'} first.`, loginRequired: true });
          }
          if (req.method === 'PUT' && kind === 'login') return await changeLogin(res, registry, miner, await body(req), session!, driverFor);

          if (req.method === 'GET' && !kind) return json(res, 200, miner);
          if (req.method === 'GET' && kind === 'hashrate') {
            const q = url.searchParams.get('range');
            const range = q === '24h' ? '24h' : q === '1h' ? '1h' : 'live';
            return json(res, 200, { ...registry.history.series(miner.id, range), nominalThs: miner.nominalThs, hashrateThs: miner.hashrateThs });
          }
          if (req.method === 'PUT' && kind === 'config') return await saveConfig(res, registry, miner, await body(req), driverFor);
          if (req.method === 'PUT' && kind === 'settings' && SETTINGS_GROUPS.some((g) => g.id === sub)) {
            return await saveSettings(res, registry, miner, sub as SettingsGroupId, await body(req), driverFor);
          }
          if (req.method === 'POST' && kind === 'actions' && (MINER_ACTIONS.some((a) => a.id === sub) || sub === 'password')) {
            return await runAction(res, registry, miner, sub as MinerAction, await body(req), driverFor, session);
          }
        }

        const fleetOne = p.match(/^\/api\/v1\/fleet\/([^/]+)$/);
        if (fleetOne && req.method === 'DELETE') return json(res, 200, registry.removeFromFleet(tenant.id, decodeURIComponent(fleetOne[1])));

        switch (route) {
          case 'POST /sessions': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const b: any = await body(req);
            const tokens = Array.isArray(b?.tokens) ? b.tokens.map(String).slice(0, 1000) : [];
            const valid = registry.auth
              .valid(tokens)
              .map((v) => ({ ...v, host: registry.get(v.minerId)?.host }))
              .filter((v) => registry.get(v.minerId)?.tenantId === tenant.id);
            return json(res, 200, { valid });
          }
          case 'GET /fleet':
            return json(res, 200, registry.fleet(tenant.id));
          case 'POST /fleet': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const b: any = await body(req);
            const text = Array.isArray(b?.ips) ? b.ips.join('\n') : String(b?.ips ?? '');
            try {
              return json(res, 200, registry.addToFleet(tenant.id, text, typeof b?.name === 'string' ? b.name : undefined, sessionsOf(b)));
            } catch (e) {
              if (e instanceof FleetNotReadyError) return json(res, 409, { error: e.message, checks: e.checks });
              return json(res, 400, { error: (e as Error).message });
            }
          }
          case 'POST /fleet/check': {
            // which of these miners are ready for the fleet (logged in + connected and hashing)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const b: any = await body(req);
            const parsed = parseIpList(Array.isArray(b?.ips) ? b.ips.join('\n') : String(b?.ips ?? ''));
            return json(res, 200, { checks: registry.fleetReadiness(tenant.id, parsed.ips.slice(0, 512), sessionsOf(b)), invalid: parsed.invalid, duplicates: parsed.duplicates });
          }
          case 'PUT /fleet': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const b: any = await body(req);
            return json(res, 200, registry.renameFleet(tenant.id, String(b?.name ?? '')));
          }
          case 'GET /scan':
            if (!scan) return json(res, 403, { error: 'Scanning the local network is turned off on this server (ALLOW_SCAN=false).' });
            return json(res, 200, await scan(tenant.id, url.searchParams.get('refresh') === '1'));
          case 'GET /networks':
            return json(res, 200, hub.networks(tenant.id));
          case 'GET /own-node':
            return json(res, 200, hub.ownConfig(tenant.id) ?? null);
          case 'PUT /own-node':
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const r = await hub.connectOwn(tenant.id, (await body(req)) as any);
              return json(res, 200, { ok: true, network: r.info, message: r.message });
            } catch (e) {
              return json(res, e instanceof OwnNodeError ? 400 : 500, { error: (e as Error).message });
            }
          case 'DELETE /own-node':
            hub.disconnectOwn(tenant.id);
            return json(res, 200, { ok: true });
          case 'GET /miners':
            return json(res, 200, registry.list(tenant.id));
          case 'POST /miners':
            return json(res, 200, registerMiners(registry, tenant, await body(req)));
          case 'POST /telemetry':
            return telemetry(res, registry, tenant, await body(req));
          case 'POST /shares':
            return json(res, 200, { recorded: recordShares(registry, tenant, await body(req)) });
        }
        return json(res, 404, { error: 'not found' });
      }

      if (staticDir && req.method === 'GET') return serveStatic(res, staticDir, p);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerMiners(registry: MinerRegistry, tenant: Tenant, b: any) {
  const list = Array.isArray(b) ? b : [b];
  return list
    .filter((m) => typeof m?.id === 'string')
    .filter((m) => !registry.get(m.id) || registry.get(m.id)!.tenantId === tenant.id)
    .map((m) =>
      registry.upsert({ id: m.id, tenantId: tenant.id, name: m.name, model: m.model, host: m.host, port: num(m.port), nominalThs: num(m.nominalThs) }),
    );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function telemetry(res: http.ServerResponse, registry: MinerRegistry, tenant: Tenant, b: any) {
  if (typeof b?.minerId !== 'string') return json(res, 400, { error: 'minerId required' });
  const existing = registry.get(b.minerId);
  if (existing && existing.tenantId !== tenant.id) return json(res, 403, { error: 'not your miner' });
  const m = registry.upsert({
    id: b.minerId,
    tenantId: tenant.id,
    name: b.name,
    model: b.model,
    poolUrl: b.poolUrl,
    hashrateThs: num(b.hashrateThs),
    nominalThs: num(b.nominalThs),
    fanRpm: num(b.fanRpm),
    temperatureC: num(b.temperatureC),
    lastSeenAt: Date.now(),
  });
  json(res, 200, m);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recordShares(registry: MinerRegistry, tenant: Tenant, b: any): number {
  const list = Array.isArray(b) ? b : [b];
  let n = 0;
  for (const s of list) {
    const m = registry.get(s?.minerId);
    if (!m || m.tenantId !== tenant.id) continue;
    registry.recordShare(m.id, num(s.difficulty) ?? 1, {
      hash: /^[0-9a-f]{64}$/i.test(s.hash ?? '') ? s.hash.toLowerCase() : undefined,
      accepted: s.accepted !== false,
    });
    n++;
  }
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function saveConfig(res: http.ServerResponse, registry: MinerRegistry, miner: Miner, b: any, driverFor: DriverFor) {
  if (!Array.isArray(b?.pools)) return json(res, 400, { error: 'pools must be a list' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bad = b.pools.find((p: any) => p?.url && !/^stratum(\+(tcp|ssl|tls))?:\/\/[^\s/:]+(:\d+)?\/?$/i.test(String(p.url).trim()));
  if (bad) return json(res, 400, { error: `"${bad.url}" is not a pool address. Use the form stratum+tcp://host:port` });

  const saved = registry.configure(miner.id, {
    name: b.name,
    port: num(b.port),
    nominalThs: num(b.nominalThs),
    algo: typeof b.algo === 'string' && allAlgos().some((a) => a.algo === b.algo) ? b.algo : undefined, // the miner's hash function
    poolStrategy: b.poolStrategy === 'load-balance' ? 'load-balance' : b.poolStrategy === 'failover' ? 'failover' : undefined,
    pools: b.pools,
  })!;
  let applied: ApplyResult | undefined;
  if (b.apply) {
    applied = await driverFor(saved).applySettings(saved, 'pools');
  }
  json(res, 200, { miner: registry.get(miner.id), applied });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function saveSettings(res: http.ServerResponse, registry: MinerRegistry, miner: Miner, group: SettingsGroupId, b: any, driverFor: DriverFor) {
  const values = b?.values;
  if (!values || typeof values !== 'object') return json(res, 400, { error: 'values must be an object' });
  const saved = registry.saveSettings(miner.id, group, values); // throws RegistryError -> 400
  const applied: ApplyResult | undefined = b.apply ? await driverFor(saved).applySettings(registry.get(miner.id)!, group) : undefined;
  json(res, 200, { miner: registry.get(miner.id), applied });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAction(res: http.ServerResponse, registry: MinerRegistry, miner: Miner, action: MinerAction, b: any, driverFor: DriverFor, session?: string) {
  if (action === 'password') {
    const pw = String(b?.newPassword ?? '');
    if (pw.length < 8) return json(res, 400, { error: 'Use a password of at least 8 characters.' });
    if (pw !== String(b?.confirmPassword ?? '')) return json(res, 400, { error: 'The two passwords are not the same.' });
  }
  const result = await driverFor(miner).runAction(miner, action, b ?? {});
  if (result.ok && action === 'factory-reset') registry.factoryReset(miner.id, session);
  json(res, 200, { miner: registry.get(miner.id), result });
}

/**
 * Change the miner's login. Also sets the new password on the miner's own web
 * page when its driver can. Every other session of this miner is signed out.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function changeLogin(res: http.ServerResponse, registry: MinerRegistry, miner: Miner, b: any, session: string, driverFor: DriverFor) {
  const newPassword = String(b?.newPassword ?? '');
  if (newPassword && newPassword !== String(b?.confirmPassword ?? newPassword)) return json(res, 400, { error: 'The two new passwords are not the same.' });
  try {
    registry.auth.change(miner.id, String(b?.currentPassword ?? ''), String(b?.username ?? ''), newPassword, session);
  } catch (e) {
    if (e instanceof AuthError) return json(res, e.status, { error: e.message });
    throw e;
  }
  registry.emit('sessions', miner.id);
  let message = 'Login changed. Other devices signed in to this miner are signed out.';
  const driver = driverFor(miner);
  if (newPassword && driver.capabilities.password) {
    const r = await driver.runAction(miner, 'password', { newPassword, confirmPassword: newPassword });
    message += r.ok ? ' The miner’s own web page uses the new password too.' : ` The miner’s own web page kept its old password: ${r.message}`;
  }
  const updated = registry.upsert({ id: miner.id, tenantId: miner.tenantId });
  json(res, 200, { miner: updated, username: registry.auth.username(miner.id), message });
}

/** {sessions: {ip: token}} from the page: its logins per miner */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sessionsOf(b: any): Record<string, string> {
  const s = b?.sessions;
  if (!s || typeof s !== 'object') return {};
  return Object.fromEntries(Object.entries(s).filter(([k, v]) => typeof k === 'string' && typeof v === 'string').slice(0, 1000)) as Record<string, string>;
}

function body(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serveStatic(res: http.ServerResponse, dir: string, urlPath: string) {
  const safe = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(dir, safe);
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html'); // SPA fallback
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function end(res: http.ServerResponse, status: number) {
  res.writeHead(status);
  res.end();
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n;
}
