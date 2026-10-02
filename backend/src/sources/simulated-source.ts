import crypto from 'crypto';
import { ChainSource } from './chain-source';
import { ChainBlock, ProjectedBlock } from '../types';

/**
 * Roughly today's Bitcoin height: block 968,568 was the tip on 25 Sep 2026
 * 17:01 UTC, plus one block per 10 minutes since.
 */
export function estimateTipHeight(now = Date.now()): number {
  return 968_568 + Math.max(0, Math.floor((now - Date.UTC(2026, 8, 25, 17, 1)) / 600_000));
}

/** Offline chain for development and demos (no node, no internet). */
export class SimulatedSource extends ChainSource {
  private timers: NodeJS.Timeout[] = [];

  constructor(label = 'Simulated chain', private startTip = estimateTipHeight(), private blockEveryMs = 90_000) {
    super(label, 'regtest-sim');
  }

  start(): void {
    const now = Math.floor(Date.now() / 1000);
    const tip = this.startTip;
    const blocks = Array.from({ length: 8 }, (_, i) => this.makeBlock(tip - i, now - i * 600));
    this.publish({ blocks, tipHeight: tip, projected: this.makeProjected() });
    this.timers.push(setInterval(() => this.publish({ projected: this.makeProjected() }), 4000));
    this.timers.push(
      setInterval(() => this.pushBlock(this.makeBlock(this.state.tipHeight + 1, Math.floor(Date.now() / 1000))), this.blockEveryMs),
    );
  }

  stop(): void {
    this.timers.forEach(clearInterval);
  }

  private makeBlock(height: number, timestamp: number): ChainBlock {
    const med = 2 + Math.random() * 12;
    return {
      height,
      hash: '00000000000000000002' + crypto.randomBytes(22).toString('hex'),
      timestamp,
      txCount: 2500 + Math.floor(Math.random() * 2000),
      size: 1_400_000 + Math.floor(Math.random() * 400_000),
      weight: 3_990_000,
      medianFee: med,
      feeRange: [1, med * 0.6, med, med * 2, med * 8],
      totalFees: Math.floor(med * 1_000_000),
      pool: ['Foundry USA', 'AntPool', 'OCEAN', 'ViaBTC', 'SpiderPool', 'F2Pool'][Math.floor(Math.random() * 6)],
    };
  }

  private makeProjected(): ProjectedBlock[] {
    return Array.from({ length: 6 }, (_, index) => {
      const med = Math.max(1, (14 - index * 2.2) * (0.85 + Math.random() * 0.3));
      return {
        index,
        nTx: 2800 + Math.floor(Math.random() * 1200),
        vsize: index === 5 ? 400_000 + Math.random() * 500_000 : 997_000,
        medianFee: med,
        feeRange: [med * 0.7, med, med * 3],
        totalFees: Math.floor(med * 1_000_000),
      };
    });
  }
}
