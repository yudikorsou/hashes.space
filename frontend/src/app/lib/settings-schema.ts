/**
 * General miner settings for ANY ASIC.
 *
 * The groups below are what the web interfaces of Bitmain (Antminer), MicroBT
 * (WhatsMiner), Goldshell, iBeLink and Canaan (Avalon) have in common: the
 * settings a miner needs to run. Pools and the miner's name/hash function live
 * in their own section (they drive the three modes); everything else is here.
 *
 * This one file defines the fields, their defaults and their checks. It is used
 * by the backend (validation), the Angular settings page and the demo, so all
 * three always agree. Keep it free of Angular / Node imports.
 */

export type SettingsGroupId = 'performance' | 'cooling' | 'network' | 'security' | 'system';
export type MinerAction = 'locate' | 'reboot' | 'power-off' | 'power-on' | 'factory-reset' | 'password';

export type WorkMode = 'sleep' | 'low' | 'normal' | 'high' | 'custom';
export type FanMode = 'auto' | 'manual' | 'immersion';
export type PoolStrategy = 'failover' | 'load-balance';

export interface MinerSettings {
  performance: { mode: WorkMode; powerTargetW: number | null; frequencyMHz: number | null; voltageV: number | null; autotune: boolean };
  cooling: { fanMode: FanMode; targetTempC: number; fanSpeedPct: number; minFans: number; hotTempC: number; dangerTempC: number };
  network: { dhcp: boolean; ip: string; netmask: string; gateway: string; dns1: string; dns2: string; hostname: string };
  security: { apiAccess: 'read-write' | 'read' | 'off'; apiAllowedIps: string; ssh: boolean };
  system: { timezone: string; ntpServer: string };
}

export type FieldType = 'select' | 'number' | 'text' | 'toggle' | 'ipv4' | 'hostname' | 'timezone' | 'iplist';

export interface SettingsField {
  key: string;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  help?: string;
  /** may be left empty */
  optional?: boolean;
  /** only shown (and checked) when this returns true for the group's values */
  showIf?: (v: Record<string, unknown>) => boolean;
}

export interface SettingsGroup {
  id: SettingsGroupId;
  title: string;
  summary: string;
  /** shown above the save buttons when applying could cut the connection */
  caution?: (v: Record<string, unknown>, host?: string) => string | null;
  fields: SettingsField[];
  /** checks that involve more than one field */
  check?: (v: Record<string, unknown>) => string | null;
}

export interface ActionInfo {
  id: MinerAction;
  label: string;
  help: string;
  /** asks for an in-page confirmation first */
  confirm?: string;
  danger?: boolean;
  /** only shown while the miner is turned on ('on') or turned off ('off') */
  onlyWhen?: 'on' | 'off';
}

