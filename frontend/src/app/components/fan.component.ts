import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MinerStatus } from '../models';

/**
 * The miner's fan icon (frame + 4 mounting holes stay still, rotor spins).
 * Spin speed follows the miner's hashrate relative to its nominal hashrate.
 * The fan is always white; the status colour is shown in the card's label.
 *   hashing         → spinning, soft glow (hashing for the right blockchain and your node accepts its shares)
 *   not-submitting  → stopped             (it hashes, but no useful shares reach your node)
 *   not-hashing     → stopped
 * The fan only spins while the miner is correctly hashing and submitting shares.
 */
@Component({
  selector: 'app-fan',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 100 100" [attr.class]="'fan ' + status()" role="img" [attr.aria-label]="'Fan, ' + status()">
      <g class="frame">
        <circle cx="50" cy="50" r="40" stroke-width="4.2" />
        <circle cx="12" cy="12" r="4.6" stroke-width="3" />
        <circle cx="88" cy="12" r="4.6" stroke-width="3" />
        <circle cx="12" cy="88" r="4.6" stroke-width="3" />
        <circle cx="88" cy="88" r="4.6" stroke-width="3" />
      </g>
      <g class="rotor" [class.still]="!spin()" [style.animation-duration]="duration()">
        <g transform="translate(50 50)">
          @for (a of blades; track a) {
            <path [attr.transform]="'rotate(' + a + ')'" d="M -4.5,-8.5 C -10,-17 -9,-27 -1.5,-35.5 Q 12,-34 17.5,-24.5 C 10,-22 6,-16 5,-9" />
          }
          <circle r="10.5" class="hub" />
          <polygon class="hub-cut" points="0,-5.6 5.3,-1.7 3.3,4.5 -3.3,4.5 -5.3,-1.7" />
        </g>
      </g>
    </svg>
  `,
  styles: [
    `
      :host { display: block; width: var(--fan-size, 64px); aspect-ratio: 1; }
      svg { width: 100%; height: 100%; overflow: visible; }
      .frame circle, .rotor path { fill: none; stroke: var(--fan-color); stroke-linejoin: round; stroke-linecap: round; }
      .rotor path { stroke-width: 2.8; }
      .hub { fill: var(--fan-color); }
      .hub-cut { fill: var(--surface, #1d1f31); }
      .rotor {
        transform-box: view-box;
        transform-origin: 50px 50px;
        animation: spin linear infinite;
        animation-play-state: running;
      }
      .fan { --fan-color: #ffffff; transition: filter 0.4s; }
      .fan.hashing { filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.45)); }
      .fan:not(.hashing) .rotor { animation: none; }
      .rotor.still { animation: none; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .rotor { animation: none; } }
    `,
  ],
})
export class FanComponent {
  readonly status = input<MinerStatus>('not-hashing');
  readonly hashrateThs = input(0);
  readonly nominalThs = input(0);
  /** false = static icon (e.g. the logo in the header) */
  readonly spin = input(true);

  readonly blades = [0, 72, 144, 216, 288];

  /** seconds per revolution */
  readonly duration = computed(() => {
    switch (this.status()) {
      case 'hashing': {
        const ratio = this.nominalThs() ? this.hashrateThs() / this.nominalThs() : 1;
        return `${(0.55 / Math.max(0.2, Math.min(1.2, ratio))).toFixed(2)}s`;
      }
      default:
        return '0s'; // not submitting or not hashing: the fan stands still
    }
  });
}
