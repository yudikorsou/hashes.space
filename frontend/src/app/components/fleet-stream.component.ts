import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild, inject, input } from '@angular/core';
import { Subscription } from 'rxjs';
import { FleetSocketService } from '../services/fleet-socket.service';
import { ShareStreamRenderer } from '../lib/share-stream-renderer';
import { shareBits } from '../lib/format';

/**
 * Fleet dashboard overlay: shares of every fleet miner fly from its tile's fan
 * ([data-fleet-fan="<id>"]) into the block being mined (#mining-block).
 *
 * Scaled to the size of the fleet so the page stays clean:
 *   - smaller glyphs and shorter strings as the fleet grows
 *   - each miner launches at most one string every so often
 *   - at most a few new strings per second for the whole fleet
 * Shares that are skipped still count: the block pulses for each one that lands.
 */
@Component({
  selector: 'app-fleet-stream',
  standalone: true,
  template: `<canvas #canvas aria-hidden="true"></canvas>`,
  styles: [`canvas { position: fixed; inset: 0; pointer-events: none; z-index: 50; }`],
})
export class FleetStreamComponent implements AfterViewInit, OnDestroy {
  /** number of miners in the fleet: sets the scale of the animation */
  readonly size = input(1);
  @ViewChild('canvas') canvas!: ElementRef<HTMLCanvasElement>;
  private socket = inject(FleetSocketService);
  private zone = inject(NgZone);
  private renderer?: ShareStreamRenderer;
  private rendererFor = 0;
  private sub?: Subscription;
  private lastLaunch = new Map<string, number>();
  private recent: number[] = [];
  private onResize = () => this.renderer?.resize();

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      window.addEventListener('resize', this.onResize);
      this.sub = this.socket.fleetShares$.subscribe((shares) => {
        if (document.hidden) return;
        shares.forEach((s, i) => setTimeout(() => this.launch(s.minerId, s.hash, s.accepted), i * 90));
      });
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.renderer?.destroy();
    window.removeEventListener('resize', this.onResize);
  }

  /** glyph size, string length and pace for a fleet of n miners */
  private scale(n: number) {
    if (n <= 4) return { font: 11, spacing: 10, zeros: 18, tail: 8, perMinerMs: 900, perSecond: 6 };
    if (n <= 12) return { font: 10, spacing: 9, zeros: 12, tail: 6, perMinerMs: 1800, perSecond: 5 };
    return { font: 9, spacing: 8, zeros: 8, tail: 4, perMinerMs: Math.min(8000, n * 220), perSecond: 4 };
  }

  private ensureRenderer(n: number): ShareStreamRenderer {
    const bucket = n <= 4 ? 1 : n <= 12 ? 2 : 3;
    if (!this.renderer || this.rendererFor !== bucket) {
      this.renderer?.destroy();
      const sc = this.scale(n);
      this.renderer = new ShareStreamRenderer(this.canvas.nativeElement, { font: `600 ${sc.font}px "IBM Plex Mono", ui-monospace, monospace`, spacing: sc.spacing }, 24 + sc.perSecond * 4);
      this.rendererFor = bucket;
    }
    return this.renderer;
  }

  private launch(minerId: string, hash: string, accepted: boolean): void {
    const fan = document.querySelector<HTMLElement>(`[data-fleet-fan="${CSS.escape(minerId)}"]`);
    const block = document.getElementById('mining-block');
    if (!fan || !block) return;
    const pulse = () => block.dispatchEvent(new CustomEvent('share-arrived', { bubbles: true }));

    const n = Math.max(1, this.size());
    const sc = this.scale(n);
    const now = performance.now();
    this.recent = this.recent.filter((t) => now - t < 1000);
    const tooSoon = now - (this.lastLaunch.get(minerId) ?? -Infinity) < sc.perMinerMs;
    if (tooSoon || this.recent.length >= sc.perSecond) {
      pulse(); // the share still reaches the block, just without its own string
      return;
    }
    this.lastLaunch.set(minerId, now);
    this.recent.push(now);

    const f = fan.getBoundingClientRect();
    const target = () => {
      const r = block.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
    };
    this.ensureRenderer(n).launch({ x: f.left + f.width / 2, y: f.top + f.height / 2 }, target, shareBits(hash, sc.zeros, sc.tail), { accepted, onArrive: pulse });
  }
}