const custom = (v: Record<string, unknown>) => v['mode'] === 'custom';
const isStatic = (v: Record<string, unknown>) => v['dhcp'] === false;

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'performance',
    title: 'Performance',
    summary: 'How hard the miner works. Pick a preset, or Custom to set power, frequency and voltage yourself.',
    fields: [
      {
        key: 'mode',
        label: 'Work mode',
        type: 'select',
        options: [
          { value: 'sleep', label: 'Sleep (stop hashing, fans idle)' },
          { value: 'low', label: 'Low power (efficient, less hashrate)' },
          { value: 'normal', label: 'Normal (factory setting)' },
          { value: 'high', label: 'High performance (more hashrate and heat)' },
          { value: 'custom', label: 'Custom' },
        ],
      },
      { key: 'powerTargetW', label: 'Power target', type: 'number', unit: 'W', min: 100, max: 20000, step: 10, showIf: custom, help: 'The firmware keeps power use at or below this.' },
      { key: 'frequencyMHz', label: 'Chip frequency', type: 'number', unit: 'MHz', min: 50, max: 1500, step: 5, optional: true, showIf: custom, help: 'Leave empty to let the firmware choose.' },
      { key: 'voltageV', label: 'Hashboard voltage', type: 'number', unit: 'V', min: 10, max: 16, step: 0.05, optional: true, showIf: custom, help: 'Leave empty to let the firmware choose.' },
      { key: 'autotune', label: 'Autotuning', type: 'toggle', showIf: custom, help: 'Let the firmware tune each chip for the best hashrate per watt.' },
    ],
  },
  {
    id: 'cooling',
    title: 'Cooling',
    summary: 'Fans and temperature limits. The miner slows down at the throttle temperature and stops at the shutdown temperature.',
    fields: [
      {
        key: 'fanMode',
        label: 'Fan control',
        type: 'select',
        options: [
          { value: 'auto', label: 'Automatic (keep the chips at a target temperature)' },
          { value: 'manual', label: 'Fixed fan speed' },
          { value: 'immersion', label: 'Immersion or hydro cooling (no fans)' },
        ],
      },
      { key: 'targetTempC', label: 'Target chip temperature', type: 'number', unit: '°C', min: 40, max: 90, step: 1, showIf: (v) => v['fanMode'] === 'auto' },
      { key: 'fanSpeedPct', label: 'Fan speed', type: 'number', unit: '%', min: 10, max: 100, step: 5, showIf: (v) => v['fanMode'] === 'manual' },
      { key: 'minFans', label: 'Fans required to hash', type: 'number', min: 0, max: 4, step: 1, showIf: (v) => v['fanMode'] !== 'immersion', help: 'The miner won’t start with fewer working fans.' },
      { key: 'hotTempC', label: 'Throttle at', type: 'number', unit: '°C', min: 60, max: 100, step: 1 },
      { key: 'dangerTempC', label: 'Shut down at', type: 'number', unit: '°C', min: 70, max: 115, step: 1 },
    ],
    check: (v) => (Number(v['hotTempC']) >= Number(v['dangerTempC']) ? 'The throttle temperature must be lower than the shutdown temperature.' : null),
  },
  {
    id: 'network',
    title: 'Network',
    summary: 'How the miner gets its IP address. With DHCP your router hands one out; with a static address it never changes.',
    caution: (v, host) =>
      isStatic(v) && v['ip'] && v['ip'] !== host
        ? `After applying, the miner moves to ${v['ip']}. The dashboard follows it there.`
        : v['dhcp'] === true
          ? 'With DHCP the router may give the miner another IP address after a restart. Reconnect to the new one if the miner disappears.'
          : null,
    fields: [
      { key: 'dhcp', label: 'Get an IP address automatically (DHCP)', type: 'toggle' },
      { key: 'ip', label: 'IP address', type: 'ipv4', placeholder: '192.168.1.101', showIf: isStatic },
      { key: 'netmask', label: 'Subnet mask', type: 'ipv4', placeholder: '255.255.255.0', showIf: isStatic },
      { key: 'gateway', label: 'Gateway', type: 'ipv4', placeholder: '192.168.1.1', showIf: isStatic },
      { key: 'dns1', label: 'DNS server', type: 'ipv4', placeholder: '1.1.1.1', showIf: isStatic },
      { key: 'dns2', label: 'Second DNS server', type: 'ipv4', placeholder: '9.9.9.9', optional: true, showIf: isStatic },
      { key: 'hostname', label: 'Hostname', type: 'hostname', placeholder: 'miner-01', optional: true, help: 'The name the miner shows on your network.' },
    ],
  },
  {
    id: 'security',
    title: 'Security',
    summary: 'Who may talk to the miner. The dashboard needs read and write API access to change settings.',
    caution: (v) =>
      v['apiAccess'] !== 'read-write' ? 'With this API setting the dashboard can still read the miner but can no longer change its settings.' : null,
    fields: [
      {
        key: 'apiAccess',
        label: 'Miner API (port 4028)',
        type: 'select',
        options: [
          { value: 'read-write', label: 'Read and write (the dashboard can change settings)' },
          { value: 'read', label: 'Read only (status only)' },
          { value: 'off', label: 'Off' },
        ],
      },
      { key: 'apiAllowedIps', label: 'Allowed to use the API', type: 'iplist', placeholder: '192.168.1.0/24', optional: true, help: 'IP addresses or ranges, separated by commas. Leave empty for your whole local network.' },
      { key: 'ssh', label: 'SSH access', type: 'toggle', help: 'Remote command-line access. Leave it off unless you need it.' },
    ],
  },
  {
    id: 'system',
    title: 'System',
    summary: 'Clock settings the miner uses for its logs and pool connection.',
    fields: [
      { key: 'timezone', label: 'Time zone', type: 'timezone' },
      { key: 'ntpServer', label: 'Time server (NTP)', type: 'hostname', placeholder: 'pool.ntp.org' },
    ],
  },
];

export const MINER_ACTIONS: ActionInfo[] = [
  { id: 'locate', label: 'Find this miner', help: 'Blinks the miner’s LED for 60 seconds so you can spot it in the rack.' },
  { id: 'reboot', label: 'Reboot', help: 'Restarts the miner. It stops hashing for about a minute.', confirm: 'Reboot the miner now? It stops hashing for about a minute.' },
  {
    id: 'power-off',
    label: 'Turn off',
    help: 'Switches off the hashboards and fans. The miner stops hashing but stays reachable on your network, so you can turn it on again here.',
    confirm: 'Turn the miner off? It stops hashing until you turn it on again.',
    danger: true,
    onlyWhen: 'on',
  },
  { id: 'power-on', label: 'Turn on', help: 'The miner is turned off. Turning it on starts the hashboards and fans again; it hashes again after about a minute.', onlyWhen: 'off' },
  {
    id: 'factory-reset',
    label: 'Restore factory settings',
    help: 'Clears pools and every setting on this page, sets the login back to admin / 123456789 and restarts the miner.',
    confirm: 'Restore factory settings? The pools are cleared, so the miner stops hashing until you set them up again.',
    danger: true,
  },
];

