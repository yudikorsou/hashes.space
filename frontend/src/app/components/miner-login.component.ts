import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FleetApiService } from '../services/fleet-api.service';
import { FanComponent } from './fan.component';

/** the login every new miner starts with; the owner changes it under Miner settings → Login */
export const DEFAULT_LOGIN = { username: 'admin', password: '123456789' };

/**
 * "Log in to 192.168.1.101": shown on the dashboard after Manage, before the
 * miner opens. Every miner has its own username and password, so nobody else
 * on the network can open it and change its pools or settings. A miner that
 * still has the default login shows it in the fields, with a reminder to
 * change it.
 */
@Component({
  selector: 'app-miner-login',
  standalone: true,
  imports: [RouterLink, FanComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="login-title">
      <app-fan class="fan" [status]="'not-hashing'" />
      <form (submit)="$event.preventDefault(); submit()" novalidate>
        <div>
          <h2 id="login-title">Log in to <span class="ip">{{ host() }}</span></h2>
          <p class="sub">Every miner has its own login, so nobody else on your network can open it and change its pool or settings.</p>
        </div>
        <label class="field" for="login-user">Username
          <input id="login-user" type="text" autocomplete="username" spellcheck="false" [value]="username()" (input)="username.set($any($event.target).value); error.set(null)" />
        </label>
        <label class="field" for="login-pass">Password
          <span class="pw">
            <input id="login-pass" [type]="show() ? 'text' : 'password'" autocomplete="current-password" spellcheck="false" [value]="password()"
              (input)="password.set($any($event.target).value); error.set(null)" [attr.aria-invalid]="!!error()" [attr.aria-describedby]="error() ? 'login-err' : 'login-hint'" />
            <button type="button" class="show" (click)="show.set(!show())" [attr.aria-pressed]="show()">{{ show() ? 'Hide' : 'Show' }}</button>
          </span>
        </label>
        @if (error(); as e) {
          <p class="err" id="login-err" role="alert">{{ e }}</p>
        } @else if (defaultLogin()) {
          <p class="hint" id="login-hint">This miner still has the default login (<b>{{ defaults.username }}</b> / <b>{{ defaults.password }}</b>). Change it under Miner settings → Login after you log in.</p>
        } @else {
          <p class="hint" id="login-hint">Use the login you set for this miner under Miner settings → Login.</p>
        }
        <div class="actions">
          <button type="submit" class="btn primary" [disabled]="busy() || !username().trim() || !password()">{{ busy() ? 'Logging in…' : 'Log in' }}</button>
          <a class="btn" routerLink="/asic">Back to Find ASIC</a>
        </div>
      </form>
    </section>
  `,
  styles: [
    `
      :host { display: block; }
      .card { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 28px; align-items: start; padding: 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
      .fan { --fan-size: 110px; opacity: 0.55; }
      form { display: grid; gap: 14px; max-width: 460px; }
      h2 { margin: 0 0 4px; font: 600 22px/1.2 var(--display); letter-spacing: 0.02em; }
      .ip { font-family: var(--mono); }
      .sub, .hint { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
      .hint b { color: var(--text); font-family: var(--mono); font-weight: 500; }
      .err { margin: 0; color: var(--bad); font-size: 13.5px; }
      .field { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
      input { width: 100%; box-sizing: border-box; font: 500 15px/1.2 var(--mono); color: var(--text); background: var(--bg); border: 1px solid var(--line-strong); border-radius: 6px; padding: 10px 12px; }
      input:focus { outline: none; border-color: var(--link); box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 22%, transparent); }
      input[aria-invalid='true'] { border-color: var(--bad); }
      .pw { position: relative; display: block; }
      .pw input { padding-right: 64px; }
      .show { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); font: 600 12px/1 var(--sans); color: var(--link); background: none; border: 0; padding: 6px 8px; cursor: pointer; }
      .show:focus-visible { outline: 2px solid var(--link); border-radius: 4px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .actions a.btn { text-decoration: none; }
      @media (max-width: 640px) {
        .card { grid-template-columns: 1fr; padding: 18px; }
        .fan { --fan-size: 72px; }
      }
    `,
  ],
})
export class MinerLoginComponent {
  readonly host = input.required<string>();
  readonly minerId = input.required<string>();
  readonly defaultLogin = input(false);
  /** prefilled username: the default one while the miner still has it */
  readonly suggestedUser = input('');

  private api = inject(FleetApiService);
  readonly defaults = DEFAULT_LOGIN;
  readonly username = signal('');
  readonly password = signal('');
  readonly show = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    // a miner with the default login shows it in the fields (visible), so the owner can log in right away
    effect(() => {
      const isDefault = this.defaultLogin();
      const user = this.suggestedUser();
      this.host();
      untracked(() => {
        this.username.set(user || (isDefault ? DEFAULT_LOGIN.username : ''));
        this.password.set(isDefault ? DEFAULT_LOGIN.password : '');
        this.show.set(isDefault);
        this.error.set(null);
      });
    });
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.login(this.minerId(), this.host(), this.username().trim(), this.password());
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
