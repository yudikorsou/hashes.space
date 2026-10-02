import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FleetApiService } from '../services/fleet-api.service';
import { Miner, MinerAction } from '../models';
import { ActionInfo, MINER_ACTIONS } from '../lib/settings-schema';

/**
 * Maintenance: find the miner (blink LED), reboot, turn off / on and factory reset. Risky
 * actions ask for confirmation on the page itself. (The password is under Login.)
 */
@Component({
  selector: 'app-miner-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="s-card" id="sec-maintenance" aria-labelledby="h-maintenance">
      <div class="s-card-head">
        <div>
          <h2 id="h-maintenance">Maintenance</h2>
          <p>Find the miner in the rack, restart it, turn it off or on, or start over with factory settings.</p>
        </div>
        @if (miner().poweredOff) {
          <span class="s-cap off">Turned off</span>
        } @else if (blinking()) {
          <span class="s-cap">LED blinking</span>
        }
      </div>

      <ul class="act-list">
        @for (a of actions(); track a.id) {
          <li>
            <div>
              <b>{{ a.label }}</b>
              <small>{{ a.help }}</small>
              @if (!can(a.id)) {
                <small class="muted">This miner’s firmware can’t do this remotely.</small>
              }
            </div>
            @if (confirming() === a.id) {
              <div class="confirm" role="group" [attr.aria-label]="'Confirm ' + a.label">
                <span>{{ a.confirm }}</span>
                <button type="button" class="btn" (click)="confirming.set(null)">Cancel</button>
                <button type="button" class="btn" [class.danger]="a.danger" [class.solid]="a.danger" [class.primary]="!a.danger" [disabled]="!!busy()" (click)="run(a)">
                  {{ busy() === a.id ? 'Working…' : 'Yes, ' + a.label.toLowerCase() }}
                </button>
              </div>
            } @else {
              <button type="button" class="btn" [class.danger]="a.danger" [disabled]="!!busy() || !can(a.id)" (click)="start(a)">{{ a.label }}</button>
            }
          </li>
        }
      </ul>

      <p class="s-result" [class.ok]="result()?.ok" role="status">{{ result()?.text ?? '' }}</p>
    </section>
  `,
  styles: [
    `
      .act-list { list-style: none; margin: 0; padding: 0; display: grid; }
      .act-list li { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px 20px; padding: 14px 0; border-top: 1px solid var(--line); }
      .act-list li:first-child { border-top: 0; padding-top: 0; }
      .act-list b { display: block; font: 600 14px/1.3 var(--sans); }
      .act-list small { display: block; color: var(--muted); font-size: 12.5px; line-height: 1.45; max-width: 60ch; }
      .act-list .muted { color: var(--warn); }
      .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
      .confirm span { max-width: 44ch; }
      .s-result { margin: 0; }
      .s-cap.off { color: var(--bad); }
    `,
  ],
})
export class MinerActionsComponent {
  readonly miner = input.required<Miner>();
  readonly now = input(Date.now());
  private api = inject(FleetApiService);

  /** Turn off while the miner is on, Turn on while it is off */
  readonly actions = computed(() => MINER_ACTIONS.filter((a) => !a.onlyWhen || (a.onlyWhen === 'off') === !!this.miner().poweredOff));
  readonly confirming = signal<MinerAction | null>(null);
  readonly busy = signal<MinerAction | null>(null);
  readonly result = signal<{ ok: boolean; text: string } | null>(null);

  readonly blinking = computed(() => (this.miner().locateUntil ?? 0) > this.now());

  can(a: MinerAction): boolean {
    return !!this.miner().capabilities?.[a];
  }

  start(a: ActionInfo): void {
    this.result.set(null);
    if (a.confirm) this.confirming.set(a.id);
    else this.run(a);
  }

  async run(a: ActionInfo): Promise<void> {
    await this.call(a.id, {});
    this.confirming.set(null);
  }

  private async call(action: MinerAction, body: Record<string, unknown>): Promise<void> {
    this.busy.set(action);
    try {
      const r = await this.api.runAction(this.miner().id, action, body);
      this.result.set({ ok: r.result.ok, text: r.result.message });
    } catch (e) {
      this.result.set({ ok: false, text: (e as Error).message });
    } finally {
      this.busy.set(null);
    }
  }
}
