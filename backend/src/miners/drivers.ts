import { applyPoolsToRig, ApplyResult } from './pool-writer';
import { cgminerCommand } from './cgminer-poller';
import { Miner, MinerAction, SettingsGroupId } from '../types';

export type Capability = SettingsGroupId | MinerAction | 'pools';
export type Capabilities = Partial<Record<Capability, boolean>>;

/**
 * A driver knows how to change settings on one family of miners.
 *
 * Every manufacturer's firmware exposes a different write API (Bitmain CGI,
 * MicroBT's token API, Goldshell's REST API, LuxOS / Braiins commands, …), but
 * the settings page is the same for all of them. A driver says which groups it
 * can apply (`capabilities`); the page shows "Saved only" for the rest, so the
 * owner knows to set those on the miner itself.
 *
 * To support another brand, add a driver here and return it from pickDriver().
 */
export interface MinerDriver {
  name: string;
  capabilities: Capabilities;
  applySettings(m: Miner, group: SettingsGroupId | 'pools'): Promise<ApplyResult>;
  runAction(m: Miner, action: MinerAction, payload?: Record<string, unknown>): Promise<ApplyResult>;
}

const notSupported = (driver: string, what: string): ApplyResult => ({
  ok: false,
  message: `Saved. ${driver} can't change ${what} remotely, so set it on the miner's own web page as well.`,
});

/**
 * Generic cgminer API (TCP 4028): Bitmain bmminer, Braiins OS, Vnish, LuxOS,
 * Canaan and most others. Standard write commands only cover pools and a
 * restart of the mining software.
 */
export const cgminerDriver: MinerDriver = {
  name: 'cgminer API',
  capabilities: { pools: true, reboot: true },
  async applySettings(m, group) {
    if (group === 'pools') return m.host ? applyPoolsToRig(m.host, m.port ?? 4028, m.pools ?? []) : { ok: false, message: 'This miner has no IP address.' };
    return notSupported('The cgminer API', GROUP_WORDS[group]);
  },
  async runAction(m, action) {
    if (action !== 'reboot') return { ok: false, message: `The cgminer API can't ${ACTION_WORDS[action]} remotely. Do it on the miner's own web page.` };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await cgminerCommand(m.host!, m.port ?? 4028, 'restart');
      if (r?.STATUS?.[0]?.STATUS === 'E') return { ok: false, message: `The miner refused the restart ("${r.STATUS[0].Msg}"). Its API is probably read-only.` };
      return { ok: true, message: 'The mining software is restarting. Hashing resumes in about a minute.' };
    } catch (e) {
      return { ok: false, message: `Could not reach ${m.host} (${(e as Error).message}).` };
    }
  },
};

export const GROUP_WORDS: Record<SettingsGroupId | 'pools', string> = {
  pools: 'pools',
  performance: 'the work mode and power settings',
  cooling: 'fan and temperature settings',
  network: 'network settings',
  security: 'security settings',
  system: 'time settings',
};

export const ACTION_WORDS: Record<MinerAction, string> = {
  locate: 'blink the LED',
  reboot: 'reboot the miner',
  'power-off': 'turn the miner off',
  'power-on': 'turn the miner on',
  'factory-reset': 'restore factory settings',
  password: 'change the web interface password',
};
