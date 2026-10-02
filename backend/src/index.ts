import fs from 'fs';
import http from 'http';
import path from 'path';
import { config, loadJson, loadTenants } from './config';
import { createRequestHandler } from './api';
import { PushServer } from './ws-server';
import { ChainHub } from './sources/chain-hub';
import { MinerRegistry } from './miners/registry';
import { CgminerPoller } from './miners/cgminer-poller';
import { MinerSimulator } from './miners/simulator';
import { cgminerDriver, MinerDriver } from './miners/drivers';
import { FirmwarePlugins } from './miners/firmware-plugins';
import { Miner } from './types';
import { FoundMiner, ScanResult, scanLocalNetwork } from './miners/scanner';

// one blockchain stream per network in networks.json (any proof-of-work hash function), plus each account's own node
const hub = new ChainHub();
const registry = new MinerRegistry(loadTenants());

// Real miners from miners.json: [{ "id", "tenantId", "name", "model", "host", "port", "nominalThs" }]
// (optional: pages can also connect to any IP directly). Each IP may appear only once per account.
for (const m of loadJson<Array<Partial<Miner> & { id: string; tenantId: string }>>(config.minersFile, [])) {
  try {
    registry.upsert(m);
  } catch (e) {
    console.warn(`[miners.json] skipped ${m.id}: ${(e as Error).message}`);
  }
}

// Serve the built Angular app from the same port when present (single deployable).
const staticDir = fs.existsSync(config.frontendDist) ? path.resolve(config.frontendDist) : undefined;
const simulator = new MinerSimulator(registry);
// Firmware plugins (backend/firmware/*.js): anyone can add support for their own mining firmware.
const firmware = new FirmwarePlugins(config.firmwareDir).load();
const poller = new CgminerPoller(registry, config.miners.pollMs, (id) => simulator.handles(id), (m) => firmware.readerFor(m));
// The driver that changes settings on a miner: the simulator for demo miners, else the miner's
// firmware plugin, else the standard cgminer API.
const driverFor = (m: Miner): MinerDriver => (simulator.handles(m.id) ? simulator.driver : (firmware.driverFor(m, cgminerDriver) ?? cgminerDriver));

// the moment a page connects: say what the settings page can apply, and read the miner right away
registry.on('connect', (m: Miner) => {
  const d = driverFor(m);
  if (m.driver !== d.name) registry.upsert({ id: m.id, tenantId: m.tenantId, driver: d.name, capabilities: d.capabilities });
  poller.pollNow(m.id);
});
// once a reading says which firmware a miner runs, its plugin (and what the settings page may change) can change
registry.on('miner', (m: Miner) => {
  if (simulator.handles(m.id)) return;
  const d = driverFor(m);
  if (m.driver && m.driver !== d.name) registry.upsert({ id: m.id, tenantId: m.tenantId, driver: d.name, capabilities: d.capabilities });
});

// Find ASIC: probe the local network for powered-on miners (one scan at a time, cached briefly)
let lastScan: ScanResult | undefined;
let running: Promise<ScanResult> | undefined;
const scan = async (tenantId: string, refresh: boolean): Promise<ScanResult> => {
  if (refresh || !lastScan || Date.now() - lastScan.scannedAt > config.scan.cacheMs) {
    running ??= scanLocalNetwork({ port: config.scan.port, extraSubnets: config.scan.extraSubnets }).finally(() => (running = undefined));
    lastScan = await running;
  }
  const known = new Set(registry.list(tenantId).map((m) => m.host));
  // each miner's live mode from the registry (the dashboard reads every miner it knows)
  const withStatus = (f: FoundMiner): FoundMiner => {
    const m = f.ip ? registry.byHost(tenantId, f.ip) : undefined;
    return m ? { ...f, status: m.status, statusReason: m.statusReason } : f;
  };
  // the demo miners count as powered on in the local network
  const sims: FoundMiner[] = registry
    .list(tenantId)
    .filter((m) => !!m.host && simulator.handles(m.id) && (m.rebootUntil ?? 0) < Date.now())
    .map((m) => ({ ip: m.host!, model: m.model, hashrateThs: m.hashrateThs, poolUrl: m.poolUrl, algo: m.algo, firmware: m.firmwareVersion, simulated: true }));
  const real = lastScan.miners.filter((f) => !sims.some((s) => s.ip === f.ip)).map((f) => ({ ...f, known: known.has(f.ip) }));
  const miners = [...sims.map((s) => ({ ...s, known: true })), ...real].map(withStatus).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return { ...lastScan, miners };
};

const server = http.createServer(createRequestHandler(registry, hub, staticDir, driverFor, config.scan.enabled ? scan : undefined, () => firmware.list()));
const push = new PushServer(server, hub, registry);

hub.start();
poller.start();
if (config.miners.simulate) simulator.start();

server.listen(config.port, () => {
  console.log(`hashes.space backend on :${config.port}`);
  hub.publicNetworks.forEach((n) => console.log(`  ${n.label.padEnd(8)} ${n.chain} via ${n.source}`));
  console.log(`  WebSocket  ws://localhost:${config.port}/ws?token=<tenant api key>`);
});

const shutdown = () => {
  hub.stop();
  poller.stop();
  simulator.stop();
  push.close();
  registry.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
// one bad request or miner must never take the whole server down
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
process.on('SIGTERM', shutdown);
