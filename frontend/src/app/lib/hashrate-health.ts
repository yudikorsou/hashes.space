/**
 * Hashrate health: how steady a miner's hashrate is compared with its rated
 * hashrate, how much of it reaches your node, and the geometry of the chart
 * that shows it. Shared by the Angular chart component and the standalone demo.
 */
/** [bucket start ms, reported TH/s | null, submitted to your node TH/s | null] */
export type Point = [number, number | null, number | null];
export type HealthLevel = 'good' | 'warn' | 'bad' | 'none';

export interface HashrateHealth {
  level: HealthLevel;
  label: string;
  detail: string;
  /** average TH/s over the readings in the range */
  avg: number;
  /** share of the range the miner was hashing, in % */
  uptimePct: number;
  /** average TH/s proven by shares that reached your node */
  submittedAvg: number;
  /** latest submitted TH/s */
  submittedNow: number;
}

const pct = (v: number) => Math.round(v * 100);
/** "about 40 min" / "about 2 h" */
const duration = (min: number) => (min < 90 ? `about ${Math.max(1, Math.round(min))} min` : `about ${+(min / 60).toFixed(1)} h`);

export function hashrateHealth(points: Point[], nominalThs: number, nowThs: number, rangeLabel: string, notHashingReason?: string): HashrateHealth {
  // the newest bucket may simply not have a reading yet: don't count it as a gap
  const pts = points.length && points[points.length - 1][1] === null ? points.slice(0, -1) : points;
  const stepMin = points.length > 1 ? (points[1][0] - points[0][0]) / 60_000 : 1;
  const first = pts.findIndex((p) => p[1] !== null);
  const seen = first < 0 ? [] : pts.slice(first);
  const vals = seen.map((p) => p[1]).filter((v): v is number => v !== null);
  const none = { avg: 0, uptimePct: 0, submittedAvg: 0, submittedNow: 0 };
  if (!vals.length) return { level: 'none', label: 'No data yet', detail: 'The chart fills in while the dashboard reads the miner.', ...none };

  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const rated = nominalThs > 0 ? nominalThs : avg;
  const gaps = seen.length - vals.length;
  const drops = vals.filter((v) => v < rated * 0.8).length;
  const uptimePct = pct(vals.filter((v) => v > 0).length / seen.length);
  const subs = seen.map((p) => p[2]).filter((v): v is number => v !== null);
  const submittedAvg = subs.length ? subs.reduce((a, b) => a + b, 0) / subs.length : 0;
  const submittedNow = subs.length ? subs[subs.length - 1] : 0;
  const base = { avg, uptimePct, submittedAvg, submittedNow };

  if (notHashingReason) return { level: 'bad', label: 'Not hashing', detail: notHashingReason, ...base, submittedNow: 0 };
  if (!nowThs) return { level: 'bad', label: 'Not hashing', detail: 'The miner reports 0 hashrate right now.', ...base };
  if (submittedAvg < avg * 0.5)
    return { level: 'warn', label: 'Not reaching your node', detail: submittedAvg ? `Only ${pct(submittedAvg / avg)} % of its hashrate reached your node in the last ${rangeLabel}. Check the pool.` : `The miner hashes, but none of it reached your node in the last ${rangeLabel}. Check the pool.`, ...base };
  if (avg < rated * 0.8) return { level: 'bad', label: 'Low hashrate', detail: `Averaging ${pct(avg / rated)} % of its rated hashrate over the last ${rangeLabel}.`, ...base };
  if (gaps || drops) {
    const parts = [drops && `below 80 % of rated for ${duration(drops * stepMin)}`, gaps && `offline for ${duration(gaps * stepMin)}`].filter(Boolean);
    return { level: 'warn', label: 'Unstable', detail: `In the last ${rangeLabel}: ${parts.join(', ')}.`, ...base };
  }
  if (avg < rated * 0.95) return { level: 'warn', label: 'Below rated', detail: `Steady, at ${pct(avg / rated)} % of its rated hashrate.`, ...base };
  return { level: 'good', label: 'Healthy', detail: `Steady at ${pct(avg / rated)} % of its rated hashrate, and ${pct(Math.min(1, submittedAvg / avg))} % of it reaches your node.`, ...base };
}

export interface ChartGeometry {
  /** reported by the miner */
  line: string;
  /** submitted to your node */
  line2: string;
  area: string;
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  /** y of the rated-hashrate line, or null when unknown */
  ratedY: number | null;
  x: (i: number) => number;
  y: (v: number) => number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** a round axis maximum a bit above the data, split into 4 round steps */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const step = v / 4;
  const e = 10 ** Math.floor(Math.log10(step));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]) if (m * e >= step) return 4 * m * e;
  return 40 * e;
}

export function chartGeometry(points: Point[], nominalThs: number, width: number, height: number, unit: (v: number) => string, timeLabel: (t: number) => string, xTickEvery: number): ChartGeometry {
  const left = 58, right = width - 12, top = 14, bottom = height - 26;
  const max = niceMax(Math.max(nominalThs * 1.08, ...points.map((p) => Math.max(p[1] ?? 0, p[2] ?? 0))) || 1);
  const n = Math.max(1, points.length - 1);
  const x = (i: number) => left + ((right - left) * i) / n;
  const y = (v: number) => bottom - ((bottom - top) * v) / max;

  let line = '', area = '', runStart = -1;
  const closeRun = (end: number) => {
    if (runStart < 0) return;
    area += `L${x(end).toFixed(1)},${bottom}L${x(runStart).toFixed(1)},${bottom}Z`;
    runStart = -1;
  };
  points.forEach(([, v], i) => {
    if (v === null) return closeRun(i - 1);
    const cmd = runStart < 0 ? 'M' : 'L';
    if (runStart < 0) runStart = i;
    line += `${cmd}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    area += `${cmd}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  closeRun(points.length - 1);
  let line2 = '', open = false;
  points.forEach(([, , v], i) => {
    if (v === null) return void (open = false);
    line2 += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    open = true;
  });

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: y(max * f), label: unit(max * f) }));
  const xTicks: { x: number; label: string }[] = [];
  // time labels on round times, thinned out so they never collide on a narrow screen
  points.forEach(([t], i) => {
    if (t % xTickEvery !== 0 || i === 0 || i === points.length - 1) return;
    const last = xTicks[xTicks.length - 1];
    if (!last || x(i) - last.x >= 76) xTicks.push({ x: x(i), label: timeLabel(t) });
  });
  return { line, line2, area, yTicks, xTicks, ratedY: nominalThs > 0 ? y(nominalThs) : null, x, y, left, right, top, bottom };
}
