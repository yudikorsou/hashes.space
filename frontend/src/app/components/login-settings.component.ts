import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FleetApiService } from '../services/fleet-api.service';
import { Miner } from '../models';
import { DEFAULT_LOGIN } from './miner-login.component';

/**
 * Miner settings → Login: the username and password that protect this miner.
 * The current password is always needed. Where the firmware allows it, the new
 * password is set on the miner's own web page too. Other devices that were
 * logged in to this miner have to log in again.
 */
@Component({
  selector: 'app-login-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="s-card" id="sec-login" aria-labelledby="h-login">
      <div class="s-card-head">
        <div>
          <h2 id="h-login">Login</h2>
          <p>The username and password that protect this miner. Nobody can open it here and change its pool or settings without them.</p>
        </div>
        <span class="s-cap" [class.saved-only]="miner().defaultLogin">{{ miner().defaultLogin ? 'Default login' : 'Own login set' }}</span>
      </div>

      @if (miner().defaultLogin) {
        <p class="s-caution">This miner still uses the default login <b>{{ defaults.username }}</b> / <b>{{ defaults.password }}</b>. Anyone on your network who knows it could change your pool. Pick your own password.</p>
      }

      <form class="s-grid" (submit)="$event.preventDefault(); save()" novalidate>
        <label class="s-field" for="login-new-user">Username
          <input id="login-new-user" type="text" autocomplete="username" spellcheck="false" maxlength="32" [placeholder]="miner().defaultLogin ? defaults.username : 'Keep the current one'"
            [value]="username()" (input)="username.set($any($event.target).value); result.set(null)" />
          <span class="s-help">Leave empty to keep it.</span>
        </label>
        <label class="s-field" for="login-current">Current password
          <input id="login-current" type="password" autocomplete="current-password" [value]="current()" (input)="current.set($any($event.target).value); result.set(null)" />
        </label>
        <label class="s-field" for="login-new">New password
          <input id="login-new" type="password" autocomplete="new-password" [value]="next()" (input)="next.set($any($event.target).value); result.set(null)" [class.invalid]="!!problem()" />
          <span class="s-help">At least 8 characters, not the default one.</span>
        </label>
        <label class="s-field" for="login-repeat">Repeat new password
          <input id="login-repeat" type="password" autocomplete="new-password" [value]="repeat()" (input)="repeat.set($any($event.target).value); result.set(null)" [class.invalid]="!!problem()" />
        </label>
        <button type="submit" hidden></button>
      </form>

      <div class="s-actions">
        <p class="s-result" [class.ok]="result()?.ok" role="status">{{ result()?.text ?? (touched() ? problem() ?? '' : '') }}</p>
        <button type="button" class="btn" (click)="logout()" title="This browser logs out of this miner; Find ASIC shows Manage again">Log out of this miner</button>
        <button type="button" class="btn primary" [disabled]="busy() || !ready()" (click)="save()">{{ busy() ? 'Saving…' : 'Change login' }}</button>
      </div>
    </section>
  `,
})
export class LoginSettingsComponent {
  readonly miner = input.required<Miner>();
  private api = inject(FleetApiService);
  readonly defaults = DEFAULT_LOGIN;

  readonly username = signal('');
  readonly current = signal('');
  readonly next = signal('');
  readonly repeat = signal('');
  readonly busy = signal(false);
  readonly touched = signal(false);
  readonly result = signal<{ ok: boolean; text: string } | null>(null);

  readonly problem = computed(() => {
    const n = this.next();
    if (!n && !this.repeat()) return null;
    if (n.length < 8) return 'Use a password of at least 8 characters.';
    if (n === DEFAULT_LOGIN.password) return 'Pick a password other than the default one.';
    if (n !== this.repeat()) return 'The two new passwords are not the same.';
    return null;
  });
  readonly ready = computed(() => !!this.current() && (!!this.next() || !!this.username().trim()) && !this.problem());

  /** end this browser's login for the miner (the page closes it; Find ASIC shows Manage again) */
  async logout(): Promise<void> {
    if (this.miner().host) await this.api.logout(this.miner().host!).catch(() => undefined);
  }

  async save(): Promise<void> {
    this.touched.set(true);
    if (!this.ready()) return;
    this.busy.set(true);
    try {
      const r = await this.api.changeLogin(this.miner().id, { username: this.username().trim(), currentPassword: this.current(), newPassword: this.next(), confirmPassword: this.repeat() });
      this.result.set({ ok: true, text: `${r.message} Username: ${r.username}.` });
      this.current.set('');
      this.next.set('');
      this.repeat.set('');
      this.username.set('');
      this.touched.set(false);
    } catch (e) {
      this.result.set({ ok: false, text: (e as Error).message });
    } finally {
      this.busy.set(false);
    }
  }
}
