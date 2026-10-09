import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, NgZone, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Subscription } from 'rxjs';
import { ChainState, ChainBlock, ProjectedBlock } from '../models';
import { FleetSocketService } from '../services/fleet-socket.service';
import { MEMPOOL_COLORS, feeColor, formatAgo } from '../lib/format';

/**
 * mempool-style strip: projected blocks (left) | mined blocks (right).
 * Colours follow mempool (as on mempool.guide): projected blocks are filled with the fee colour
 * of their median fee, mined blocks with mempool's purple→blue gradient; the
 * empty part of a block shows how far it is from full.
 *
 * projected[0] is the block being mined: it carries id="mining-block" – the
 * target of every share stream – and pulses when a stream lands.
 */
@Component({
  selector: 'app-chain-strip',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="strip" [attr.aria-label]="(socket.network()?.chain ?? 'The') + ' blockchain'">
      <div class="half projected">
        @for (b of projectedReversed(); track b.index) {
          <div class="block-wrap" [class.mining]="b.index === 0">
            <div class="above">{{ b.index === 0 ? 'Mining now' : '' }}</div>
            <div class="cube" [attr.id]="b.index === 0 ? 'mining-block' : null">
              <div class="face front" [style.background]="projectedBg(b)">
                @if (socket.network()?.logo; as logo) {
                  <img class="cube-coin" [src]="logo" alt="" />
                }
                <div class="txt">
                  <span class="fee">~{{ b.medianFee | number: '1.0-0' }} {{ unit() }}</span>
                  <span class="range">{{ b.feeRange[0] | number: '1.0-0' }} - {{ b.feeRange[b.feeRange.length - 1] | number: '1.0-0' }} {{ unit() }}</span>
                  <span class="size">{{ b.bytes !== undefined ? sizeLabel(b.bytes) : (b.vsize / 1e6 | number: '1.2-2') + ' MvB' }}</span>
                  <span class="txs">{{ b.nTx ? (b.nTx | number) + ' transactions' : '' }}</span>
                  <span class="time">in ~{{ (b.index + 1) * 10 }} minutes</span>
                </div>
              </div>
              <div class="face top"></div>
              <div class="face side"></div>
            </div>
            <div class="below">
              @if (b.index === 0) {
                <span class="fleet-shares" title="Shares your miner has landed on this block template">your shares <b>{{ sharesThisBlock() | number }}</b></span>
              }
            </div>
          </div>
        }
      </div>

      <div class="divider" aria-hidden="true"></div>

      <div class="half mined">
        @for (b of chain()?.blocks ?? []; track b.hash) {
          <a class="block-wrap enter" [class.datum]="b.datum" [attr.title]="b.datum ? datumTitle : null" [attr.href]="explorer() && !b.partial ? explorer() + b.hash : null" target="_blank" rel="noopener">
            <div class="above height">{{ b.height | number: '1.0-0' }}</div>
            <div class="cube">
              <div class="face front" [style.background]="minedBg(b)">
                @if (socket.network()?.logo; as logo) {
                  <img class="cube-coin" [src]="logo" alt="" />
                }
                @if (b.partial) {
                  <!-- Electrum only: no size, fees or tx count -->
                  <div class="txt">
                    <span class="fee">Block found</span>
                    <span class="range">via Electrum</span>
                    <span class="size">{{ b.height | number: '1.0-0' }}</span>
                    <span class="txs">add node RPC for details</span>
                    <span class="time">{{ ago(b.timestamp) }}</span>
                  </div>
                } @else {
                  <div class="txt">
                    <span class="fee">~{{ b.medianFee | number: '1.0-0' }} {{ unit() }}</span>
                    <span class="range">{{ b.feeRange[0] | number: '1.0-0' }} - {{ b.feeRange[b.feeRange.length - 1] | number: '1.0-0' }} {{ unit() }}</span>
                    <span class="size">{{ sizeLabel(b.size) }}</span>
                    <span class="txs">{{ b.txCount | number }} transactions</span>
                    <span class="time">{{ ago(b.timestamp) }}</span>
                  </div>
                }
              </div>
              <div class="face top"></div>
              <div class="face side"></div>
            </div>
            <div class="below">
              {{ b.pool ?? '' }}
              @if (b.datum) {
                <span class="datum-badge"><span aria-hidden="true">✓</span> DATUM Verified</span>
              }
            </div>
          </a>
        }
      </div>
    </section>
  `,
  styleUrl: './chain-strip.component.scss',
})
export class ChainStripComponent implements AfterViewInit, OnDestroy {
  readonly datumTitle = 'DATUM Verified: mined in a DATUM pool through DATUM Gateway, with the miner\'s own node building the block template';
  readonly chain = input<ChainState | null>(null);

  readonly socket = inject(FleetSocketService);
  private zone = inject(NgZone);
  private host = inject(ElementRef<HTMLElement>);
  private subs = new Subscription();
  private tick = signal(0);

  /** block page link of the stream shown (mempool.guide); none for your own node */
  readonly explorer = computed(() => this.socket.network()?.explorerBlockUrl);
  readonly sharesThisBlock = signal(0);
  private minerId = computed(() => this.socket.miner()?.id);
  readonly projectedReversed = computed(() => [...(this.chain()?.projected ?? [])].slice(0, 6).reverse());

  constructor() {
    // reset the counter when a new block is mined (new template) …
    this.subs.add(this.socket.blockFound$.subscribe(() => this.sharesThisBlock.set(0)));
    // … and when the page connects to a different miner
    effect(() => {
      this.minerId(); // only changes when a different miner is connected
      untracked(() => this.sharesThisBlock.set(0));
    });
    // refresh "x minutes ago" labels
    const t = setInterval(() => this.tick.update((n) => n + 1), 15_000);
    this.subs.add(() => clearInterval(t));
  }

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      // pulse the mining block when a share stream lands in it
      const onArrive = (e: Event) => {
        const el = e.target as HTMLElement;
        el.classList.remove('hit');
        void el.offsetWidth; // restart the CSS animation
        el.classList.add('hit');
        this.zone.run(() => this.sharesThisBlock.update((n) => n + 1));
      };
      this.host.nativeElement.addEventListener('share-arrived', onArrive);
      this.subs.add(() => this.host.nativeElement.removeEventListener('share-arrived', onArrive));
    });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  /** "sat/vB", or the chain's own fee unit (Monero: nXMR/B) */
  unit(): string {
    return this.chain()?.feeUnit ?? 'sat/vB';
  }

  /** 1.62 MB, or 86 kB for small (Monero) blocks */
  sizeLabel(bytes: number): string {
    return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(2)} MB` : `${Math.round(bytes / 1e3)} kB`;
  }

  /** mempool: empty part #554b45, filled part in the median-fee colour */
  projectedBg(b: ProjectedBlock): string {
    const empty = 100 - Math.max(4, Math.min(100, (b.vsize / 1_000_000) * 100));
    const c = feeColor(b.medianFee * (this.chain()?.feeColorScale ?? 1));
    return `linear-gradient(${MEMPOOL_COLORS.projectedEmpty}, ${MEMPOOL_COLORS.projectedEmpty} ${empty}%, ${c} ${empty}%, ${c} 100%)`;
  }

  /** mempool: empty part #2d3348, filled part purple → blue */
  minedBg(b: ChainBlock): string {
    const empty = 100 - Math.max(4, Math.min(100, (b.weight / 4_000_000) * 100));
    const [from, to] = MEMPOOL_COLORS.mined;
    return `repeating-linear-gradient(${MEMPOOL_COLORS.minedEmpty}, ${MEMPOOL_COLORS.minedEmpty} ${empty}%, ${from} ${empty}%, ${to} 100%)`;
  }

  ago(ts: number): string {
    this.tick();
    return formatAgo(ts * 1000);
  }
}
