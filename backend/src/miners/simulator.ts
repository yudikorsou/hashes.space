import { MinerRegistry } from './registry';
import { DEFAULT_ALGO } from '../networks';
import { HashAlgo, Miner, MinerAction, MinerSettings, PoolConfig, SettingsGroupId, CpuInfo } from '../types';
import { ApplyResult } from './pool-writer';
import { MinerDriver } from './drivers';
import { defaultSettings } from '../settings-schema';

/**
 * What a miner reports for its settings: hashrate factor, fan speed and chip
 * temperature. Used by the simulator (the demo page has the same rules).
 */
export function simulatedReadings(st: MinerSettings, nominalThs: number) {
  const p = st.performance;
  const powerW = nominalThs * 16; // ~16 J/TH at normal
  const factor =
    p.mode === 'sleep' ? 0
      : p.mode === 'low' ? 0.75
        : p.mode === 'high' ? 1.15
          : p.mode === 'custom' ? Math.max(0.3, Math.min(1.3, p.powerTargetW ? p.powerTargetW / powerW : 1)) * (p.frequencyMHz ? Math.max(0.5, Math.min(1.4, p.frequencyMHz / 525)) : 1)
            : 1;
  const c = st.cooling;
  const heat = 45 + 20 * factor; // °C with fans at 100 %
  const fanRpm = factor === 0 || c.fanMode === 'immersion' ? 0 : c.fanMode === 'manual' ? Math.round(c.fanSpeedPct * 60) : Math.round(2400 + 2400 * factor);
  const temperatureC =
    factor === 0 ? 34
      : c.fanMode === 'immersion' ? Math.round(52 + 6 * factor)
        : c.fanMode === 'manual' ? Math.round(heat + (100 - c.fanSpeedPct) * 0.35)
          : Math.round(Math.min(c.targetTempC, heat + 10));
  return { factor, fanRpm, temperatureC, powerW: Math.round(powerW * factor) };
}

type SimMode = 'ok' | 'offline' | 'wrong' | 'idle';

/**
 * A day of made-up hashrate for a demo miner, so the Hashrate health chart has
 * something to show: normal noise, plus a story per miner.
 *   rig 01 (Goldshell SC Pro): a short power cut 15 h ago (gap) and a dip 7 h ago
 *   rig 02 (Antminer A3): hashes, but none of it reaches your node (wrong port)
 *   rig 03 (SC Box II): hashed normally until its pool was removed 3 h ago
 */
function demoHistory(ths: number, mode: SimMode, index: number): (t: number) => { reported: number; submitted: number } | null {
  const now = Date.now();
  const h = 3_600_000;
  return (t) => {
    const ago = now - t;
    const noise = 0.95 + Math.random() * 0.08 + 0.02 * Math.sin(t / 900_000 + index);
    if (index === 0 && ago > 15 * h && ago < 15.75 * h) return null;
    const reported = +(ths * noise * (index === 0 && ago > 6.8 * h && ago < 7.1 * h ? 0.64 : mode === 'offline' && ago < 3 * h ? 0 : 1)).toFixed(3);
    // only miners pointed at your node submit there (rig 02's pool has the wrong port)
    const submitted = mode === 'ok' || (mode === 'offline' && ago >= 3 * h) ? reported * (0.9 + Math.random() * 0.2) : 0;
    return { reported, submitted };
  };
}

/**
 * Demo miners, each on its own IP address and hash function: [IP, model, nominal TH/s, mode, hash function].
 *   192.168.1.101  Bitmain Antminer S21  200 TH/s   SHA-256   connected and hashing
 *   192.168.1.102  Bitmain Antminer L9   16 GH/s    Scrypt    hashing, not submitting shares (pool on the wrong port)
 *   192.168.1.103  Goldshell SC Box II   1.4 TH/s   BLAKE2b   not hashing (powered on, no pool set up)
 *   192.168.1.104  Goldshell SC Pro      11 TH/s    BLAKE2b   connected and hashing
 *   192.168.1.105  AMD Ryzen 9 7950X     22 kH/s    RandomX   connected and hashing (XMRig, 32 threads on 16 cores)
 *   192.168.1.106  Raspberry Pi 5        600 H/s    RandomX   hashing, not submitting shares (XMRig, 4 cores, wrong port)
 * Switch the network on the dashboard: a miner only hashes usefully on a network of its own hash function.
 * Connect to one of these IPs on the dashboard to see its mode.
 *   ok       connected and hashing (right node, right chain) -> green, fan spins
 *   idle     hashing, not submitting shares (wrong port)   -> orange, fan spins
 *   wrong    hashing, not submitting shares (other pool)   -> orange, fan spins
 *   offline  not hashing (no pool set up)                  -> red, fan stopped
 */
