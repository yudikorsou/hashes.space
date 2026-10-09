import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, computed, inject, signal } from '@angular/core';
import { FleetSocketService } from '../services/fleet-socket.service';
import { FleetApiService } from '../services/fleet-api.service';
import { HashAlgo, NetworkId, NetworkInfo, OwnNodeConfig } from '../models';

interface OwnForm {
  algo: HashAlgo;
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
  electrumHost: string;
  electrumPort: string;
  electrumTls: boolean;
}

/**
 * The PoW network: which proof-of-work blockchain the page shows.
 *   the networks in the backend's networks.json (e.g. SHA-256 → Bitcoin from mempool.space,
 *   Scrypt → Litecoin from litecoinspace.org, BLAKE2b → Bitcoin BLAKE2b from mempool.guide)
 *   Your node → the account's own node and/or Electrum server, for any hash function
 */
@Component({
  selector: 'app-network-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="bar" aria-labelledby="net-label">
      <span id="net-label" class="label" title="Proof of Work: the hash function and blockchain your miner works on">PoW</span>

      <!-- dropdown: which hash function validates the chain shown below -->
      <div class="dd" (keydown)="onKey($event)">
        <button
          #trigger
          type="button"
          class="dd-trigger"
          aria-haspopup="listbox"
          aria-labelledby="net-label net-current"
          [attr.aria-expanded]="menuOpen()"
          (click)="toggle()"
        >
          @if (socket.network(); as n) {
            <span class="algo" [class]="'algo ' + n.algo">{{ n.label }}</span>
            <span id="net-current" class="dd-text">
              <b>{{ n.id === 'own' ? 'Your node' : n.chain }}</b>
              <small>{{ n.id === 'own' ? n.chain + ' · ' + n.source : n.ticker + ' · ' + n.source }}</small>
            </span>
          } @else {
            <span id="net-current" class="dd-text"><b>Loading networks…</b></span>
          }
          <svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>

        @if (menuOpen()) {
          <ul class="dd-menu" role="listbox" aria-labelledby="net-label" [attr.aria-activedescendant]="'net-opt-' + active()">
            @for (n of socket.networks(); track n.id; let i = $index) {
              <li
                role="option"
                [id]="'net-opt-' + i"
                [attr.aria-selected]="socket.networkId() === n.id"
                [class.active]="active() === i"
                (mouseenter)="active.set(i)"
                (click)="choose(n)"
              >
                <span class="algo" [class]="'algo ' + n.algo">{{ n.label }}</span>
                <span class="dd-text">
                  <b>{{ n.id === 'own' ? 'Your node' : n.chain }} <em>{{ n.ticker }}</em></b>
                  <small>{{ describe(n) }}</small>
                </span>
                @if (socket.networkId() === n.id) {
                  <svg class="tick" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                }
              </li>
            }
          </ul>
        }
      </div>

      <button type="button" class="connect" (click)="open()">
        {{ hasOwn() ? 'Your node and Electrum server' : 'Connect node' }}
      </button>
    </section>

    <dialog #dlg aria-labelledby="own-title" (close)="result.set(null)">
      <form method="dialog" (submit)="$event.preventDefault(); connect()" novalidate>
        <h2 id="own-title">Connect your own node and Electrum server</h2>
        <p class="muted">Stream a blockchain from your own node. Pick the hash function its chain is mined with, then enter the node, an Electrum server (Electrs, Fulcrum), or both: the node gives full block details and the block your miners work on, Electrum adds the mempool.</p>

        <label class="algo-pick">Hash function of your node's chain
          <select [value]="form().algo" (change)="patch({ algo: $any($event.target).value })">
            @for (a of algoOptions(); track a.algo) {
              <option [value]="a.algo" [selected]="a.algo === form().algo">{{ a.label }}</option>
            }
          </select>
        </label>

        <fieldset>
          <legend>Node (Bitcoin Core or Bitcoin Knots)</legend>
          <div class="grid">
            <label class="wide">RPC address
              <input type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://192.168.1.20:8332" [value]="form().rpcUrl" (input)="patch({ rpcUrl: $any($event.target).value })" />
            </label>
            <label>RPC user
              <input type="text" autocomplete="off" spellcheck="false" [value]="form().rpcUser" (input)="patch({ rpcUser: $any($event.target).value })" />
            </label>
            <label>RPC password
              <input type="password" autocomplete="new-password" [value]="form().rpcPassword" (input)="patch({ rpcPassword: $any($event.target).value })" />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Electrum server</legend>
          <div class="grid">
            <label class="wide">Address
              <input type="text" autocomplete="off" spellcheck="false" placeholder="192.168.1.20" [value]="form().electrumHost" (input)="patch({ electrumHost: $any($event.target).value })" />
            </label>
            <label>Port
              <input type="number" min="1" max="65535" [placeholder]="form().electrumTls ? '50002' : '50001'" [value]="form().electrumPort" (input)="patch({ electrumPort: $any($event.target).value })" />
            </label>
            <label class="check"><input type="checkbox" [checked]="form().electrumTls" (change)="patch({ electrumTls: $any($event.target).checked })" /> Use SSL</label>
          </div>
        </fieldset>

        <p class="hint">This server connects to the addresses you enter, so your node must be reachable from it (for example through Tailscale, WireGuard or Tor). The RPC password is kept on the server and never shown again.</p>

        @if (result(); as r) {
          <p class="result" [class.ok]="r.ok" role="status">{{ r.text }}</p>
        }

        <div class="actions">
          @if (hasOwn()) {
            <button type="button" class="btn danger" [disabled]="busy()" (click)="disconnectOwn()">Disconnect my node</button>
          }
          <span class="spacer"></span>
          <button type="button" class="btn" (click)="dlg.nativeElement.close()">Cancel</button>
          <button type="submit" class="btn primary" [disabled]="busy()">{{ busy() ? 'Testing…' : 'Test and connect' }}</button>
        </div>
      </form>
    </dialog>
  `,
  styles: [
    `
      .bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 14px;
        padding: 12px 20px;
        border-bottom: 1px solid var(--line);
        background: var(--bg);
      }
      .label { font: 600 12px/1 var(--sans); letter-spacing: 0.06em; color: var(--muted); } /* "PoW" keeps its own capitals */
      /* dropdown */
      .dd { position: relative; }
      .dd-trigger, .dd-menu li {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 12px;
        text-align: left;
        color: var(--text);
      }
      .dd-trigger {
        min-width: 300px;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid var(--line-strong);
        background: var(--surface);
        cursor: pointer;
        &:hover { border-color: var(--link); }
        &:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
        &[aria-expanded='true'] { border-color: var(--orange); }
        &[aria-expanded='true'] .chev { transform: rotate(180deg); }
      }
      .dd-text { display: grid; gap: 2px; min-width: 0; }
      .dd-text b { font: 600 14px/1.15 var(--display); letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dd-text b em { font: 500 11px/1 var(--mono); font-style: normal; color: var(--muted); margin-left: 4px; }
      .dd-text small { font: 400 12px/1.25 var(--sans); color: var(--muted); }
      .chev, .tick { width: 12px; height: 12px; color: var(--muted); transition: transform 0.15s; }
      .tick { color: var(--orange); }
      /* the hash function badge: the one thing that tells the networks apart at a glance */
      .algo {
        font: 600 11px/1 var(--mono);
        letter-spacing: 0.04em;
        padding: 6px 8px;
        border-radius: 4px;
        white-space: nowrap;
        color: #e8ebf5;
        background: #3b4463;
      }
      /* a colour per hash function; any other one gets the neutral badge above */
      .algo.sha256 { color: #1a1206; background: #f7931a; } /* Bitcoin orange */
      .algo.blake2b { color: #1a1406; background: #e2b33c; } /* Bitcoin BLAKE2b gold */
      .algo.scrypt { color: #0b1530; background: #bfc8dc; } /* Litecoin silver */
      .algo.kheavyhash { color: #04211c; background: #49eacb; }
      .algo.equihash { color: #1a1406; background: #f4b728; }
      .algo.randomx { color: #fff; background: #ff6600; }
      .algo-pick { display: grid; gap: 6px; font: 500 12px/1.2 var(--sans); color: var(--muted); }
      .algo-pick select { font: 400 13px/1.2 var(--sans); color: var(--text); background: var(--bg); border: 1px solid var(--line-strong); border-radius: 6px; padding: 9px 10px; }
      .dd-menu {
        position: absolute;
        z-index: 60;
        top: calc(100% + 6px);
        left: 0;
        min-width: 100%;
        width: max-content;
        max-width: calc(100vw - 32px);
        margin: 0;
        padding: 6px;
        list-style: none;
        background: var(--surface);
        border: 1px solid var(--line-strong);
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      }
      .dd-menu li { padding: 10px 10px; border-radius: 6px; cursor: pointer; }
      .dd-menu li.active { background: color-mix(in srgb, var(--orange) 10%, transparent); }
      .dd-menu li[aria-selected='true'] b { color: var(--orange); }
      .connect {
        margin-left: auto;
        font: 600 13px/1 var(--sans);
        color: var(--link);
        background: none;
        border: 1px dashed var(--line-strong);
        border-radius: 6px;
        padding: 10px 14px;
        cursor: pointer;
        &:hover { border-color: var(--link); }
        &:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
      }

      dialog {
        width: min(640px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        padding: 0;
        color: var(--text);
        background: var(--surface);
        border: 1px solid var(--line-strong);
        border-radius: 10px;
      }
      dialog::backdrop { background: rgba(5, 6, 12, 0.7); }
      form { display: grid; gap: 16px; padding: 22px; }
      h2 { margin: 0; font: 600 20px/1.2 var(--display); }
      .muted, .hint { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
      fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 10px; min-width: 0; }
      legend { font: 600 12px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 10px; padding: 0; }
      .radios { display: flex; flex-wrap: wrap; gap: 16px; }
      .radios label { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
      .radios small { color: var(--muted); }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .grid label { display: grid; gap: 6px; font: 500 12px/1.2 var(--sans); color: var(--muted); }
      .grid .wide { grid-column: 1 / -1; }
      .grid .check { display: flex; align-items: center; gap: 8px; align-self: end; padding-bottom: 10px; color: var(--text); font-size: 13px; }
      input[type='text'], input[type='password'], input[type='number'] {
        width: 100%;
        font: 400 13px/1.2 var(--mono);
        color: var(--text);
        background: var(--bg);
        border: 1px solid var(--line-strong);
        border-radius: 6px;
        padding: 9px 10px;
      }
      input::placeholder { color: var(--muted-2); }
      input:focus { outline: none; border-color: var(--link); box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 22%, transparent); }
      .result { margin: 0; font-size: 13px; color: var(--bad); }
      .result.ok { color: var(--good); }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .spacer { flex: 1; }
      .btn { font: 600 13px/1 var(--sans); padding: 10px 14px; border-radius: 6px; cursor: pointer; border: 1px solid var(--line-strong); color: var(--text); background: transparent; }
      .btn:hover:not(:disabled) { border-color: var(--link); }
      .btn:disabled { opacity: 0.6; cursor: progress; }
      .btn:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
      .btn.primary { background: #105fb0; border-color: #105fb0; }
      .btn.danger { color: var(--bad); }
      @media (max-width: 720px) {
        .bar { padding-inline: 16px; }
        .connect { margin-left: 0; width: 100%; }
        .dd, .dd-trigger { width: 100%; min-width: 0; }
        .grid { grid-template-columns: 1fr; }
      }
    `,
  ],
})
export class NetworkBarComponent {
  readonly socket = inject(FleetSocketService);
  private api = inject(FleetApiService);
  @ViewChild('dlg') dlg!: ElementRef<HTMLDialogElement>;

  @ViewChild('trigger') trigger!: ElementRef<HTMLButtonElement>;
  private host = inject(ElementRef<HTMLElement>);

  readonly hasOwn = computed(() => this.socket.networks().some((n) => n.id === 'own'));
  readonly menuOpen = signal(false);
  readonly active = signal(0);

  describe(n: NetworkInfo): string {
    if (n.id === 'own') return `${n.label} · ${n.source}`;
    return `Validated with ${n.label} · live from ${n.source}`;
  }

  toggle(): void {
    if (this.menuOpen()) return this.close();
    const i = this.socket.networks().findIndex((n) => n.id === this.socket.networkId());
    this.active.set(Math.max(0, i));
    this.menuOpen.set(true);
  }

  close(focusTrigger = false): void {
    this.menuOpen.set(false);
    if (focusTrigger) this.trigger?.nativeElement.focus();
  }

  choose(n: NetworkInfo): void {
    this.socket.setNetwork(n.id);
    this.close(true);
  }

  /** listbox keyboard: ↑ ↓ Home End to move, Enter / Space to pick, Esc / Tab to close */
  onKey(e: KeyboardEvent): void {
    const list = this.socket.networks();
    if (!this.menuOpen()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.toggle();
      }
      return;
    }
    const last = list.length - 1;
    if (e.key === 'ArrowDown') this.active.update((i) => Math.min(last, i + 1));
    else if (e.key === 'ArrowUp') this.active.update((i) => Math.max(0, i - 1));
    else if (e.key === 'Home') this.active.set(0);
    else if (e.key === 'End') this.active.set(last);
    else if (e.key === 'Enter' || e.key === ' ') list[this.active()] && this.choose(list[this.active()]);
    else if (e.key === 'Escape') this.close(true);
    else if (e.key === 'Tab') return this.close();
    else return;
    e.preventDefault();
  }

  /** click anywhere else closes the menu */
  @HostListener('document:click', ['$event'])
  onDocumentClick(e: MouseEvent): void {
    const dd = this.host.nativeElement.querySelector('.dd');
    if (this.menuOpen() && dd && !e.composedPath().includes(dd)) this.close();
  }
  readonly form = signal<OwnForm>({ algo: '', rpcUrl: '', rpcUser: '', rpcPassword: '', electrumHost: '', electrumPort: '', electrumTls: false });
  /** hash functions for "your node": the networks' first, then every other one the backend knows */
  readonly algoOptions = computed(() => {
    const seen = new Map<string, string>();
    for (const n of this.socket.networks()) if (n.id !== 'own') seen.set(n.algo, n.label);
    for (const a of this.socket.algorithms()) if (!seen.has(a.algo)) seen.set(a.algo, a.label);
    return [...seen].map(([algo, label]) => ({ algo, label }));
  });
  readonly busy = signal(false);
  readonly result = signal<{ ok: boolean; text: string } | null>(null);

  patch(p: Partial<OwnForm>): void {
    this.form.update((f) => ({ ...f, ...p }));
    this.result.set(null);
  }

  async open(): Promise<void> {
    this.dlg.nativeElement.showModal();
    try {
      const cfg = await this.api.getOwnNode();
      if (cfg) {
        this.form.set({
          algo: cfg.algo,
          rpcUrl: cfg.rpcUrl ?? '',
          rpcUser: cfg.rpcUser ?? '',
          rpcPassword: '', // never sent back; leave empty to type it again
          electrumHost: cfg.electrumHost ?? '',
          electrumPort: cfg.electrumPort ? String(cfg.electrumPort) : '',
          electrumTls: !!cfg.electrumTls,
        });
      } else {
        this.patch({ algo: this.socket.network()?.algo ?? this.algoOptions()[0]?.algo ?? '' });
      }
    } catch {
      /* keep what is in the form */
    }
  }

  async connect(): Promise<void> {
    const f = this.form();
    if (!f.rpcUrl.trim() && !f.electrumHost.trim()) {
      this.result.set({ ok: false, text: 'Enter your node’s RPC address, an Electrum server, or both.' });
      return;
    }
    this.busy.set(true);
    this.result.set(null);
    try {
      const cfg: OwnNodeConfig = {
        algo: f.algo,
        rpcUrl: f.rpcUrl.trim() || undefined,
        rpcUser: f.rpcUser.trim() || undefined,
        rpcPassword: f.rpcPassword || undefined,
        electrumHost: f.electrumHost.trim() || undefined,
        electrumPort: Number(f.electrumPort) || undefined,
        electrumTls: f.electrumTls,
      };
      const r = await this.api.connectOwnNode(cfg);
      this.result.set({ ok: true, text: `Connected. ${r.message}` });
      this.socket.setNetwork('own' as NetworkId);
    } catch (e) {
      this.result.set({ ok: false, text: (e as Error).message });
    } finally {
      this.busy.set(false);
    }
  }

  async disconnectOwn(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.disconnectOwnNode();
      const first = this.socket.networks().find((n) => n.id !== 'own');
      if (first) this.socket.setNetwork(first.id);
      this.result.set({ ok: true, text: `Your node is disconnected.${first ? ` The page shows ${first.chain} (${first.label}) from ${first.source} again.` : ''}` });
    } catch (e) {
      this.result.set({ ok: false, text: (e as Error).message });
    } finally {
      this.busy.set(false);
    }
  }
}
