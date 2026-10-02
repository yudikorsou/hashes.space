/** Hex share hash -> string of bits ("0010…"). */
export function hexToBits(hex: string, maxBits = 256): string {
  let out = '';
  for (const c of hex.slice(0, Math.ceil(maxBits / 4))) out += parseInt(c, 16).toString(2).padStart(4, '0');
  return out.slice(0, maxBits);
}

/** Number of leading zero bits — the proof-of-work of a share. */
export function leadingZeroBits(hex: string): number {
  const bits = hexToBits(hex);
  const i = bits.indexOf('1');
  return i === -1 ? bits.length : i;
}

/**
 * The bit string rendered for one share: the last 24 leading zeros, the first 1,
 * then 11 more bits. Long enough to read as "matrix" code, short enough to fly.
 */
export function shareBits(hex: string, zerosShown = 24, tail = 12): string {
  const bits = hexToBits(hex);
  const lz = leadingZeroBits(hex);
  return bits.slice(Math.max(0, lz - zerosShown), lz + tail);
}

export function formatHashrate(ths: number): string {
  if (!ths) return '0 H/s';
  if (ths >= 1e6) return `${(ths / 1e6).toFixed(2)} EH/s`;
  if (ths >= 1e3) return `${(ths / 1e3).toFixed(2)} PH/s`;
  if (ths >= 1) return `${ths.toFixed(ths >= 100 ? 1 : 2)} TH/s`;
  return `${(ths * 1e3).toFixed(0)} GH/s`;
}

export function formatDiff(d: number): string {
  const units = ['', 'K', 'M', 'G', 'T', 'P'];
  let i = 0;
  while (d >= 1000 && i < units.length - 1) {
    d /= 1000;
    i++;
  }
  return `${d >= 100 || i === 0 ? d.toFixed(0) : d.toFixed(1)}${units[i]}`;
}

export function formatAgo(ms?: number, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function formatBtc(sats: number): string {
  return `${(sats / 1e8).toFixed(3)} BTC`;
}

/**
 * mempool colour scheme (as on mempool.guide).
 * Projected blocks: fee colour of the median fee (green → orange → magenta),
 * empty part #554b45. Mined blocks: purple → blue, empty part #2d3348.
 */
export const MEMPOOL_COLORS = {
  projectedEmpty: '#554b45',
  minedEmpty: '#2d3348',
  mined: ['#9339f4', '#105fb0'] as [string, string],
};

const FEE_LEVELS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1600, 1800, 2000];
const FEE_COLORS = [
  '557d00', '5d7d01', '637d02', '6d7d04', '757d05', '7d7d06', '867d08', '8c7d09', '957d0b', '9b7d0c',
  'a67d0e', 'aa7d0f', 'b27d10', 'bb7d11', 'bf7d12', 'bf7815', 'bf7319', 'be6c1e', 'be6820', 'bd6125',
  'bd5c28', 'bc552d', 'bc4f30', 'bc4a34', 'bb4339', 'bb3d3c', 'bb373f', 'ba3243', 'b92b48', 'b9254b',
  'b8214d', 'b71d4f', 'b61951', 'b41453', 'b30e55', 'b10857', 'b00259', 'ae005b',
];

/** sat/vB → mempool fee colour */
export function feeColor(rate: number): string {
  let i = FEE_LEVELS.findIndex((level) => rate < level);
  i = i === -1 ? FEE_COLORS.length - 1 : Math.max(0, i - 1);
  return '#' + FEE_COLORS[Math.min(i, FEE_COLORS.length - 1)];
}