const MODELS: [string, string, number, SimMode, HashAlgo, { cores: number; threads: number }?][] = [
  ['192.168.1.101', 'Bitmain Antminer S21', 200, 'ok', 'sha256'],
  ['192.168.1.102', 'Bitmain Antminer L9', 0.016, 'idle', 'scrypt'],
  ['192.168.1.103', 'Goldshell SC Box II', 1.4, 'offline', 'blake2b'],
  ['192.168.1.104', 'Goldshell SC Pro', 11, 'ok', 'blake2b'],
  // CPU miners (XMRig): 22 kH/s and 600 H/s, written in TH/s like every hashrate here
  ['192.168.1.105', 'AMD Ryzen 9 7950X 16-Core Processor', 22e-9, 'ok', 'randomx', { cores: 16, threads: 32 }],
  ['192.168.1.106', 'Raspberry Pi 5 (Cortex-A76)', 0.6e-9, 'idle', 'randomx', { cores: 4, threads: 4 }],
];

/** how many threads a simulated XMRig runs at this work mode, and what each one hashes (H/s) */
function cpuThreads(cpu: CpuInfo, factor: number, ths: number): CpuInfo {
  const miningThreads = factor <= 0 ? 0 : Math.max(1, Math.min(cpu.threads, Math.round(cpu.threads * Math.min(1, factor))));
  const per = miningThreads ? (ths * 1e12) / miningThreads : 0;
  return { ...cpu, miningThreads, threadHashrates: Array.from({ length: miningThreads }, () => Math.round(per * (0.9 + Math.random() * 0.2))) };
}

/**
 * Creates a demo fleet for tenants that have no real miners registered and
 * emits shares at a realistic Poisson rate: rate = hashrate / (diff * 2^32).
 */
export class MinerSimulator {
  private timer?: NodeJS.Timeout;
  private telemetryTimer?: NodeJS.Timeout;
  private ids: { id: string; tenantId: string; diff: number; mode: SimMode }[] = [];

  constructor(private registry: MinerRegistry) {}

