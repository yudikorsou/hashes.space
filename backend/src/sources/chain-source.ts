import { EventEmitter } from 'events';
import { ChainBlock, ChainState } from '../types';

/**
 * A chain source keeps a normalised ChainState up to date and emits:
 *   'state'  (ChainState)  – whenever blocks or projected blocks change
 *   'block'  (ChainBlock)  – when a new block is mined
 */
export abstract class ChainSource extends EventEmitter {
  protected state: ChainState;

  constructor(source: string, network = 'mainnet') {
    super();
    this.state = { source, network, tipHeight: 0, blocks: [], projected: [], updatedAt: Date.now() };
  }

  abstract start(): void;
  abstract stop(): void;

  getState(): ChainState {
    return this.state;
  }

  protected publish(partial: Partial<ChainState>): void {
    this.state = { ...this.state, ...partial, updatedAt: Date.now() };
    this.emit('state', this.state);
  }

  protected pushBlock(block: ChainBlock): void {
    if (this.state.blocks.some((b) => b.hash === block.hash)) return;
    const blocks = [block, ...this.state.blocks].sort((a, b) => b.height - a.height).slice(0, 8);
    this.publish({ blocks, tipHeight: Math.max(this.state.tipHeight, block.height) });
    this.emit('block', block);
  }
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentiles(values: number[], ps = [0, 10, 25, 50, 75, 90, 100]): number[] {
  if (!values.length) return ps.map(() => 0);
  const s = [...values].sort((a, b) => a - b);
  return ps.map((p) => s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))]);
}
