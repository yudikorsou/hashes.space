import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FleetApiService } from '../services/fleet-api.service';
import { Miner } from '../models';
import { formatHashrate } from '../lib/format';
import { Point, chartGeometry, hashrateHealth } from '../lib/hashrate-health';

type Range = 'live' | '1h' | '24h';
const RANGE_LABEL: Record<Range, string> = { live: '5 minutes', '1h': 'hour', '24h': '24 hours' };
const RANGE_BUTTON: Record<Range, string> = { live: 'Live', '1h': '1 hour', '24h': '24 hours' };
/** how often the chart asks for new data */
const REFRESH_MS: Record<Range, number> = { live: 3_000, '1h': 15_000, '24h': 60_000 };
/** time labels on round minutes / hours */
const TICK_MS: Record<Range, number> = { live: 60_000, '1h': 10 * 60_000, '24h': 4 * 3_600_000 };
const HEIGHT = 230;

const axisUnit = (v: number) => (v === 0 ? '0' : v >= 1000 ? `${+(v / 1000).toFixed(2)} PH/s` : v < 1 ? `${+(v * 1000).toFixed(0)} GH/s` : `${+v.toFixed(2)} TH/s`);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const clockSec = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Hashrate health: the connected miner's hashrate, live (last 5 minutes,
 * updated every few seconds), over the last hour or over the day. Two lines:
 *   reported   what the miner says it hashes
 *   submitted  the hashrate proven by the shares that reached your node
 * plus the rated hashrate, like the hashrate graph on a miner's manage page.
 * The badge sums it up: Healthy, Below rated, Unstable, Not reaching your node,
 * Low hashrate or Not hashing.
 */