  start(): void {
    for (const t of this.registry.allTenants()) {
      if (this.registry.list(t.id).length) continue;
      MODELS.forEach(([host, model, ths, mode, algo, cpu], i) => {
        const id = `${t.id}:${host}`;
        // pick a vardiff that gives ~0.3–1 share/s so the stream is lively (CPU miners: a fraction of 2^32 hashes)
        const diff = Math.max(cpu ? 0 : 256, 2 ** Math.round(Math.log2((ths * 1e12) / (0.6 * 2 ** 32))));
        this.ids.push({ id, tenantId: t.id, diff, mode });
        // your node for THIS miner's hash function (a SHA-256 miner needs your SHA-256 node)
        const node = this.registry.nodes(t.id)[algo] ?? `stratum+tcp://${t.expectedPoolHosts[0] ?? 'localhost'}:23334`;
        const worker = `bc1qexampleaddress.rig${String(i + 1).padStart(2, '0')}`;
        // ok: points at your node · idle: right host, wrong port, so shares never arrive
        // wrong: another pool · offline: nothing configured yet
        const pools: PoolConfig[] =
          mode === 'ok' ? [{ url: node, user: worker, pass: 'x' }]
          : mode === 'idle' ? [{ url: node.replace(/:(\d+)$/, (_, p) => `:${Number(p) - 1}`), user: worker, pass: 'x' }]
          : mode === 'wrong' ? [{ url: 'stratum+tcp://some-other-pool.example:3333', user: worker, pass: 'x' }]
          : [];
        this.registry.upsert({
          id,
          tenantId: t.id,
          name: `Rig ${String(i + 1).padStart(2, '0')}`,
          host,
          port: 4028,
          model,
          algo,
          driver: 'simulator',
          capabilities: this.driver.capabilities,
          firmwareVersion: cpu ? 'XMRig 6.22 (simulated)' : 'sim-2026.09',
          ...(cpu && { kind: 'cpu' as const, cpu: { brand: model, cores: cpu.cores, threads: cpu.threads, miningThreads: cpu.threads } }),
          nominalThs: ths,
          pools,
          poolUrl: pools[0]?.url,
          // a little history, so each miner opens in its mode instead of "no shares yet"
          ...(mode === 'ok' && { lastShareAt: Date.now() - 3000, sharesAccepted: 412, bestShareDiff: diff * 256 }),
          ...(mode === 'idle' && { lastShareAt: Date.now() - 25 * 60_000, sharesAccepted: 186, bestShareDiff: diff * 64 }),
        });
        this.registry.history.backfill(id, demoHistory(ths, mode, i));
      });
    }
    const tickMs = 200;
    this.telemetry();
    this.telemetryTimer = setInterval(() => this.telemetry(), 3000); // like a firmware push every few seconds
    this.timer = setInterval(() => this.tick(tickMs), tickMs);
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.telemetryTimer);
  }

  handles(id: string): boolean {
    return this.ids.some((s) => s.id === id);
  }

  /** The simulator can apply every settings group and action, so the whole page can be tried out. */
  readonly driver: MinerDriver = {
    name: 'simulator',
    capabilities: { pools: true, performance: true, cooling: true, network: true, security: true, system: true, locate: true, reboot: true, 'power-off': true, 'power-on': true, 'factory-reset': true, password: true },
    applySettings: (m, group) => this.applySettings(m, group),
    runAction: (m, action) => this.runAction(m, action),
  };

  private async applySettings(m: Miner, group: SettingsGroupId | 'pools'): Promise<ApplyResult> {
    if (group === 'pools') return this.applyPools(m);
    const st = m.settings ?? defaultSettings();
    if (group === 'network' && !st.network.dhcp && st.network.ip && st.network.ip !== m.host) {
      try {
        this.registry.upsert({ id: m.id, tenantId: m.tenantId, host: st.network.ip });
      } catch (e) {
        return { ok: false, message: `${(e as Error).message} Settings are saved, but the miner kept ${m.host}.` };
      }
      return { ok: true, message: `Applied to the simulated miner. It now answers on ${st.network.ip}.` };
    }
    this.telemetry();
    const r = simulatedReadings(st, m.nominalThs);
    const extra =
      group === 'performance'
        ? st.performance.mode === 'sleep'
          ? ' It is sleeping now and stops hashing.'
          : ` It now runs at about ${Math.round(r.factor * 100)} % of its rated hashrate, using about ${r.powerW.toLocaleString('en-US')} W.`
        : group === 'cooling'
          ? r.fanRpm
            ? ` Fans now run at about ${r.fanRpm.toLocaleString('en-US')} rpm.`
            : ' The fans are off.'
          : '';
    return { ok: true, message: `Applied to the simulated miner.${extra}` };
  }

  private async runAction(m: Miner, action: MinerAction): Promise<ApplyResult> {
    const s = this.ids.find((x) => x.id === m.id)!;
    const now = Date.now();
    switch (action) {
      case 'locate':
        this.registry.upsert({ id: m.id, tenantId: m.tenantId, locateUntil: now + 60_000 });
        return { ok: true, message: 'The LED on the simulated miner blinks for 60 seconds.' };
      case 'reboot':
        this.registry.upsert({ id: m.id, tenantId: m.tenantId, rebootUntil: now + 25_000, hashrateThs: 0, fanRpm: 0 });
        return { ok: true, message: 'The simulated miner is rebooting. It hashes again in about 25 seconds.' };
      case 'power-off':
        if (m.poweredOff) return { ok: true, message: 'The simulated miner is already turned off.' };
        this.registry.upsert({ id: m.id, tenantId: m.tenantId, poweredOff: true, hashrateThs: 0, fanRpm: 0 });
        return { ok: true, message: 'The simulated miner is turned off. Its hashboards and fans stopped; turn it on here whenever you like.' };
      case 'power-on':
        if (!m.poweredOff) return { ok: true, message: 'The simulated miner is already on.' };
        // the hashboards start up: no answer for a short while, like after a reboot
        this.registry.upsert({ id: m.id, tenantId: m.tenantId, poweredOff: false, rebootUntil: now + 15_000, hashrateThs: 0, fanRpm: 0 });
        return { ok: true, message: 'The simulated miner is turning on. It hashes again in about 15 seconds.' };
      case 'factory-reset':
        s.mode = 'offline';
        this.registry.upsert({ id: m.id, tenantId: m.tenantId, poweredOff: false, rebootUntil: now + 25_000, hashrateThs: 0, fanRpm: 0 });
        return { ok: true, message: 'The simulated miner is back to factory settings and restarting. Set up a pool to start hashing again.' };
      case 'password':
        return { ok: true, message: 'The web interface password of the simulated miner is changed.' };
    }
  }

  /** "Save & apply" for a simulated rig: it starts mining on the new primary pool. */
  async applyPools(m: Miner): Promise<ApplyResult> {
    const s = this.ids.find((x) => x.id === m.id)!;
    const url = m.pools?.[0]?.url;
    if (!url) {
      s.mode = 'offline';
      return { ok: true, message: 'No pools left, so the simulated rig stopped hashing.' };
    }
    // ok: your node for this miner's hash function · idle: your node, but the wrong port or the
    // other blockchain's node (no usable shares) · wrong: someone else's pool
    const n = this.registry.nodeFor(m.tenantId, url);
    const rightChain = n.kind === 'node' && (!n.algo || n.algo === (m.algo ?? DEFAULT_ALGO));
    s.mode = rightChain ? 'ok' : n.kind === 'other' ? 'wrong' : 'idle';
    this.registry.upsert({ id: m.id, tenantId: m.tenantId, poolUrl: url });
    this.telemetry();
    const outcome = {
      ok: 'It is now connected and hashing to your node.',
      idle: n.kind === 'node' ? 'It reaches your node for the other blockchain, so its shares are useless there.' : 'It reaches your node, but that port does not accept shares.',
      wrong: 'It is now mining for another pool, not your node.',
    }[s.mode as 'ok' | 'idle' | 'wrong'];
    return { ok: true, message: `Applied to the simulated rig. ${outcome}` };
  }

  private telemetry(): void {
    const now = Date.now();
    for (const s of this.ids) {
      const m = this.registry.get(s.id);
      if (!m) continue;
      if (m.rebootUntil && now < m.rebootUntil) continue; // no answer while rebooting
      if (m.poweredOff) {
        // turned off: the control board still answers, the hashboards and fans are off
        this.registry.upsert({ id: s.id, tenantId: s.tenantId, lastSeenAt: now, hashrateThs: 0, fanRpm: 0, temperatureC: 30, ...(m.cpu && { cpu: { ...m.cpu, miningThreads: 0, threadHashrates: [] } }) });
        continue;
      }
      if (s.mode === 'offline') {
        // switched on and answering, but with no pool it does no work
        this.registry.upsert({ id: s.id, tenantId: s.tenantId, lastSeenAt: now, hashrateThs: 0, fanRpm: 0, temperatureC: 34, ...(m.cpu && { cpu: { ...m.cpu, miningThreads: 0, threadHashrates: [] } }) });
        continue;
      }
      const jitter = 0.94 + Math.random() * 0.1;
      const r = simulatedReadings(m.settings ?? defaultSettings(), m.nominalThs);
      const ths = m.nominalThs * r.factor * jitter; // 'idle' and 'wrong' miners still hash; their shares just never reach your node
      this.registry.upsert({
        id: s.id,
        tenantId: s.tenantId,
        lastSeenAt: now,
        hashrateThs: Number(ths.toPrecision(4)),
        fanRpm: r.fanRpm ? Math.round(r.fanRpm * (0.97 + Math.random() * 0.06)) : 0,
        temperatureC: r.temperatureC + Math.round(Math.random() * 2),
        // CPU miners: the work mode decides how many threads XMRig runs (low power = half of them)
        ...(m.cpu && { cpu: cpuThreads(m.cpu, r.factor, ths) }),
      });
    }
  }

  private tick(dtMs: number): void {
    for (const s of this.ids) {
      const m = this.registry.get(s.id);
      if (!m || s.mode !== 'ok' || !m.hashrateThs) continue; // wrong-pool rigs send shares elsewhere
      const ths = m.hashrateThs;
      const rate = (ths * 1e12) / (s.diff * 2 ** 32); // shares per second
      if (Math.random() < rate * (dtMs / 1000)) {
        // occasional lucky share with a much higher difficulty
        const diff = Math.random() < 0.05 ? s.diff * 2 ** Math.ceil(Math.random() * 12) : s.diff;
        this.registry.recordShare(s.id, diff, { accepted: Math.random() > 0.01, credit: s.diff });
      }
    }
  }
}
