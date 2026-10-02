/**
 * Framework-agnostic canvas renderer that flies strings of 0s and 1s from a
 * miner's fan into the block currently being mined.
 *
 *  - one full-viewport <canvas> (pointer-events: none) holds every stream
 *  - each stream follows a cubic Bézier: up out of the fan, then into the block
 *  - the head glyph glows, the tail fades; leading zeros stay fixed (they are
 *    the proof-of-work), the bits after them flicker like "matrix" code
 *  - rejected shares turn red and crumble half-way
 *  - lucky shares (much higher difficulty than usual) get an orange head
 *
 * The render loop runs only while streams are in flight.
 */

export interface Point {
  x: number;
  y: number;
}

export interface LaunchOptions {
  accepted?: boolean;
  lucky?: boolean;
  /** called once when the head of the stream reaches the block */
  onArrive?: () => void;
}

interface Stream {
  p0: Point;
  c1: Point;
  c2: Point;
  target: () => Point;
  chars: string[];
  fixed: number; // glyphs that never flicker (leading zeros)
  born: number;
  dur: number;
  gap: number; // tail spacing in curve-parameter units
  accepted: boolean;
  lucky: boolean;
  arrived: boolean;
  onArrive?: () => void;
  deadAt?: number;
}

export interface StreamTheme {
  color: string; // rgb triplet "60, 226, 107"
  head: string; // css colour of the head glyph
  luckyHead: string;
  reject: string; // rgb triplet
  font: string;
  spacing: number; // px between glyphs
}

const DEFAULT_THEME: StreamTheme = {
  color: '60, 226, 107',
  head: '#dcffe6',
  luckyHead: '#ffb347',
  reject: '255, 92, 92',
  font: '600 12px "IBM Plex Mono", ui-monospace, monospace',
  spacing: 11,
};

export class ShareStreamRenderer {
  private ctx: CanvasRenderingContext2D;
  private streams: Stream[] = [];
  private raf = 0;
  private dpr = 1;
  private theme: StreamTheme;
  private reducedMotion = false;

  constructor(private canvas: HTMLCanvasElement, theme: Partial<StreamTheme> = {}, private maxStreams = 60) {
    this.ctx = canvas.getContext('2d')!;
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * this.dpr);
    this.canvas.height = Math.round(window.innerHeight * this.dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
  }

  get active(): number {
    return this.streams.length;
  }

  launch(from: Point, target: () => Point, bits: string, opts: LaunchOptions = {}): void {
    if (this.reducedMotion) {
      opts.onArrive?.();
      return;
    }
    const to = target();
    const dy = Math.max(120, from.y - to.y);
    const jitter = (n: number) => (Math.random() - 0.5) * n;
    const p0 = { x: from.x + jitter(6), y: from.y };
    const c1 = { x: from.x + jitter(80), y: from.y - dy * 0.55 };
    const c2 = { x: to.x + jitter(120), y: to.y + dy * 0.45 };
    const len = approxLength(p0, c1, c2, to);
    const chars = bits.split('');
    const lz = bits.indexOf('1');

    this.streams.push({
      p0,
      c1,
      c2,
      target,
      chars,
      fixed: lz === -1 ? chars.length : lz + 1,
      born: performance.now(),
      dur: 900 + Math.min(900, len * 1.1) + Math.random() * 250,
      gap: this.theme.spacing / Math.max(1, len),
      accepted: opts.accepted !== false,
      lucky: !!opts.lucky,
      arrived: false,
      onArrive: opts.onArrive,
    });
    if (this.streams.length > this.maxStreams) this.streams.splice(0, this.streams.length - this.maxStreams);
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.streams = [];
  }

  private frame = (now: number) => {
    const { ctx, dpr, theme } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = theme.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    this.streams = this.streams.filter((s) => this.draw(s, now));
    this.raf = this.streams.length ? requestAnimationFrame(this.frame) : 0;
    if (!this.raf) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };

  /** returns false when the stream is finished */
  private draw(s: Stream, now: number): boolean {
    const { ctx, theme } = this;
    const p = (now - s.born) / s.dur;
    const tail = s.chars.length * s.gap;
    // ease-out on the head so the stream "leaps" out of the fan and settles into the block
    let head = easeOutCubic(Math.min(1, p)) * (1 + tail) + Math.max(0, p - 1) * 0.9;
    const to = s.target();

    let fade = 1;
    let fall = 0;
    if (!s.accepted && head > 0.55) {
      s.deadAt ??= now;
      head = 0.55;
      const d = (now - s.deadAt) / 500;
      fade = 1 - d;
      fall = d * d * 60;
      if (fade <= 0) return false;
    }

    if (s.accepted && !s.arrived && head >= 1) {
      s.arrived = true;
      s.onArrive?.();
    }
    if (head - tail >= 1) return false;

    const rgb = s.accepted ? theme.color : theme.reject;
    for (let i = s.chars.length - 1; i >= 0; i--) {
      const t = head - i * s.gap;
      if (t < 0 || t > 1) continue;
      if (i >= s.fixed && Math.random() < 0.04) s.chars[i] = s.chars[i] === '0' ? '1' : '0';

      const pt = bezier(s.p0, s.c1, s.c2, to, t);
      const y = pt.y + (fall ? fall * (0.4 + ((i * 37) % 10) / 10) : 0);
      // shrink into the block as the glyph reaches it
      const sink = t > 0.93 ? (1 - t) / 0.07 : 1;
      const k = 1 - i / s.chars.length;
      const alpha = Math.max(0, (0.18 + 0.82 * k ** 1.6) * fade * sink);

      if (i === 0) {
        ctx.shadowColor = s.lucky ? theme.luckyHead : `rgb(${rgb})`;
        ctx.shadowBlur = 12;
        ctx.fillStyle = s.accepted ? (s.lucky ? theme.luckyHead : theme.head) : `rgb(${rgb})`;
        ctx.globalAlpha = fade * sink;
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        ctx.globalAlpha = 1;
      }
      ctx.fillText(s.chars[i], pt.x, y);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    return true;
  }
}

function bezier(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y };
}

function approxLength(p0: Point, c1: Point, c2: Point, p1: Point): number {
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= 16; i++) {
    const pt = bezier(p0, c1, c2, p1, i / 16);
    len += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    prev = pt;
  }
  return len;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}