@Component({
  selector: 'app-hashrate-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="hr-title">
      <header>
        <div>
          <h2 id="hr-title">Hashrate health</h2>
          <p class="health" [class]="'health ' + health().level">
            <span class="icon" aria-hidden="true">{{ icon() }}</span>
            <b>{{ health().label }}</b>
            <span>{{ health().detail }}</span>
          </p>
        </div>
        <div class="ranges" role="group" aria-label="Time range">
          @for (r of ranges; track r) {
            <button type="button" [class.on]="range() === r" [attr.aria-pressed]="range() === r" (click)="range.set(r)">
              @if (r === 'live') { <span class="pulse" aria-hidden="true"></span> }
              {{ rangeButton[r] }}
            </button>
          }
        </div>
      </header>

      <dl class="stats">
        <div><dt><span class="key rep" aria-hidden="true"></span>Reported now</dt><dd>{{ fmt(nowThs()) }}</dd></div>
        <div><dt><span class="key sub" aria-hidden="true"></span>Submitted now</dt><dd>{{ health().level === 'none' ? '–' : fmt(health().submittedNow) }}</dd></div>
        <div><dt>Average</dt><dd>{{ health().level === 'none' ? '–' : fmt(health().avg) }}</dd></div>
        <div><dt>Rated</dt><dd>{{ miner().nominalThs ? fmt(miner().nominalThs) : '–' }}</dd></div>
        <div><dt>Uptime</dt><dd>{{ health().level === 'none' ? '–' : health().uptimePct + ' %' }}</dd></div>
      </dl>

      <ul class="legend" aria-label="Chart lines">
        <li><span class="key rep"></span>Reported by the miner</li>
        <li><span class="key sub"></span><span>Submitted to your node <small>(from shares, {{ windowLabel() }} average)</small></span></li>
        @if (miner().nominalThs) { <li><span class="key rated"></span>Rated</li> }
      </ul>

      <div class="plot" [class.loading]="loading()">
        <svg [attr.viewBox]="'0 0 ' + width() + ' ' + height" [attr.width]="width()" [attr.height]="height" role="img"
          [attr.aria-label]="'Hashrate over the last ' + rangeLabel() + '. ' + health().label + '. ' + health().detail"
          tabindex="0" (pointermove)="hover($event)" (pointerleave)="hi.set(-1)" (keydown)="key($event)" (blur)="hi.set(-1)">
          <defs>
            <linearGradient id="hr-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style="stop-color: var(--hr-rep); stop-opacity: 0.2" />
              <stop offset="1" style="stop-color: var(--hr-rep); stop-opacity: 0" />
            </linearGradient>
          </defs>
          @for (t of geo().yTicks; track t.label) {
            <line class="grid" [attr.x1]="geo().left" [attr.x2]="geo().right" [attr.y1]="t.y" [attr.y2]="t.y" />
            <text class="ytick" [attr.x]="geo().left - 8" [attr.y]="t.y + 4">{{ t.label }}</text>
          }
          @for (t of geo().xTicks; track t.x) {
            <text class="xtick" [attr.x]="t.x" [attr.y]="height - 6">{{ t.label }}</text>
          }
          @if (geo().ratedY !== null) {
            <line class="rated" [attr.x1]="geo().left" [attr.x2]="geo().right" [attr.y1]="geo().ratedY" [attr.y2]="geo().ratedY" />
          }
          <path class="area" [attr.d]="geo().area" fill="url(#hr-fill)" />
          <path class="line rep" [attr.d]="geo().line" />
          <path class="line sub" [attr.d]="geo().line2" />
          @if (range() === 'live' && lastPoint(); as lp) {
            <circle class="live-dot" [attr.cx]="lp.x" [attr.cy]="lp.y" r="4" />
          }
          @if (hiPoint(); as p) {
            <line class="cross" [attr.x1]="p.x" [attr.x2]="p.x" [attr.y1]="geo().top" [attr.y2]="geo().bottom" />
            @if (p.rep !== null) { <circle class="dot rep" [attr.cx]="p.x" [attr.cy]="geo().y(p.rep)" r="4.5" /> }
            @if (p.sub !== null) { <circle class="dot sub" [attr.cx]="p.x" [attr.cy]="geo().y(p.sub)" r="4.5" /> }
          }
        </svg>
        @if (hiPoint(); as p) {
          <div class="tip" [style.left.px]="p.x" [class.flip]="p.x > width() - 190">
            <span class="when">{{ p.label }}</span>
            @if (p.rep === null) {
              <span>No reading</span>
            } @else {
              <span class="row"><span class="key rep"></span><b>{{ fmt(p.rep) }}</b> reported</span>
              <span class="row"><span class="key sub"></span><b>{{ fmt(p.sub ?? 0) }}</b> submitted</span>
            }
          </div>
        }
      </div>

      <table class="sr-only">
        <caption>Hashrate over the last {{ rangeLabel() }}</caption>
        <tr><th scope="col">Time</th><th scope="col">Reported</th><th scope="col">Submitted to your node</th></tr>
        @for (p of points(); track p[0]) {
          <tr><td>{{ clock(p[0]) }}</td><td>{{ p[1] === null ? 'no reading' : fmt(p[1]) }}</td><td>{{ p[2] === null ? '–' : fmt(p[2]) }}</td></tr>
        }
      </table>
    </section>
  `,
  styles: [
    `
      :host { display: block; --hr-rep: #0ba5bf; --hr-sub: #a26bf5; }
      .card { padding: 20px 24px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; display: grid; gap: 14px; }
      header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 10px 20px; }
      h2 { margin: 0 0 6px; font: 600 18px/1.2 var(--display); letter-spacing: 0.02em; }
      .health { --state: var(--muted); margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 13.5px; color: var(--muted); }
      .health b { color: var(--state); font: 600 12px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.07em; }
      .health .icon { color: var(--state); font-weight: 700; width: 12px; text-align: center; }
      .health.good { --state: var(--good); }
      .health.warn { --state: var(--warn); }
      .health.bad { --state: var(--bad); }
      .ranges { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 6px; overflow: hidden; }
      .ranges button { display: inline-flex; align-items: center; gap: 6px; font: 600 12.5px/1 var(--sans); color: var(--muted); background: transparent; border: 0; padding: 8px 12px; cursor: pointer; }
      .ranges button + button { border-left: 1px solid var(--line-strong); }
      .ranges button.on { color: var(--text); background: var(--line); }
      .ranges button:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
      .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--bad); animation: pulse 1.6s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: 0.3; } }
      .stats { margin: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
      dt { display: flex; align-items: center; gap: 6px; font: 500 10.5px/1 var(--sans); color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }
      dd { margin: 0; font: 500 15px/1.2 var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .key { display: inline-block; width: 14px; height: 2px; border-radius: 1px; flex: none; }
      .key.rep { background: var(--hr-rep); }
      .key.sub { background: var(--hr-sub); }
      .key.rated { background: var(--muted); opacity: 0.7; height: 1px; }
      .legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.5px; color: var(--muted); }
      .legend li { display: inline-flex; align-items: center; gap: 7px; }
      .legend small { font-size: 11.5px; opacity: 0.8; }
      .plot { position: relative; min-width: 0; transition: opacity 0.2s; }
      .plot.loading { opacity: 0.55; }
      svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: pan-y; }
      svg:focus-visible { outline: 2px solid var(--link); outline-offset: 4px; border-radius: 4px; }
      .grid { stroke: var(--line); stroke-width: 1; }
      .ytick, .xtick { font: 400 11px var(--mono); fill: var(--muted); }
      .ytick { text-anchor: end; }
      .xtick { text-anchor: middle; }
      .rated { stroke: var(--muted); stroke-width: 1; opacity: 0.7; }
      .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
      .line.rep { stroke: var(--hr-rep); }
      .line.sub { stroke: var(--hr-sub); }
      .live-dot { fill: var(--hr-rep); stroke: var(--surface); stroke-width: 2; animation: pulse 1.6s ease-in-out infinite; }
      .cross { stroke: var(--muted); stroke-width: 1; }
      .dot { stroke: var(--surface); stroke-width: 2; }
      .dot.rep { fill: var(--hr-rep); }
      .dot.sub { fill: var(--hr-sub); }
      .tip { position: absolute; top: 4px; transform: translateX(10px); pointer-events: none; display: grid; gap: 4px; padding: 8px 10px; background: var(--bg); border: 1px solid var(--line-strong); border-radius: 6px; white-space: nowrap; font-size: 12px; color: var(--muted); }
      .tip.flip { transform: translateX(calc(-100% - 10px)); }
      .tip .row { display: flex; align-items: center; gap: 7px; }
      .tip b { font: 600 13.5px/1.2 var(--mono); color: var(--text); }
      @media (prefers-reduced-motion: reduce) { .pulse, .live-dot { animation: none; } }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      @media (max-width: 720px) {
        .card { padding: 16px; }
        .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    `,
  ],
})
export class HashrateChartComponent implements AfterViewInit, OnDestroy {
  readonly miner = input.required<Miner>();
  private api = inject(FleetApiService);
  private host = inject(ElementRef<HTMLElement>);

  readonly ranges: Range[] = ['live', '1h', '24h'];
  readonly rangeButton = RANGE_BUTTON;
  readonly range = signal<Range>('live');
  readonly points = signal<Point[]>([]);
  readonly windowMs = signal(60_000);
  readonly loading = signal(false);
  readonly width = signal(640);
  readonly hi = signal(-1);
  readonly height = HEIGHT;
  readonly clock = clock;

  private minerId = computed(() => this.miner().id);
  private timer?: ReturnType<typeof setInterval>;
  private ro?: ResizeObserver;

  /** 0 while the miner can't hash here (e.g. on the other blockchain network) */
  readonly nowThs = computed(() => (this.miner().status === 'not-hashing' ? 0 : this.miner().hashrateThs));
  readonly rangeLabel = computed(() => RANGE_LABEL[this.range()]);
  readonly windowLabel = computed(() => `${Math.round(this.windowMs() / 60_000)} min`);
  readonly health = computed(() => hashrateHealth(this.points(), this.miner().nominalThs, this.nowThs(), this.rangeLabel(), this.miner().status === 'not-hashing' ? this.miner().statusReason : undefined));
  readonly icon = computed(() => ({ good: '✓', warn: '!', bad: '✕', none: '·' })[this.health().level]);
  readonly geo = computed(() => chartGeometry(this.points(), this.miner().nominalThs, this.width(), HEIGHT, axisUnit, clock, TICK_MS[this.range()]));
  /** the newest reading, marked with a pulsing dot in Live */
  readonly lastPoint = computed(() => {
    const pts = this.points();
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i][1] !== null) return { x: this.geo().x(i), y: this.geo().y(pts[i][1]!) };
    return null;
  });
  readonly hiPoint = computed(() => {
    const i = this.hi(), p = this.points()[i];
    if (!p) return null;
    const r = this.range();
    const label = r === 'live' ? clockSec(p[0]) : r === '1h' ? clock(p[0]) : new Date(p[0]).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return { x: this.geo().x(i), rep: p[1], sub: p[2], label };
  });

  constructor() {
    // reload when another miner is connected or the range changes, then keep it fresh
    effect(() => {
      const id = this.minerId();
      const r = this.range();
      untracked(() => {
        this.hi.set(-1);
        this.load(id, r, true);
        clearInterval(this.timer);
        this.timer = setInterval(() => this.load(id, r, false), REFRESH_MS[r]);
      });
    });
  }

  ngAfterViewInit(): void {
    const el = this.host.nativeElement.querySelector('.plot') as HTMLElement;
    this.ro = new ResizeObserver(() => this.width.set(Math.max(280, Math.round(el.clientWidth))));
    this.ro.observe(el);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
    this.ro?.disconnect();
  }

  fmt(v: number): string {
    return formatHashrate(v);
  }

  /** crosshair: snap to the nearest time bucket */
  hover(e: PointerEvent): void {
    const svg = e.currentTarget as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    const g = this.geo();
    const px = ((e.clientX - r.left) / r.width) * this.width();
    const n = this.points().length;
    if (!n) return;
    this.hi.set(Math.max(0, Math.min(n - 1, Math.round(((px - g.left) / (g.right - g.left)) * (n - 1)))));
  }

  key(e: KeyboardEvent): void {
    const n = this.points().length;
    if (!n || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = this.hi() < 0 ? n - 1 : this.hi();
    this.hi.set(e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1))));
  }

  private async load(id: string, r: Range, switched: boolean): Promise<void> {
    // switching miner or range: dim the old chart until the new one arrives (no flash)
    if (switched) this.loading.set(this.points().length > 0);
    try {
      const res = await this.api.hashrate(id, r);
      if (id === this.minerId() && r === this.range()) {
        this.points.set(res.points);
        this.windowMs.set(res.windowMs);
      }
    } catch {
      /* keep the last chart */
    } finally {
      this.loading.set(false);
    }
  }
}
