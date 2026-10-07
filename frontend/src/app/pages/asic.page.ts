import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FleetSocketService } from '../services/fleet-socket.service';
import { FleetApiService, FleetCheck, FleetView, ScanResult } from '../services/fleet-api.service';
import { MAX_FLEET_ADD, parseIpList } from '../lib/ip-list';
import { STATUS_SHORT } from '../lib/status';
import { formatHashrate } from '../lib/format';
import { FanComponent } from '../components/fan.component';
import { CpuComponent } from '../components/cpu.component';
import { CpuInfo, MinerStatus, cpuLine } from '../models';

/**
 * Find ASIC: the first stop before connecting. Lists every miner that is
 * powered on in the local network (found by the backend, which runs in that
 * network), each with a Manage button. Manage asks for the miner's login on
 * the dashboard. Every miner this browser is logged in to shows a status bar
 * (Connected / Not submitting / Not hashing) and keeps its Manage button, which
 * then opens its Miner settings. Click a row to show that miner on the
 * dashboard (one at a time); the selected row is outlined.
 *
 * Below it, Generate fleet: paste many IP addresses at once (commas, spaces,
 * new lines or ranges) and click Generate to open the fleet dashboard (/fleet)
 * with all those miners. The list under it manages the fleet.
 */
@Component({
  selector: 'app-asic-page',
  standalone: true,
  imports: [FanComponent, CpuComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <section class="s-card">
        <div class="s-card-head">
          <div>
            @if (cpu) {
              <h1>Find CPU</h1>
              <p>Every CPU mining rig (XMRig) that is connected to your local network, with the cores and threads it mines on. Click Manage, the dashboard can showcase the stats of one local mining rig's IP at a time.</p>
            } @else {
              <h1>Find ASIC</h1>
              <p>Every ASIC that is connected to your local network. Click Manage, the dashboard can showcase the stats of one local mining rig's IP at a time.</p>
            }
          </div>
          <button type="button" class="btn" [disabled]="scanning()" (click)="scan(true)">{{ scanning() ? 'Scanning…' : 'Scan again' }}</button>
        </div>

        <p class="meta" role="status">
          @if (scanning() && !result()) {
            Scanning your local network…
          } @else {
            @if (error(); as e) {
              <span class="err">{{ e }}</span>
            } @else {
              @if (result(); as r) {
                {{ found().length }} {{ cpu ? (found().length === 1 ? 'CPU rig' : 'CPU rigs') : (found().length === 1 ? 'miner' : 'miners') }} powered on
                @if (r.subnets.length) { · scanned {{ r.subnets.join(', ') }} }
                · {{ ago(r.scannedAt) }}
              }
            }
          }
        </p>

        @if (socket.watchError(); as err) {
          <p class="err" role="alert">{{ err }}</p>
        }

        @if (found().length) {
          <ul class="list">
            @for (m of found(); track m.ip) {
              <li class="pick" [class.current]="current() === m.ip" (click)="open(m.ip)" [title]="'Show ' + m.ip + ' on the dashboard'">
                @if (m.cpu) {
                  <app-cpu class="fan" [status]="spinState(m.ip, m.status)" [cpu]="m.cpu" />
                } @else {
                  <app-fan class="fan" [status]="spinState(m.ip, m.status)" [hashrateThs]="m.hashrateThs" [nominalThs]="m.hashrateThs || 1" />
                }
                <div class="who">
                  <span class="ip">{{ m.ip }}</span>
                  @if (m.cpu) {
                    <!-- a CPU miner: how many cores it has to keep busy, instead of an ASIC model -->
                    <span class="model"><b class="cores">{{ coresLine(m.cpu) }}</b> · {{ m.cpu.brand }}{{ m.algo ? ' · ' + socket.algoLabel(m.algo) : '' }}</span>
                  } @else {
                    <span class="model">{{ m.model }}{{ m.algo ? ' · ' + socket.algoLabel(m.algo) : '' }}</span>
                  }
                </div>
                <dl>
                  <div class="pool"><dt>Pool</dt><dd [title]="m.poolUrl ?? ''">{{ pool(m.poolUrl) }}</dd></div>
                </dl>
                <div class="go">
                  @if (socket.unlocked().has(m.ip)) {
                    <button type="button" class="btn connected" [class.not-submitting]="m.status === 'not-submitting'" [class.not-hashing]="m.status === 'not-hashing'"
                      (click)="$event.stopPropagation(); open(m.ip)" [title]="m.statusReason ?? ''" [attr.aria-label]="barLabel(m.status) + ': ' + m.ip + (m.statusReason ? '. ' + m.statusReason : '') + '. Show it on the dashboard'">{{ barLabel(m.status) }}</button>
                    <button type="button" class="btn primary" (click)="$event.stopPropagation(); manage(m.ip)" [attr.aria-label]="'Manage ' + m.ip + ': Miner settings'">Manage</button>
                  } @else {
                    <button type="button" class="btn primary" [disabled]="!!connecting() || socket.connection() !== 'live'" (click)="$event.stopPropagation(); connect(m.ip)"
                      [attr.aria-label]="'Manage ' + m.ip">
                      {{ connecting() === m.ip ? 'Connecting…' : 'Manage' }}
                    </button>
                  }
                </div>
              </li>
            }
          </ul>
        } @else if (result() && !scanning()) {
          <div class="none">
            <app-fan [status]="'not-hashing'" />
            <div>
              @if (cpu) {
                <h2>No CPU rigs found</h2>
                <p>Nothing answered on XMRig's HTTP API ({{ xmrigPorts }}). Check that:</p>
                <ul>
                  <li>XMRig runs with its HTTP API on: <code>"http": {{ '{' }} "enabled": true, "host": "0.0.0.0", "port": 18088 {{ '}' }}</code> in its config.json;</li>
                  <li>the server has the same access token in <code>XMRIG_ACCESS_TOKEN</code>, and the port in <code>SCAN_XMRIG_PORTS</code>;</li>
                  <li>this hashes.space server runs on a computer in the same local network as the rigs.</li>
                </ul>
              } @else {
              <h2>No miners found</h2>
              <p>Nothing answered on the miner API port (4028). Check that:</p>
              <ul>
                <li>the miners are powered on and plugged into the network;</li>
                <li>this hashes.space server runs on a computer in the same local network as the miners;</li>
                <li>the miners are in another subnet? Add it with <code>SCAN_SUBNETS</code> on the server.</li>
              </ul>
              }
            </div>
          </div>
        }
      </section>

      @if (cpu) {
        <p class="fleet-hint">CPU rigs can join a fleet too: set them up here, then add their IP addresses under <a routerLink="/asic" fragment="fleet-title">Generate fleet on Find ASIC</a>.</p>
      } @else {
      <!-- the fleet: many miners by IP address -->
      <section class="s-card fleet" aria-labelledby="fleet-title">
        <div class="s-card-head">
          <div>
            <h2 id="fleet-title">Generate fleet</h2>
            <p>First set up every miner: click <b>Manage</b>, log in, and configure it until it shows <b>Connected</b>. Then paste their IP addresses (also miners in another subnet) and click Generate. You get a fleet dashboard with all of them: each miner's shares fly into the block being mined.</p>
          </div>
          @if (fleet()?.summary?.total) {
            <a class="btn" routerLink="/fleet">Open fleet dashboard</a>
          }
        </div>

        @if (fleet(); as f) {
          @if (f.summary.total) {
            <ul class="tally" aria-label="Fleet summary">
              <li><b>{{ f.summary.total }}</b> {{ f.summary.total === 1 ? 'miner' : 'miners' }}</li>
              <li class="hashing"><b>{{ f.summary.hashing }}</b> connected and hashing</li>
              <li class="not-submitting"><b>{{ f.summary.notSubmitting }}</b> not submitting shares</li>
              <li class="not-hashing"><b>{{ f.summary.notHashing }}</b> not hashing</li>
              @for (h of fleetHashrate(); track h.algo) {
                <li><b>{{ h.value }}</b> {{ h.algo }}</li>
              }
            </ul>
          }
        }

        <form class="add" (submit)="$event.preventDefault(); addToFleet(ipText())" novalidate>
          <label class="s-field name" for="fleet-name">Fleet name
            <input id="fleet-name" type="text" maxlength="60" autocomplete="off" [value]="fleet()?.name ?? 'My fleet'" (change)="rename($any($event.target).value)" />
          </label>
          <label class="s-field ips" for="fleet-ips">IP addresses
            <textarea id="fleet-ips" rows="3" spellcheck="false" autocomplete="off" placeholder="192.168.1.101, 192.168.1.102&#10;192.168.1.110-120"
              [value]="ipText()" (input)="setText($any($event.target).value)" aria-describedby="fleet-ips-help"></textarea>
            <span class="s-help" id="fleet-ips-help">
              @if (preview(); as pv) {
                <b>{{ readyCount() }} of {{ pv.ips.length }}</b> {{ pv.ips.length === 1 ? 'miner' : 'miners' }} ready
                @if (readyCount() < pv.ips.length) { · Manage the others first }
                @if (pv.duplicates.length) { · {{ pv.duplicates.length }} given twice }
                @if (pv.invalid.length) { · <span class="bad">not an IP: {{ invalidList(pv.invalid) }}</span> }
                @if (pv.ips.length > maxAdd) { · <span class="bad">add at most {{ maxAdd }} at a time</span> }
              } @else {
                Separate them with commas, spaces or new lines. A range like 192.168.1.110-120 adds every address in it.
              }
            </span>
          </label>

          @if (checks().length) {
            <!-- each miner's way into the fleet: 1 log in · 2 set up · ready -->
            <ol class="checks" aria-label="Miners for the fleet">
              @for (c of checks(); track c.ip) {
                <li [class]="c.step">
                  <span class="mark" aria-hidden="true">{{ c.step === 'ready' ? '✓' : c.step === 'login' ? '1' : '2' }}</span>
                  <span class="ip">{{ c.ip }}</span>
                  <span class="what">
                    @if (c.step === 'ready') { <b>Ready</b> · connected and hashing }
                    @else if (c.step === 'login') { <b>Log in first</b> · click Manage and log in to this miner }
                    @else { <b>Set it up</b> · {{ c.reason }} }
                  </span>
                  @if (!c.ready) {
                    <button type="button" class="btn small" (click)="c.step === 'login' ? connect(c.ip) : setUp(c.ip)" [attr.aria-label]="'Manage ' + c.ip">Manage</button>
                  }
                </li>
              }
            </ol>
          }

          <div class="add-actions">
            <button type="submit" class="btn primary" [disabled]="adding() || !canAdd()">{{ adding() ? 'Generating…' : 'Generate' }}</button>
            @if (foundNotInFleet().length) {
              <button type="button" class="btn" [disabled]="adding()" (click)="useFound()">Use the {{ foundNotInFleet().length }} found {{ foundNotInFleet().length === 1 ? 'miner' : 'miners' }}</button>
            }
            <p class="s-result" [class.ok]="addResult()?.ok" role="status">{{ addResult()?.text ?? '' }}</p>
          </div>
        </form>

        @if (fleet()?.miners?.length) {
          <ul class="list">
            @for (m of fleet()!.miners; track m.id) {
              <li [class]="'pick ' + m.status" [class.current]="current() === m.host" (click)="open(m.host!)" [title]="'Show ' + m.host + ' on the dashboard'">
                @if (m.cpu) {
                  <app-cpu class="fan" [status]="spinState(m.host!, m.status)" [cpu]="m.cpu" />
                } @else {
                  <app-fan class="fan" [status]="spinState(m.host!, m.status)" [hashrateThs]="m.status === 'not-hashing' ? 0 : m.hashrateThs" [nominalThs]="m.nominalThs" />
                }
                <div class="who">
                  <span class="ip">{{ m.host }}</span>
                  @if (m.cpu) {
                    <span class="model">{{ m.name !== m.host ? m.name + ' · ' : '' }}<b class="cores">{{ coresLine(m.cpu) }}</b> · {{ m.cpu.brand }}{{ m.algo ? ' · ' + socket.algoLabel(m.algo) : '' }}</span>
                  } @else {
                    <span class="model">{{ m.name !== m.host ? m.name + ' · ' : '' }}{{ m.model }}{{ m.algo ? ' · ' + socket.algoLabel(m.algo) : '' }}</span>
                  }
                </div>
                <div class="state">
                  <span class="chip">{{ statusLabel[m.status] }}</span>
                  <span class="why" [title]="m.statusReason">{{ m.statusReason }}</span>
                </div>
                <div class="go">
                  @if (socket.unlocked().has(m.host!)) {
                    <button type="button" class="btn connected" [class.not-submitting]="m.status === 'not-submitting'" [class.not-hashing]="m.status === 'not-hashing'"
                      (click)="$event.stopPropagation(); open(m.host!)" [title]="m.statusReason" [attr.aria-label]="barLabel(m.status) + ': ' + m.host + '. ' + m.statusReason + '. Show it on the dashboard'">{{ barLabel(m.status) }}</button>
                    <button type="button" class="btn primary" (click)="$event.stopPropagation(); manage(m.host!)" [attr.aria-label]="'Manage ' + m.host + ': Miner settings'">Manage</button>
                  } @else {
                    <button type="button" class="btn primary" [disabled]="!!connecting() || socket.connection() !== 'live'" (click)="$event.stopPropagation(); connect(m.host!)" [attr.aria-label]="'Manage ' + m.host">
                      {{ connecting() === m.host ? 'Connecting…' : 'Manage' }}
                    </button>
                  }
                  <button type="button" class="btn icon" (click)="$event.stopPropagation(); remove(m.host!)" [attr.aria-label]="'Remove ' + m.host + ' from the fleet'" title="Remove from the fleet">✕</button>
                </div>
              </li>
            }
          </ul>
        } @else if (fleet()) {
          <p class="meta">No miners in this fleet yet. Paste their IP addresses above.</p>
        }
      </section>
      }
    </main>
  `,
  styles: [
    `
      .fleet-hint { margin: 0; color: var(--muted); font-size: 13.5px; }
      .fleet-hint a { color: var(--link); }
      .cores { color: var(--text); font-weight: 600; }
      :host { display: block; }
      main { padding: 24px 20px 56px; max-width: 1100px; margin: 0 auto; display: grid; gap: 20px; }
      .fleet h2 { margin: 0 0 4px; font: 600 20px/1.2 var(--display); letter-spacing: 0.02em; }
      .tally { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; color: var(--muted); }
      .tally li { --state: var(--line-strong); display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; }
      .tally li b { color: var(--text); font: 600 13px/1 var(--mono); }
      .tally li.hashing, .list li.hashing { --state: var(--good); }
      .tally li.not-submitting, .list li.not-submitting { --state: var(--orange); }
      .tally li.not-hashing, .list li.not-hashing { --state: var(--bad); }
      .tally li:is(.hashing, .not-submitting, .not-hashing)::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--state); }
      .add { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 3fr); gap: 12px 16px; align-items: start; }
      .add textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 76px; font: 500 14px/1.45 var(--mono); color: var(--text); background: var(--bg); border: 1px solid var(--line-strong); border-radius: 6px; padding: 9px 11px; }
      .add textarea:focus { outline: none; border-color: var(--link); box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 22%, transparent); }
      .add textarea::placeholder { color: var(--muted-2); }
      .add .bad { color: var(--bad); }
      .add .s-help b { color: var(--text); }
      .add-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
      .add-actions .s-result { margin: 0; }
      .checks { grid-column: 1 / -1; list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
      .checks li { --state: var(--muted); display: grid; grid-template-columns: 22px auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); font-size: 13px; }
      .checks li.ready { --state: var(--good); }
      .checks li.setup { --state: var(--orange); }
      .checks li.login { --state: var(--link); }
      .checks .mark { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--state); color: var(--state); font: 700 11px/1 var(--sans); }
      .checks .ip { font: 500 14px/1.2 var(--mono); }
      .checks .what { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .checks .what b { color: var(--state); font-weight: 600; }
      .btn.small { padding: 6px 10px; font-size: 12px; min-width: 0; }
      .state { display: grid; gap: 4px; min-width: 0; }
      .chip { display: inline-flex; align-items: center; gap: 7px; font: 600 11.5px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--state); }
      .chip::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--state); flex: none; }
      .why { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .btn.icon { min-width: 0 !important; width: 38px; padding-inline: 0; color: var(--muted); }
      .btn.icon:hover { color: var(--bad); border-color: var(--bad); }
      h1 { margin: 0 0 4px; font: 600 22px/1.2 var(--display); letter-spacing: 0.02em; }
      .meta { margin: 0; color: var(--muted); font-size: 13px; }
      .err { margin: 0; color: var(--bad); font-size: 13px; }
      .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
      .list li {
        display: grid;
        grid-template-columns: auto minmax(0, 1.2fr) minmax(0, 1.6fr) auto;
        align-items: center;
        gap: 12px 18px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--bg);
      }
      .list li.pick { cursor: pointer; transition: border-color 0.15s, background 0.15s; }
      .list li.pick:hover { border-color: var(--line-strong); background: color-mix(in srgb, var(--link) 4%, var(--bg)); }
      /* the miner the dashboard shows */
      .list li.current, .list li.current:hover { border-color: var(--link); background: color-mix(in srgb, var(--link) 7%, var(--bg)); box-shadow: inset 3px 0 0 var(--link); }
      .fan { --fan-size: 40px; }
      .who { display: grid; gap: 3px; min-width: 0; }
      .ip { font: 500 16px/1.2 var(--mono); }
      .model { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      dl { margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
      dt { font: 500 10.5px/1 var(--sans); color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }
      dd { margin: 0; font: 500 13.5px/1.2 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .go { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
      .go { min-width: 274px; }
      .go .btn.connected { min-width: 158px; }
      .go .btn { min-width: 108px; text-align: center; }
      .go a.btn { text-decoration: none; }
      .btn.connected { cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: var(--good); border-color: var(--good); color: #06180d; }
      .btn.connected::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
      .btn.connected:hover { background: color-mix(in srgb, var(--good) 85%, #fff); border-color: var(--good); }
      .btn.connected:focus-visible { outline: 2px solid var(--good); outline-offset: 2px; }
      /* after logging in, the bar follows the miner's mode */
      .btn.connected.not-submitting { background: var(--orange); border-color: var(--orange); color: #1f1203; }
      .btn.connected.not-submitting:hover { background: color-mix(in srgb, var(--orange) 85%, #fff); border-color: var(--orange); }
      .btn.connected.not-hashing { background: var(--bad); border-color: var(--bad); color: #1a0505; }
      .btn.connected.not-hashing:hover { background: color-mix(in srgb, var(--bad) 85%, #fff); border-color: var(--bad); }
      .none { display: grid; grid-template-columns: auto 1fr; gap: 20px; align-items: start; padding: 20px; border: 1px dashed var(--line-strong); border-radius: 8px; --fan-size: 64px; }
      .none h2 { margin: 0 0 6px; font: 600 17px/1.2 var(--display); }
      .none p, .none ul { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.55; }
      .none ul { padding-left: 18px; margin-top: 4px; }
      code { font-family: var(--mono); color: var(--text); }
      @media (max-width: 720px) {
        main { padding-inline: 16px; }
        .list li { grid-template-columns: auto minmax(0, 1fr); }
        dl, .go { grid-column: 1 / -1; }
        .go { justify-content: flex-start; min-width: 0; }
        .none { grid-template-columns: 1fr; }
        .add { grid-template-columns: 1fr; }
        .state { grid-column: 1 / -1; }
        .checks li { grid-template-columns: 22px minmax(0, 1fr) auto; }
        .checks .what { grid-column: 2 / -1; grid-row: 2; white-space: normal; }
      }
    `,
  ],
})
export class AsicPage implements OnInit, OnDestroy {
  readonly socket = inject(FleetSocketService);
  /** Find CPU (route data kind: 'cpu') lists the CPU rigs (XMRig); Find ASIC everything else */
  readonly cpu = inject(ActivatedRoute).snapshot.data['kind'] === 'cpu';
  readonly xmrigPorts = 'port 18088 by default';
  private noteCpuHosts(): void {
    this.socket.cpuHosts.set(new Set((this.result()?.miners ?? []).filter((m) => m.kind === 'cpu' || !!m.cpu).map((m) => m.host!)));
  }
  readonly found = computed(() => (this.result()?.miners ?? []).filter((m) => (m.kind === 'cpu' || !!m.cpu) === this.cpu));
  private api = inject(FleetApiService);
  private router = inject(Router);

  readonly result = signal<ScanResult | null>(null);
  readonly scanning = signal(false);
  readonly error = signal<string | null>(null);
  readonly connecting = signal<string | null>(null);
  readonly current = computed(() => this.socket.miner()?.host ?? null);

  // ---- fleet ----
  readonly statusLabel = STATUS_SHORT;
  readonly maxAdd = MAX_FLEET_ADD;
  readonly fleet = signal<FleetView | null>(null);
  /** the pasted list survives going to Manage and back (kept in this browser) */
  readonly ipText = signal(readDraft());
  /** each listed miner's way into the fleet, checked by the backend */
  readonly checks = signal<FleetCheck[]>([]);
  readonly readyCount = computed(() => this.checks().filter((c) => c.ready).length);
  readonly adding = signal(false);
  readonly addResult = signal<{ ok: boolean; text: string } | null>(null);
  /** instant check of what was pasted (the backend checks again) */
  readonly preview = computed(() => (this.ipText().trim() ? parseIpList(this.ipText()) : null));
  /** Generate only when every listed miner is logged in to and connected and hashing */
  readonly canAdd = computed(() => {
    const p = this.preview();
    const c = this.checks();
    return !!p && p.ips.length > 0 && p.ips.length <= MAX_FLEET_ADD && c.length === p.ips.length && c.every((x) => x.ready);
  });
  private checkTimer?: ReturnType<typeof setTimeout>;
  /** miners the scan found that aren't in the fleet yet */
  readonly foundNotInFleet = computed(() => {
    const inFleet = new Set((this.fleet()?.miners ?? []).map((m) => m.host));
    return (this.result()?.miners ?? []).map((m) => m.ip).filter((ip) => !inFleet.has(ip));
  });
  /** fleet hashrate of the miners that are connected and hashing, per hash function */
  readonly fleetHashrate = computed(() =>
    Object.entries(this.fleet()?.summary.hashrateThs ?? {}).map(([algo, v]) => ({ algo: this.socket.algoLabel(algo), value: formatHashrate(v ?? 0) })),
  );
  // keep the bars live: the miners' modes (and the fleet) refresh every 5 s
  private fleetTimer = setInterval(() => {
    this.loadFleet();
    this.reloadScan();
    this.runCheck();
  }, 5000);

  constructor() {
    // once the chosen miner is open, or its login is asked for, go to the dashboard
    effect(() => {
      const host = this.socket.miner()?.host;
      const login = this.socket.loginRequired()?.host;
      const want = this.connecting();
      if (want && (host === want || login === want)) untracked(() => {
        this.connecting.set(null);
        this.router.navigateByUrl(login === want ? '/' : this.target); // the login form lives on the dashboard
      });
    });
    effect(() => {
      if (this.socket.watchError()) untracked(() => this.connecting.set(null));
    });
  }

  ngOnInit(): void {
    this.scan(false);
    this.loadFleet();
    this.runCheck();
  }

  ngOnDestroy(): void {
    clearInterval(this.fleetTimer);
  }

  async loadFleet(): Promise<void> {
    try {
      this.fleet.set(await this.api.getFleet());
    } catch {
      /* keep the last list */
    }
  }

  setText(text: string): void {
    this.ipText.set(text);
    writeDraft(text);
    this.addResult.set(null);
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => this.runCheck(), 300);
  }

  /** ask the backend which listed miners are ready (logged in + connected and hashing) */
  async runCheck(): Promise<void> {
    const text = this.ipText();
    if (!text.trim()) return this.checks.set([]);
    try {
      const r = await this.api.fleetCheck(text);
      if (text === this.ipText()) this.checks.set(r.checks);
    } catch {
      /* keep the last checks */
    }
  }

  /** a logged-in miner that isn't connected and hashing yet: open it, then Miner settings */
  setUp(ip: string): void {
    this.manage(ip);
  }

  async addToFleet(text: string): Promise<void> {
    this.adding.set(true);
    this.addResult.set(null);
    try {
      const r = await this.api.addToFleet(text);
      this.fleet.set(r.fleet);
      const parts = [
        r.added.length && `Added ${r.added.length} ${r.added.length === 1 ? 'miner' : 'miners'}.`,
        r.already.length && `${r.already.length} already in the fleet.`,
        r.invalid.length && `Skipped (not an IP): ${this.invalidList(r.invalid)}.`,
      ].filter(Boolean);
      this.addResult.set({ ok: r.added.length > 0, text: parts.join(' ') || 'Nothing to add.' });
      if (r.added.length || r.already.length) {
        this.setText('');
        this.router.navigateByUrl('/fleet'); // Generate: open the new fleet dashboard
      }
    } catch (e) {
      this.addResult.set({ ok: false, text: (e as Error).message });
    } finally {
      this.adding.set(false);
    }
  }

  /** put the found miners' IP addresses in the box, ready to Generate */
  useFound(): void {
    const current = this.ipText().trim();
    this.setText([current, this.foundNotInFleet().join(', ')].filter(Boolean).join('\n'));
  }

  async remove(ip: string): Promise<void> {
    try {
      this.fleet.set(await this.api.removeFromFleet(ip));
    } catch (e) {
      this.addResult.set({ ok: false, text: (e as Error).message });
    }
  }

  async rename(name: string): Promise<void> {
    try {
      this.fleet.set(await this.api.renameFleet(name));
    } catch {
      /* keep the old name */
    }
  }

  invalidList(list: { entry: string }[]): string {
    const shown = list.slice(0, 4).map((i) => i.entry).join(', ');
    return list.length > 4 ? `${shown} and ${list.length - 4} more` : shown;
  }

  /** the bar of a miner you're logged in to follows its mode */
  barLabel(status?: string): string {
    return status === 'not-submitting' ? 'Not submitting' : status === 'not-hashing' ? 'Not hashing' : 'Connected';
  }

  /** fresh modes for the found miners, without scanning the network again (the backend reuses its scan) */
  private async reloadScan(): Promise<void> {
    if (this.scanning() || !this.result()) return;
    try {
      this.result.set(await this.api.scan(false));
      this.noteCpuHosts();
    } catch {
      /* keep the last list */
    }
  }

  async scan(refresh: boolean): Promise<void> {
    this.scanning.set(true);
    this.error.set(null);
    try {
      this.result.set(await this.api.scan(refresh));
      this.noteCpuHosts();
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.scanning.set(false);
    }
  }

  /** where to go once the miner is open: the dashboard, or Miner settings (Manage after login) */
  private target = '/';

  connect(ip: string, target = '/'): void {
    this.target = target;
    this.connecting.set(ip);
    this.socket.watch(ip);
  }

  /** click a row (or its status bar): show that miner on the dashboard; asks for its login first when needed */
  /** a fan only spins after you managed the miner here (logged in) and it is configured correctly (connected and hashing) */
  spinState(ip: string, status?: MinerStatus): MinerStatus {
    return this.socket.unlocked().has(ip) ? (status ?? 'not-hashing') : 'not-hashing';
  }

  /** "16 cores · 32 threads" for a CPU miner */
  coresLine(c: CpuInfo): string {
    return cpuLine(c);
  }

  open(ip: string): void {
    if (this.current() === ip) this.router.navigateByUrl('/');
    else this.connect(ip);
  }

  /** Manage after logging in: that miner's Miner settings */
  manage(ip: string): void {
    this.target = '/settings';
    if (this.current() === ip) this.router.navigateByUrl('/settings');
    else this.connect(ip, '/settings');
  }

  pool(url?: string): string {
    return url ? url.replace(/^stratum\+(tcp|ssl|tls):\/\//, '') : 'No pool set up';
  }

  ago(t: number): string {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 5 ? 'just now' : `${s} s ago`;
  }
}

/** the pasted IP list, kept in this browser while you Manage the miners (a convenience: it may be empty) */
function readDraft(): string {
  try {
    return localStorage.getItem('fleet-draft') ?? '';
  } catch {
    return '';
  }
}

function writeDraft(text: string): void {
  try {
    if (text.trim()) localStorage.setItem('fleet-draft', text);
    else localStorage.removeItem('fleet-draft');
  } catch {
    /* storage unavailable */
  }
}
