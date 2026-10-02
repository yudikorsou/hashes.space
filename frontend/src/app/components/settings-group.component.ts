import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FleetApiService } from '../services/fleet-api.service';
import { Miner } from '../models';
import { SettingsField, SettingsGroup, checkGroup, defaultSettings } from '../lib/settings-schema';

/** time zones for the "timezone" field: the browser's full list when it has one */
const TIMEZONES: string[] = (() => {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const all = intl.supportedValuesOf?.('timeZone');
    if (all?.length) return ['UTC', ...all.filter((z) => z !== 'UTC')];
  } catch {
    /* older browser */
  }
  return ['UTC', 'Europe/Amsterdam', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
})();

/**
 * One section of the Miner settings page, drawn from the shared schema
 * (lib/settings-schema.ts): Performance, Cooling, Network, Security or System.
 * Checks the values with the same rules as the backend, then saves or applies.
 */
@Component({
  selector: 'app-settings-group',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="s-card" [id]="'sec-' + group().id" [attr.aria-labelledby]="'h-' + group().id">
      <div class="s-card-head">
        <div>
          <h2 [id]="'h-' + group().id">{{ group().title }}</h2>
          <p>{{ group().summary }}</p>
        </div>
        <span class="s-cap" [class.saved-only]="!canApply()">{{ canApply() ? 'Applies to the miner' : 'Saved here only' }}</span>
      </div>

      <form class="s-grid" (submit)="$event.preventDefault(); save(true)" novalidate>
        @for (f of visibleFields(); track f.key) {
          @if (f.type === 'toggle') {
            <label class="s-toggle wide s-field">
              <input type="checkbox" [id]="fid(f)" [checked]="!!values()[f.key]" (change)="set(f.key, $any($event.target).checked)" />
              <span>{{ f.label }} @if (f.help) { <small>{{ f.help }}</small> }</span>
            </label>
          } @else {
            <label class="s-field" [attr.for]="fid(f)" [class.wide]="f.type === 'iplist'" [class.sel]="f.type === 'select' || f.type === 'timezone'">
              {{ f.label }}
              @switch (f.type) {
                @case ('select') {
                  <select [id]="fid(f)" [value]="values()[f.key]" (change)="set(f.key, $any($event.target).value)" [class.invalid]="!!err(f)">
                    @for (o of f.options; track o.value) {
                      <option [value]="o.value" [selected]="values()[f.key] === o.value">{{ o.label }}</option>
                    }
                  </select>
                }
                @case ('timezone') {
                  <select [id]="fid(f)" (change)="set(f.key, $any($event.target).value)" [class.invalid]="!!err(f)">
                    @for (z of timezones; track z) {
                      <option [value]="z" [selected]="values()[f.key] === z">{{ z.replace('_', ' ') }}</option>
                    }
                  </select>
                }
                @case ('number') {
                  <span class="s-unit">
                    <input
                      [id]="fid(f)"
                      type="number"
                      inputmode="decimal"
                      [min]="f.min ?? null"
                      [max]="f.max ?? null"
                      [step]="f.step ?? 1"
                      [placeholder]="f.optional ? 'Automatic' : ''"
                      [value]="values()[f.key] ?? ''"
                      (input)="set(f.key, $any($event.target).value)"
                      [class.invalid]="!!err(f)"
                      [attr.aria-describedby]="err(f) ? fid(f) + '-err' : null"
                    />
                    @if (f.unit) {
                      <span>{{ f.unit }}</span>
                    }
                  </span>
                }
                @default {
                  <input
                    [id]="fid(f)"
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    [attr.inputmode]="f.type === 'ipv4' ? 'decimal' : null"
                    [placeholder]="f.placeholder ?? ''"
                    [value]="values()[f.key] ?? ''"
                    (input)="set(f.key, $any($event.target).value)"
                    [class.invalid]="!!err(f)"
                    [attr.aria-describedby]="err(f) ? fid(f) + '-err' : null"
                  />
                }
              }
              @if (err(f); as e) {
                <span class="s-err" [id]="fid(f) + '-err'">{{ e }}</span>
              } @else if (f.help) {
                <span class="s-help">{{ f.help }}</span>
              }
            </label>
          }
        }
        <button type="submit" hidden></button>
      </form>

      @if (touched() && check().groupError; as ge) {
        <p class="s-group-err" role="alert">{{ ge }}</p>
      }
      @if (caution(); as c) {
        <p class="s-caution">{{ c }}</p>
      }

      <div class="s-actions">
        <p class="s-result" [class.ok]="result()?.ok" role="status">{{ result()?.text ?? '' }}</p>
        <button type="button" class="btn" [disabled]="!!busy()" (click)="reset()">Reset</button>
        <button type="button" class="btn" [disabled]="!!busy()" (click)="save(false)">{{ busy() === 'save' ? 'Saving…' : 'Save' }}</button>
        @if (canApply()) {
          <button type="button" class="btn primary" [disabled]="!!busy()" (click)="save(true)">{{ busy() === 'apply' ? 'Applying…' : 'Save & apply' }}</button>
        }
      </div>
    </section>
  `,
})
export class SettingsGroupComponent {
  readonly group = input.required<SettingsGroup>();
  readonly miner = input.required<Miner>();

  private api = inject(FleetApiService);
  readonly timezones = TIMEZONES;

  readonly values = signal<Record<string, unknown>>({});
  readonly touched = signal(false);
  readonly busy = signal<'save' | 'apply' | null>(null);
  readonly result = signal<{ ok: boolean; text: string } | null>(null);
  private loadedFor = '';

  readonly canApply = computed(() => !!this.miner().capabilities?.[this.group().id]);
  readonly visibleFields = computed(() => this.group().fields.filter((f) => !f.showIf || f.showIf(this.values())));
  readonly check = computed(() => checkGroup(this.group(), this.values()));
  readonly caution = computed(() => this.group().caution?.(this.values(), this.miner().host) ?? null);
  private minerId = computed(() => this.miner().id);

  constructor() {
    // load the stored values when a different miner is connected (never over what the owner is typing)
    effect(() => {
      const id = this.minerId();
      if (id === this.loadedFor) return;
      untracked(() => this.reset());
    });
  }

  fid(f: SettingsField): string {
    return `${this.group().id}-${f.key}`;
  }

  err(f: SettingsField): string | null {
    return this.touched() ? (this.check().fieldErrors[f.key] ?? null) : null;
  }

  set(key: string, value: unknown): void {
    this.values.update((v) => ({ ...v, [key]: value }));
    this.result.set(null);
  }

  reset(): void {
    const m = this.miner();
    this.loadedFor = m.id;
    const stored = (m.settings ?? defaultSettings())[this.group().id] as unknown as Record<string, unknown>;
    this.values.set({ ...stored });
    this.touched.set(false);
    this.result.set(null);
  }

  async save(apply: boolean): Promise<void> {
    this.touched.set(true);
    const c = this.check();
    if (!c.ok) {
      this.result.set({ ok: false, text: 'Fix the highlighted fields first.' });
      return;
    }
    this.busy.set(apply ? 'apply' : 'save');
    this.result.set(null);
    try {
      const r = await this.api.saveSettings(this.miner().id, this.group().id, c.values, apply);
      this.result.set(r.applied ? { ok: r.applied.ok, text: r.applied.message } : { ok: true, text: this.canApply() ? 'Saved. Use Save & apply to send it to the miner.' : 'Saved.' });
      this.touched.set(false);
    } catch (e) {
      this.result.set({ ok: false, text: (e as Error).message });
    } finally {
      this.busy.set(null);
    }
  }
}
