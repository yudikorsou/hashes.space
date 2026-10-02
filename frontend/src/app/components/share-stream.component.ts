import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { FleetSocketService } from '../services/fleet-socket.service';
import { ShareStreamRenderer } from '../lib/share-stream-renderer';
import { shareBits } from '../lib/format';

/**
 * Full-viewport overlay. For every share pushed over the WebSocket it launches
 * a stream of the share hash's bits from the miner's fan ([data-fan="<id>"])
 * to the block being mined (#mining-block). Runs entirely outside Angular's
 * change detection.
 */
@Component({
  selector: 'app-share-stream',
  standalone: true,
  template: `<canvas #canvas aria-hidden="true"></canvas>`,
  styles: [`canvas { position: fixed; inset: 0; pointer-events: none; z-index: 50; }`],
})
export class ShareStreamComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvas!: ElementRef<HTMLCanvasElement>;
  private socket = inject(FleetSocketService);
  private zone = inject(NgZone);
  private renderer?: ShareStreamRenderer;
  private sub?: Subscription;
  private typicalDiff = new Map<string, number>();
  private onResize = () => this.renderer?.resize();

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      this.renderer = new ShareStreamRenderer(this.canvas.nativeElement);
      window.addEventListener('resize', this.onResize);

      this.sub = this.socket.shares$.subscribe((shares) => {
        if (document.hidden) return; // don't queue animations for a background tab
        // only shares of the hash function the chain uses land in its block
        const minerAlgo = this.socket.miner()?.algo ?? this.socket.network()?.algo;
        if (this.socket.network() && this.socket.network()!.algo !== minerAlgo) return;
        shares.forEach((s, i) => setTimeout(() => this.launch(s.minerId, s.hash, s.difficulty, s.accepted), i * 60));
      });
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.renderer?.destroy();
    window.removeEventListener('resize', this.onResize);
  }

  private launch(minerId: string, hash: string, difficulty: number, accepted: boolean): void {
    const fan = document.querySelector<HTMLElement>(`[data-fan="${CSS.escape(minerId)}"]`);
    const block = document.getElementById('mining-block');
    if (!fan || !block || !this.renderer) return;

    // "lucky" = far above this miner's usual share difficulty
    const typical = this.typicalDiff.get(minerId) ?? difficulty;
    this.typicalDiff.set(minerId, Math.min(typical, difficulty) * 0.98 + difficulty * 0.02);
    const lucky = difficulty >= typical * 16;

    const f = fan.getBoundingClientRect();
    const target = () => {
      const r = block.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
    };
    this.renderer.launch({ x: f.left + f.width / 2, y: f.top + f.height / 2 }, target, shareBits(hash), {
      accepted,
      lucky,
      onArrive: () => block.dispatchEvent(new CustomEvent('share-arrived', { bubbles: true })),
    });
  }
}
