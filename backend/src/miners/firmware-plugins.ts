import fs from 'fs';
import path from 'path';
import { Miner, MinerAction, SettingsGroupId } from '../types';
import { ApplyResult, applyPoolsToRig } from './pool-writer';
import { cgminerCommand, MinerReader, MinerReading, readCgminer } from './cgminer-poller';
import { Capabilities, MinerDriver } from './drivers';

/**
 * Firmware plugins: add support for your own mining firmware without touching the backend.
 *
 * Drop a .js file in backend/firmware/ (or the folder in FIRMWARE_DIR) and restart the
 * backend. Files whose name starts with "_" are skipped (see _example.js). A plugin says
 * which miners it handles (match), and can read them (read), change their settings
 * (applySettings) and run actions such as reboot (runAction). Anything it leaves out falls
 * back to the standard cgminer API on port 4028.
 *
 * Plugins run inside the backend with its full rights: only install plugins you trust.
 */
export interface FirmwarePlugin {
  /** shown on Miner settings ("Settings sent through …") */
  name: string;
  /** which miners this plugin talks to; the miner has host, port, model and firmwareVersion */
  match(miner: Miner): boolean;
  /** what the settings page may change; the rest shows "Saved only" */
  capabilities?: Capabilities;
  read?(miner: Miner, tools: PluginTools): Promise<MinerReading>;
  applySettings?(miner: Miner, group: SettingsGroupId | 'pools', tools: PluginTools): Promise<ApplyResult>;
  runAction?(miner: Miner, action: MinerAction, payload: Record<string, unknown>, tools: PluginTools): Promise<ApplyResult>;
}

/** Helpers every plugin gets, so a plugin needs no dependencies of its own. */
export interface PluginTools {
  /** one cgminer API command, e.g. cgminer(host, 4028, 'summary') */
  cgminer: typeof cgminerCommand;
  /** a full reading through the cgminer API, to start from and adjust */
  readCgminer: typeof readCgminer;
  /** write pools through the cgminer API (addpool / switchpool / removepool) */
  applyPoolsToRig: typeof applyPoolsToRig;
  /** HTTP(S) request to the miner's own web API (Node's built-in fetch) */
  fetch: typeof fetch;
  log: (...args: unknown[]) => void;
}

export interface LoadedPlugin {
  file: string;
  plugin?: FirmwarePlugin;
  error?: string;
}

const tools = (name: string): PluginTools => ({
  cgminer: cgminerCommand,
  readCgminer,
  applyPoolsToRig,
  fetch: (...args) => fetch(...args),
  log: (...args) => console.log(`[firmware:${name}]`, ...args),
});

export class FirmwarePlugins {
  readonly loaded: LoadedPlugin[] = [];

  constructor(private dir: string) {}

  /** (re)load every plugin file in the folder */
  load(): this {
    this.loaded.length = 0;
    if (!fs.existsSync(this.dir)) return this;
    for (const f of fs.readdirSync(this.dir).filter((x) => /\.(c?js)$/.test(x) && !x.startsWith('_')).sort()) {
      const file = path.join(this.dir, f);
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(file);
        const p: FirmwarePlugin = mod?.default ?? mod;
        const problem = check(p);
        if (problem) throw new Error(problem);
        this.loaded.push({ file: f, plugin: p });
        console.log(`[firmware] loaded ${p.name} (${f})`);
      } catch (e) {
        this.loaded.push({ file: f, error: (e as Error).message });
        console.warn(`[firmware] skipped ${f}: ${(e as Error).message}`);
      }
    }
    return this;
  }

  /** the plugin for this miner: the one named in miners.json ("firmware": "<name>"), else the first that matches */
  for(m: Miner): FirmwarePlugin | undefined {
    const plugins = this.loaded.map((l) => l.plugin).filter((p): p is FirmwarePlugin => !!p);
    const wanted = m.firmware?.toLowerCase();
    if (wanted) return plugins.find((p) => p.name.toLowerCase() === wanted);
    return plugins.find((p) => {
      try {
        return p.match(m);
      } catch {
        return false;
      }
    });
  }

  /** read() of the miner's plugin, if it has one */
  readerFor(m: Miner): MinerReader | undefined {
    const p = this.for(m);
    return p?.read ? (miner) => p.read!(miner, tools(p.name)) : undefined;
  }

  /** a settings driver built from the plugin; missing parts fall back to the cgminer API driver */
  driverFor(m: Miner, fallback: MinerDriver): MinerDriver | undefined {
    const p = this.for(m);
    if (!p) return undefined;
    return {
      name: p.name,
      capabilities: p.capabilities ?? fallback.capabilities,
      applySettings: (miner, group) => (p.applySettings ? p.applySettings(miner, group, tools(p.name)) : fallback.applySettings(miner, group)),
      runAction: (miner, action, payload) => (p.runAction ? p.runAction(miner, action, payload ?? {}, tools(p.name)) : fallback.runAction(miner, action, payload)),
    };
  }

  /** for GET /api/v1/firmware */
  list(): { file: string; name?: string; capabilities?: Capabilities; reads: boolean; error?: string }[] {
    return this.loaded.map((l) => ({ file: l.file, name: l.plugin?.name, capabilities: l.plugin?.capabilities, reads: !!l.plugin?.read, error: l.error }));
  }
}

function check(p: FirmwarePlugin | undefined): string | null {
  if (!p || typeof p !== 'object') return 'the file must export a plugin object (module.exports = { name, match, … })';
  if (typeof p.name !== 'string' || !p.name.trim()) return 'the plugin needs a name';
  if (typeof p.match !== 'function') return 'the plugin needs a match(miner) function';
  for (const k of ['read', 'applySettings', 'runAction'] as const) if (p[k] !== undefined && typeof p[k] !== 'function') return `${k} must be a function`;
  return null;
}
