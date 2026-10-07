import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CpuInfo, MinerStatus } from '../models';

/**
 * A CPU miner (XMRig) instead of an ASIC fan: a processor chip with one square per
 * hardware thread, grouped per core. Every thread the miner runs on lights up; the
 * lit threads only pulse while the miner is connected and hashing, like the fan of
 * an ASIC only spins then. Shows at a glance how many cores the miner keeps busy.
 */
@Component({
  selector: 'app-cpu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 100 100" [attr.class]="'cpu ' + status()" role="img" [attr.aria-label]="label()">
      <g class="pins">
        @for (p of pins; track p) {
          <rect [attr.x]="p" y="3" width="3" height="9" rx="1" />
          <rect [attr.x]="p" y="88" width="3" height="9" rx="1" />
          <rect x="3" [attr.y]="p" width="9" height="3" rx="1" />
          <rect x="88" [attr.y]="p" width="9" height="3" rx="1" />
        }
      </g>
      <rect class="die" x="12" y="12" width="76" height="76" rx="7" />
      @for (c of cells(); track c.i) {
        <rect [attr.class]="'core' + (c.on ? ' on' : '')" [attr.x]="c.x" [attr.y]="c.y" [attr.width]="c.s" [attr.height]="c.s" rx="1.2"
          [style.animation-delay]="c.delay" />
      }
    </svg>
  `,
  styles: [
    `
      :host { display: block; width: var(--fan-size, 64px); aspect-ratio: 1; }
      svg { width: 100%; height: 100%; overflow: visible; }
      .pins rect { fill: #ffffff; opacity: 0.85; }
      .die { fill: none; stroke: #ffffff; stroke-width: 3.2; }
      .core { fill: #ffffff; opacity: 0.16; }
      .core.on { opacity: 0.55; }
      .cpu.hashing .core.on { fill: var(--matrix, #3ce26b); opacity: 1; animation: work 1.1s ease-in-out infinite; }
      .cpu.hashing { filter: drop-shadow(0 0 6px rgba(60, 226, 107, 0.35)); }
      @keyframes work { 50% { opacity: 0.45; } }
      @media (prefers-reduced-motion: reduce) { .cpu.hashing .core.on { animation: none; } }
    `,
  ],
})
export class CpuComponent {
  readonly status = input<MinerStatus>('not-hashing');
  readonly cpu = input<CpuInfo | undefined>(undefined);

  readonly pins = [22, 34, 46, 58, 70];

  readonly label = computed(() => {
    const c = this.cpu();
    return c ? `${c.brand}: ${c.cores} cores, ${c.threads} threads, ${c.miningThreads} mining` : 'CPU miner';
  });

  /** one square per thread on a near-square grid inside the die */
  readonly cells = computed(() => {
    const c = this.cpu();
    const n = Math.max(1, Math.min(256, c?.threads || c?.cores || 1));
    const mining = Math.min(n, c?.miningThreads ?? 0);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const inner = 60;
    const gap = Math.max(1, 6 - cols * 0.4);
    const s = Math.min((inner - gap * (cols - 1)) / cols, (inner - gap * (rows - 1)) / rows);
    const x0 = 50 - (cols * s + (cols - 1) * gap) / 2;
    const y0 = 50 - (rows * s + (rows - 1) * gap) / 2;
    return Array.from({ length: n }, (_, i) => ({
      i,
      x: x0 + (i % cols) * (s + gap),
      y: y0 + Math.floor(i / cols) * (s + gap),
      s,
      on: i < mining,
      delay: `${((i * 137) % 1100) / 1000}s`,
    }));
  });
}