export const POOL_STRATEGIES: { value: PoolStrategy; label: string }[] = [
  { value: 'failover', label: 'Failover: use Pool 1, switch to the next pool only if it goes down' },
  { value: 'load-balance', label: 'Load balance: share the hashrate over all pools' },
];

export function defaultSettings(): MinerSettings {
  return {
    performance: { mode: 'normal', powerTargetW: null, frequencyMHz: null, voltageV: null, autotune: true },
    cooling: { fanMode: 'auto', targetTempC: 65, fanSpeedPct: 80, minFans: 4, hotTempC: 85, dangerTempC: 95 },
    network: { dhcp: true, ip: '', netmask: '255.255.255.0', gateway: '', dns1: '', dns2: '', hostname: '' },
    security: { apiAccess: 'read-write', apiAllowedIps: '', ssh: false },
    system: { timezone: 'UTC', ntpServer: 'pool.ntp.org' },
  };
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const TZ = /^(UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

export interface GroupCheck {
  /** cleaned values, with numbers as numbers and hidden fields kept as they were */
  values: Record<string, unknown>;
  /** field key -> message */
  fieldErrors: Record<string, string>;
  groupError: string | null;
  ok: boolean;
}

/** Check (and clean) the values of one group. The same rules run in the browser and on the server. */
export function checkGroup(group: SettingsGroup, raw: Record<string, unknown>): GroupCheck {
  const values: Record<string, unknown> = { ...raw };
  const fieldErrors: Record<string, string> = {};

  for (const f of group.fields) {
    let v = raw[f.key];
    if (f.showIf && !f.showIf(values)) continue;
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

    if (f.type === 'toggle') {
      values[f.key] = v === true || v === 'true';
      continue;
    }
    if (empty) {
      values[f.key] = f.type === 'number' ? null : '';
      if (!f.optional) fieldErrors[f.key] = `Enter ${article(f.label)}.`;
      continue;
    }
    if (typeof v === 'string') v = v.trim();

    switch (f.type) {
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) fieldErrors[f.key] = 'Enter a number.';
        else if (f.min !== undefined && n < f.min) fieldErrors[f.key] = `Use ${f.min}${f.unit ? ' ' + f.unit : ''} or more.`;
        else if (f.max !== undefined && n > f.max) fieldErrors[f.key] = `Use ${f.max}${f.unit ? ' ' + f.unit : ''} or less.`;
        values[f.key] = Number.isFinite(n) ? n : v;
        break;
      }
      case 'select':
        if (!f.options?.some((o) => o.value === v)) fieldErrors[f.key] = 'Pick one of the options.';
        values[f.key] = v;
        break;
      case 'ipv4':
        if (!IPV4.test(String(v))) fieldErrors[f.key] = 'Use the form 192.168.1.101.';
        values[f.key] = v;
        break;
      case 'hostname':
        if (!HOSTNAME.test(String(v))) fieldErrors[f.key] = 'Use letters, numbers, dots and dashes only.';
        values[f.key] = v;
        break;
      case 'timezone':
        if (!TZ.test(String(v))) fieldErrors[f.key] = 'Pick a time zone from the list.';
        values[f.key] = v;
        break;
      case 'iplist': {
        const parts = String(v).split(',').map((p) => p.trim()).filter(Boolean);
        const bad = parts.find((p) => {
          const [ip, bits] = p.split('/');
          return !IPV4.test(ip) || (bits !== undefined && !(Number(bits) >= 0 && Number(bits) <= 32 && /^\d+$/.test(bits)));
        });
        if (bad) fieldErrors[f.key] = `"${bad}" is not an IP address or range (like 192.168.1.0/24).`;
        values[f.key] = parts.join(', ');
        break;
      }
      default:
        values[f.key] = String(v).slice(0, 200);
    }
  }

  const groupError = Object.keys(fieldErrors).length ? null : (group.check?.(values) ?? null);
  return { values, fieldErrors, groupError, ok: !Object.keys(fieldErrors).length && !groupError };
}

export function findGroup(id: string): SettingsGroup | undefined {
  return SETTINGS_GROUPS.find((g) => g.id === id);
}

function article(label: string): string {
  const l = label.charAt(0).toLowerCase() + label.slice(1);
  return /^[aeiou]/i.test(l) ? `an ${l}` : `a ${l}`;
}
