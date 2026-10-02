import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FleetSocketService } from '../services/fleet-socket.service';
import { FleetApiService } from '../services/fleet-api.service';
import { SettingsGroupComponent } from '../components/settings-group.component';
import { LoginSettingsComponent } from '../components/login-settings.component';
import { MinerActionsComponent } from '../components/miner-actions.component';
import { SETTINGS_GROUPS } from '../lib/settings-schema';
import { STATUS_SHORT } from '../lib/status';
import { formatHashrate } from '../lib/format';
import { HashAlgo, Miner, PoolConfig, PoolStrategy } from '../models';

const POOL_RE = /^stratum(\+(tcp|ssl|tls))?:\/\/[^\s/:]+(:\d+)?\/?$/i;

interface FormModel {
  name: string;
  algo: HashAlgo;
  poolStrategy: PoolStrategy;
  port: number | null;
  nominalThs: number | null;
  pools: PoolConfig[]; // always 3 slots in the form
}

/**
 * Settings of the ONE connected miner – a general interface for any ASIC.
 * The sections follow what the web pages of Bitmain, MicroBT, Goldshell,
 * iBeLink and Canaan have in common:
 *
 *   Pools · Miner · Performance · Cooling · Network · Security · System · Maintenance
 *
 * Pools and Miner are handled here; the other groups are drawn from the
 * shared schema (lib/settings-schema.ts) by SettingsGroupComponent.
 * Each section says whether this miner's driver can apply it remotely.
 */
@Component({
  selector: 'app-miner-settings-page',
  standalone: true,
  imports: [RouterLink, SettingsGroupComponent, LoginSettingsComponent, MinerActionsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './miner-settings.page.html',
  styleUrl: './miner-settings.page.scss',
})
export class MinerSettingsPage implements OnDestroy {
  private socket = inject(FleetSocketService);
  private api = inject(FleetApiService);

  readonly tenant = this.socket.tenant;
  readonly statusLabel = STATUS_SHORT;
  /** a main pool and one failover pool */
  readonly slotNames = ['Main pool', 'Failover pool'];
  readonly slotHints = ['Used first', 'Backup'];
  readonly groups = SETTINGS_GROUPS;
  /** the section menu on the left */
  readonly sections = [
    { id: 'pools', label: 'Pools' },
    { id: 'miner', label: 'Miner' },
    { id: 'login', label: 'Login' },
    ...SETTINGS_GROUPS.map((g) => ({ id: g.id, label: g.title })),
    { id: 'maintenance', label: 'Maintenance' },
  ];
  readonly now = signal(Date.now());
  private clock = setInterval(() => this.now.set(Date.now()), 1000);

  /** the connected miner – the only one this page can change */
  readonly selected = computed<Miner | undefined>(() => this.socket.miner() ?? undefined);
  private selectedId = computed(() => this.selected()?.id);

  readonly model = signal<FormModel>(emptyModel());
  readonly saving = signal<'save' | 'apply' | null>(null);
  readonly result = signal<{ ok: boolean; text: string } | null>(null);
  /** which card (Pools or Miner) the last save came from, so the message shows there */
  readonly resultIn = signal<'pools' | 'miner'>('pools');
  readonly touched = signal(false);
  private loadedFor = '';

  readonly errors = computed(() => {
    const m = this.model();
    const e: string[] = [];
    m.pools.forEach((p, i) => {
      if (p.url.trim() && !POOL_RE.test(p.url.trim())) e[i] = 'Use the form stratum+tcp://host:port';
      else if (p.url.trim() && !p.user.trim()) e[i] = 'Enter a worker name';
    });
    return e;
  });
  readonly hasErrors = computed(() => this.errors().some(Boolean));
  readonly hasPrimary = computed(() => !!this.model().pools[0].url.trim());

  constructor() {
    // Load the form when a different miner is connected (not on every live update,
    // so the owner's typing is never overwritten).
    effect(() => {
      const id = this.selectedId();
      const m = untracked(() => this.selected());
      if (!id || !m || id === this.loadedFor) return;
      untracked(() => this.load(m));
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.clock);
  }

  /** can this miner's driver apply the pools remotely? */
  readonly canApplyPools = computed(() => !!this.selected()?.capabilities?.pools);

  goTo(id: string): void {
    document.getElementById('sec-' + id)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  /** your node for the hash function this miner computes (a SHA-256 miner needs your SHA-256 node) */
  readonly myNode = computed(() => {
    const t = this.tenant();
    const algo = this.model().algo;
    const n = t?.nodes?.[algo];
    return (Array.isArray(n) ? n[0] : n) ?? t?.stratumUrl;
  });
  readonly algoLabel = computed(() => this.socket.algoLabel(this.model().algo));
  /** every hash function a miner can be set to (the networks' first) */
  readonly algoOptions = computed(() => {
    const seen = new Map<string, string>();
    for (const n of this.socket.networks()) if (n.id !== 'own') seen.set(n.algo, n.label);
    for (const a of this.socket.algorithms()) if (!seen.has(a.algo)) seen.set(a.algo, a.label);
    const cur = this.model().algo;
    if (cur && !seen.has(cur)) seen.set(cur, this.socket.algoLabel(cur));
    return [...seen].map(([algo, label]) => ({ algo, label }));
  });

  useMyNode(): void {
    const url = this.myNode();
    if (!url) return;
    this.patchPool(0, { url });
  }

  patchPool(i: number, patch: Partial<PoolConfig>): void {
    this.model.update((m) => ({ ...m, pools: m.pools.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
    this.result.set(null);
  }

  patch(patch: Partial<FormModel>): void {
    this.model.update((m) => ({ ...m, ...patch }));
    this.result.set(null);
  }

  isMyNode(url: string): boolean {
    const t = this.tenant();
    return !!url && !!t && t.expectedPoolHosts.some((h) => url.toLowerCase().includes(h.toLowerCase()));
  }

  hashrate(m: Miner): string {
    return formatHashrate(m.hashrateThs);
  }

  async save(apply: boolean, section: 'pools' | 'miner' = 'pools'): Promise<void> {
    const m = this.selected();
    this.resultIn.set(section);
    this.touched.set(true);
    if (!m || this.hasErrors() || (apply && !this.hasPrimary())) return;
    const f = this.model();
    this.saving.set(apply ? 'apply' : 'save');
    this.result.set(null);
    try {
      const r = await this.api.saveConfig(m.id, {
        name: f.name,
        algo: f.algo,
        poolStrategy: 'failover',
        port: f.port,
        nominalThs: f.nominalThs,
        pools: f.pools.filter((p) => p.url.trim()),
        apply,
      });
      this.result.set(r.applied ? { ok: r.applied.ok, text: r.applied.message } : { ok: true, text: 'Settings saved.' });
    } catch (e) {
      this.result.set({ ok: false, text: (e as Error).message });
    } finally {
      this.saving.set(null);
    }
  }

  private load(m: Miner): void {
    this.loadedFor = m.id;
    const pools = [...(m.pools ?? [])];
    while (pools.length < 2) pools.push({ url: '', user: '', pass: 'x' });
    this.model.set({ name: m.name, algo: m.algo ?? this.socket.networks()[0]?.algo ?? '', poolStrategy: m.poolStrategy ?? 'failover', port: m.port ?? 4028, nominalThs: m.nominalThs || null, pools: pools.slice(0, 2) });
    this.result.set(null);
    this.touched.set(false);
  }
}

function emptyModel(): FormModel {
  return { name: '', algo: '', poolStrategy: 'failover', port: 4028, nominalThs: null, pools: [0, 1].map(() => ({ url: '', user: '', pass: 'x' })) };
}
