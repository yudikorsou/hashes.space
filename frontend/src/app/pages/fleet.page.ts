import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FleetSocketService } from '../services/fleet-socket.service';
import { FleetApiService } from '../services/fleet-api.service';
import { Miner } from '../models';
import { NetworkBarComponent } from '../components/network-bar.component';
import { ChainStripComponent } from '../components/chain-strip.component';
import { FanComponent } from '../components/fan.component';
import { CpuComponent } from '../components/cpu.component';
import { FleetStreamComponent } from '../components/fleet-stream.component';
import { formatHashrate } from '../lib/format';

/**
 * Fleet dashboard (route /fleet), made with "Generate fleet" on Find ASIC.
 * The blockchain on top, then every miner of the fleet as a tile with its own
 * fan and mode. Every share a miner submits to your node flies from its fan into
 * the block being mined, scaled to the size of the fleet so it stays clean.
 */
@Component({
  selector: 'app-fleet-page',
  standalone: true,
  imports: [NetworkBarComponent, ChainStripComponent, FanComponent, CpuComponent, FleetStreamComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-network-bar />
    <app-chain-strip [chain]="socket.chain()" />

    <main>
      @if (loaded() && !miners().length) {
        <section class="empty">
          <app-fan [status]="'not-hashing'" />
          <div>
            <h1>No fleet yet</h1>
            <p>Go to Find ASIC, paste the IP addresses of your miners under Generate fleet and click Generate. This page then shows all of them, with their shares flying into the block being mined.</p>
            <a class="btn primary" routerLink="/asic">Generate a fleet</a>
          </div>
        </section>
      } @else {
        <header class="head">
          <div>
            <h1>{{ name() }}</h1>
            <p>{{ miners().length }} {{ miners().length === 1 ? 'miner' : 'miners' }} · every share that reaches your node flies from its fan into the block being mined</p>
          </div>
          <a class="btn" routerLink="/asic" fragment="fleet-title">Edit fleet</a>
        </header>

        <ul class="tally" aria-label="Fleet summary">
          <li class="hashing"><b>{{ count('hashing') }}</b> connected and hashing</li>
          <li class="not-submitting"><b>{{ count('not-submitting') }}</b> not submitting shares</li>
          <li class="not-hashing"><b>{{ count('not-hashing') }}</b> not hashing</li>
          @for (t of total(); track t.algo) {
            <li><b>{{ t.value }}</b> {{ t.label }}</li>
          } @empty {
            <li><b>0 H/s</b> fleet hashrate</li>
          }
        </ul>

        <ul class="grid" [class.dense]="miners().length > 12">
          @for (m of miners(); track m.id) {
            <li [class]="'tile ' + m.status" [class.current]="socket.miner()?.id === m.id">
              @if (m.cpu) {
                <app-cpu class="fan" [attr.data-fleet-fan]="m.id" [status]="socket.unlocked().has(m.host!) ? m.status : 'not-hashing'" [cpu]="m.cpu" />
              } @else {
                <app-fan class="fan" [attr.data-fleet-fan]="m.id" [status]="socket.unlocked().has(m.host!) ? m.status : 'not-hashing'" [hashrateThs]="m.status === 'not-hashing' ? 0 : m.hashrateThs" [nominalThs]="m.nominalThs" />
              }
              <div class="info">
                <span class="ip">{{ m.host }}</span>
                @if (m.cpu) {
                  <span class="model"><b class="cores">{{ m.cpu.cores }} cores · {{ m.cpu.miningThreads }}/{{ m.cpu.threads }} threads</b>{{ m.algo ? ' · ' + socket.algoLabel(m.algo) : '' }}</span>
                } @else {
                  <span class="model">{{ m.model }}{{ m.algo ? ' · ' + socket.algoLabel(m.algo) : '' }}</span>
                }
                <span class="chip" [title]="m.statusReason">{{ label(m.status) }}</span>
                <span class="row">
                  <span class="rate">{{ rate(m) }}</span>
                  <button type="button" class="manage" (click)="manage(m.host!)" [attr.aria-label]="'Manage ' + m.host + ': ' + label(m.status) + '. ' + m.statusReason">Manage</button>
                </span>
              </div>
            </li>
          }
        </ul>
      }
    </main>

    <app-fleet-stream [size]="miners().length" />
  `,
  styles: [
    `
      .cores { color: var(--text); font-weight: 600; }
      :host { display: block; }
      main { padding: 24px 20px 56px; max-width: 1200px; margin: 0 auto; display: grid; gap: 18px; }
      h1 { margin: 0 0 4px; font: 600 24px/1.2 var(--display); letter-spacing: 0.02em; }
      .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 10px 20px; }
      .head p, .empty p { margin: 0; color: var(--muted); font-size: 13.5px; max-width: 70ch; }
      .head a.btn, .empty a.btn { text-decoration: none; }
      .tally { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; color: var(--muted); }
      .tally li { --state: var(--line-strong); display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; }
      .tally li b { color: var(--text); font: 600 13px/1 var(--mono); }
      .tally li:is(.hashing, .not-submitting, .not-hashing)::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--state); }
      .hashing { --state: var(--good); }
      .not-submitting { --state: var(--orange); }
      .not-hashing { --state: var(--bad); }
      .grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
      .grid.dense { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
      .tile {
        position: relative;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 12px;
        padding: 14px 14px 14px 16px;
        background: var(--surface);
        border: 1px solid var(--line);
        border-left: 3px solid var(--state);
        border-radius: 8px;
      }
      .tile.current { border-color: var(--state); }
      .fan { --fan-size: 52px; }
      .dense .fan { --fan-size: 40px; }
      .info { display: grid; gap: 3px; min-width: 0; }
      .ip { font: 500 15px/1.2 var(--mono); }
      .model { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip { display: inline-flex; align-items: center; gap: 6px; margin-top: 3px; color: var(--state); font: 600 11px/1.2 var(--sans); text-transform: uppercase; letter-spacing: 0.06em; }
      .chip::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--state); flex: none; }
      .rate { font: 500 13px/1.2 var(--mono); color: var(--text); white-space: nowrap; }
      .row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .manage { font: 600 12px/1 var(--sans); color: var(--link); background: none; border: 0; padding: 4px 0 4px 4px; cursor: pointer; }
      .manage:hover { text-decoration: underline; }
      .manage:focus-visible { outline: 2px solid var(--link); border-radius: 4px; }
      .empty { display: grid; grid-template-columns: auto 1fr; gap: 24px; align-items: center; padding: 28px; border: 1px dashed var(--line-strong); border-radius: 8px; --fan-size: 90px; }
      .empty .btn { display: inline-block; margin-top: 14px; }
      @media (max-width: 720px) {
        main { padding-inline: 16px; }
        .grid, .grid.dense { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
        .tile { grid-template-columns: 1fr; justify-items: start; gap: 8px; padding: 12px; }
        .fan { --fan-size: 40px; }
        .empty { grid-template-columns: 1fr; }
      }
    `,
  ],
})
export class FleetPage implements OnInit, OnDestroy {
  readonly socket = inject(FleetSocketService);
  private api = inject(FleetApiService);
  private router = inject(Router);

  readonly name = signal('My fleet');
  readonly order = signal<string[]>([]);
  readonly loaded = signal(false);
  private connecting = signal<string | null>(null);

  /** fleet miners in the order they were added, with their live state */
  readonly miners = computed(() => {
    const live = this.socket.fleetMiners();
    return this.order().map((id) => live[id]).filter((m): m is Miner => !!m);
  });
  /** the work that counts: miners that are connected and hashing */
  /** hashrate per hash function of the miners that are connected and hashing (TH/s of SHA-256 and kH/s of RandomX don't add up) */
  readonly total = computed(() => {
    const per = new Map<string, number>();
    for (const m of this.miners()) if (m.status === 'hashing') per.set(m.algo ?? '', (per.get(m.algo ?? '') ?? 0) + (m.hashrateThs || 0));
    return [...per].map(([algo, v]) => ({ algo, label: this.socket.algoLabel(algo) || 'fleet hashrate', value: formatHashrate(v) }));
  });

  constructor() {
    // Manage: once the miner opens (or its login is asked for), go to the dashboard
    effect(() => {
      const want = this.connecting();
      const host = this.socket.miner()?.host ?? this.socket.loginRequired()?.host;
      if (want && host === want) untracked(() => {
        this.connecting.set(null);
        this.router.navigateByUrl('/');
      });
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      const f = await this.api.getFleet();
      this.name.set(f.name);
      this.order.set(f.miners.map((m) => m.id));
      this.socket.watchFleet(f.miners);
    } finally {
      this.loaded.set(true);
    }
  }

  ngOnDestroy(): void {
    this.socket.unwatchFleet();
  }

  count(status: string): number {
    return this.miners().filter((m) => m.status === status).length;
  }

  label(status: string): string {
    return status === 'hashing' ? 'Connected' : status === 'not-submitting' ? 'Not submitting' : 'Not hashing';
  }

  rate(m: Miner): string {
    return m.status === 'not-hashing' ? '–' : formatHashrate(m.hashrateThs);
  }

  manage(host: string): void {
    this.connecting.set(host);
    this.socket.watch(host);
  }
}
