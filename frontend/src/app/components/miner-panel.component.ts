import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Miner, NetworkInfo } from '../models';
import { FanComponent } from './fan.component';
import { formatAgo, formatDiff, formatHashrate } from '../lib/format';
import { STATUS_LABEL } from '../lib/status';

/**
 * The connected miner, shown in one of its three modes:
 *   hashing (green) · not-submitting (orange) · not-hashing (red, fan stopped,
 *   label links to Miner settings).
 */
@Component({
  selector: 'app-miner-panel',
  standalone: true,
  imports: [FanComponent, DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article [class]="'panel ' + miner().status">
      <!-- data-fan is the launch point for this miner's share streams -->
      <app-fan
        class="big-fan"
        [attr.data-fan]="miner().id"
        [status]="miner().status"
        [hashrateThs]="effectiveThs()"
        [nominalThs]="miner().nominalThs"
      />

      <div class="body">
        <header>
          <div class="id">
            <h2>{{ miner().name }}</h2>
            <p><span class="ip">{{ miner().host }}</span> · {{ miner().model }}</p>
          </div>
          @if (miner().status === 'not-hashing') {
            <a class="chip" [routerLink]="['/settings']">{{ label() }}</a>
          } @else {
            <span class="chip">{{ label() }}</span>
          }
        </header>
        <p class="reason">{{ miner().statusReason }}
          @if ((miner().locateUntil ?? 0) > now()) { <span class="locate">· LED blinking</span> }
        </p>

        <dl>
          <div><dt>Hashrate</dt><dd>{{ hashrate() }}</dd></div>
          <div><dt>Chip temp</dt><dd>{{ miner().temperatureC ? miner().temperatureC + ' °C' : '–' }}</dd></div>
          <div><dt>Fan</dt><dd>{{ miner().fanRpm ? (miner().fanRpm | number) + ' rpm' : '–' }}</dd></div>
          <div><dt>Shares to your node</dt><dd>{{ miner().sharesAccepted | number }} <small>/ {{ miner().sharesRejected }} rej</small></dd></div>
          <div><dt>Last share</dt><dd>{{ lastShare() }}</dd></div>
          <div><dt>Best diff</dt><dd>{{ bestDiff() }}</dd></div>
        </dl>

        <footer>
          <span [title]="miner().poolUrl ?? ''">{{ poolHost() }}</span>
          <a [routerLink]="['/settings']">Miner settings</a>
        </footer>
      </div>
    </article>
  `,
  styles: [
    `
      :host { display: block; }
      .panel {
        --state: var(--good);
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 28px;
        align-items: center;
        padding: 24px;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      .panel.not-submitting { --state: var(--orange); }
      .panel.not-hashing { --state: var(--bad); }
      .panel.not-hashing dd { color: var(--muted); }
      .big-fan { --fan-size: 150px; }
      .body { display: grid; gap: 14px; min-width: 0; }
      header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 10px 20px; }
      h2 { margin: 0 0 4px; font: 600 24px/1.1 var(--display); letter-spacing: 0.02em; }
      .id p { margin: 0; color: var(--muted); font-size: 13.5px; }
      .ip { font-family: var(--mono); color: var(--text); }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font: 600 12px/1 var(--sans);
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: var(--state);
        padding: 8px 12px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--state) 12%, transparent);
      }
      .chip::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--state); flex: none; }
      a.chip { text-decoration: underline; text-underline-offset: 3px; }
      a.chip:focus-visible, footer a:focus-visible { outline: 2px solid var(--state); outline-offset: 3px; }
      .reason { margin: 0; color: var(--muted); font-size: 13.5px; }
      .locate { color: var(--warn); font-weight: 600; }
      dl { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 14px 12px; }
      dt { font: 500 10.5px/1 var(--sans); color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }
      dd { margin: 0; font: 500 15px/1.2 var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
      dd small { color: var(--muted); font-size: 11.5px; }
      footer { display: flex; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); font: 400 12px/1.2 var(--mono); color: var(--muted); }
      footer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      footer a { color: var(--link); text-decoration: none; white-space: nowrap; font-family: var(--sans); font-size: 13px; }
      footer a:hover { text-decoration: underline; }
      @media (max-width: 640px) {
        .panel { grid-template-columns: 1fr; justify-items: center; padding: 18px; }
        .body { width: 100%; }
        .big-fan { --fan-size: 110px; }
      }
    `,
  ],
})
export class MinerPanelComponent {
  readonly miner = input.required<Miner>();
  /** bumps every second from the parent so "x s ago" stays fresh */
  readonly now = input(Date.now());
  /** the blockchain stream the page shows */
  readonly network = input<NetworkInfo | null>(null);

  readonly label = computed(() => STATUS_LABEL[this.miner().status]);
  /** a miner that can't hash here (wrong blockchain network, offline, …) does no useful work: show 0 */
  readonly effectiveThs = computed(() => (this.miner().status === 'not-hashing' ? 0 : this.miner().hashrateThs));
  readonly hashrate = computed(() => formatHashrate(this.effectiveThs()));
  readonly bestDiff = computed(() => (this.miner().bestShareDiff ? formatDiff(this.miner().bestShareDiff) : '–'));
  readonly lastShare = computed(() => formatAgo(this.miner().lastShareAt, this.now()));
  readonly poolHost = computed(() => {
    const url = this.miner().poolUrl;
    return url ? url.replace(/^stratum\+(tcp|ssl|tls):\/\//, '') : 'no pool set up';
  });
}
