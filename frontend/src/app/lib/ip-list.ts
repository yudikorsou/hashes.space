/**
 * Parse a pasted list of miner IP addresses for a fleet. Shared by the page
 * (instant feedback), the backend (the real check) and the demo.
 *
 * Accepts IPv4 addresses separated by commas, spaces, semicolons or new lines,
 * plus ranges in the last part of the address:
 *   192.168.1.101, 192.168.1.102
 *   192.168.1.110-120          → 192.168.1.110 … 192.168.1.120
 *   192.168.1.110-192.168.1.120
 */
export interface IpListResult {
  /** valid, unique addresses in the order given */
  ips: string[];
  /** entries that are not an IP address or range, with the reason */
  invalid: { entry: string; reason: string }[];
  /** addresses given more than once */
  duplicates: string[];
}

/** the most addresses one paste may add (a /23 worth) */
export const MAX_FLEET_ADD = 512;

const OCTET = '(25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IP_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const RANGE_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}-(?:${OCTET}\\.${OCTET}\\.${OCTET}\\.)?${OCTET}$`);

export function parseIpList(text: string): IpListResult {
  const entries = String(text ?? '')
    .split(/[\s,;]+/)
    .map((e) => e.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const seen = new Set<string>();
  const ips: string[] = [];
  const invalid: { entry: string; reason: string }[] = [];
  const duplicates: string[] = [];
  const add = (ip: string) => {
    if (seen.has(ip)) {
      if (!duplicates.includes(ip)) duplicates.push(ip);
      return;
    }
    seen.add(ip);
    ips.push(ip);
  };

  for (const entry of entries) {
    const clean = entry.replace(/:\d+$/, ''); // "192.168.1.5:4028" → the IP
    if (IP_RE.test(clean)) {
      add(clean.split('.').map(Number).join('.')); // "192.168.001.005" → "192.168.1.5"
      continue;
    }
    if (RANGE_RE.test(clean)) {
      const [from, to] = clean.split('-');
      const base = from.split('.').map(Number);
      const toParts = to.split('.').map(Number);
      if (toParts.length === 4 && toParts.slice(0, 3).join('.') !== base.slice(0, 3).join('.')) {
        invalid.push({ entry, reason: 'a range must stay within one x.x.x.0–255 block' });
        continue;
      }
      const end = toParts[toParts.length - 1];
      if (end < base[3]) {
        invalid.push({ entry, reason: 'the range ends before it starts' });
        continue;
      }
      for (let i = base[3]; i <= end; i++) add(`${base[0]}.${base[1]}.${base[2]}.${i}`);
      continue;
    }
    invalid.push({ entry, reason: 'not an IP address' });
  }
  return { ips, invalid, duplicates };
}
