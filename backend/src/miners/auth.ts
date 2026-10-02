import crypto from 'crypto';

/**
 * Miner login: every miner has a username and password, so nobody else on the
 * network (or with the dashboard link) can open it and change its pools or
 * settings. New miners start with the default login below, which the owner
 * changes under Miner settings → Login.
 *
 * - Passwords are stored as salted scrypt hashes, never in plain text, and are
 *   never sent back to the page.
 * - A correct login gives a session token for that one miner (12 hours). The
 *   page sends it with every change (header x-miner-session) and when it opens
 *   the miner on the dashboard.
 * - 5 wrong passwords within 5 minutes lock that miner's login for a minute.
 * - Changing the login signs out every other session of that miner.
 */
export const DEFAULT_LOGIN = { username: 'admin', password: '123456789' } as const;

const SESSION_MS = 12 * 3_600_000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 5 * 60_000;
const LOCK_MS = 60_000;
const USERNAME_RE = /^[A-Za-z0-9._@-]{1,32}$/;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 429,
  ) {
    super(message);
  }
}

interface Credential {
  username: string;
  salt: string;
  hash: string;
  /** the password is still the default one (only the username was changed) */
  defaultPassword?: boolean;
}

interface Session {
  minerId: string;
  expiresAt: number;
}

export class MinerAuth {
  private creds = new Map<string, Credential>();
  private sessions = new Map<string, Session>();
  private fails = new Map<string, { n: number; first: number; lockedUntil: number }>();

  /** true while the miner still uses admin / 123456789 */
  isDefault(minerId: string): boolean {
    const c = this.creds.get(minerId);
    return !c || !!c.defaultPassword;
  }

  username(minerId: string): string {
    return this.creds.get(minerId)?.username ?? DEFAULT_LOGIN.username;
  }

  /** check username + password; returns a session token for this miner */
  login(minerId: string, username: string, password: string, now = Date.now()): { token: string; expiresAt: number } {
    const f = this.fails.get(minerId);
    if (f && f.lockedUntil > now) throw new AuthError(`Too many wrong passwords. Try again in ${Math.ceil((f.lockedUntil - now) / 1000)} s.`, 429);
    const ok = safeEqual(String(username ?? '').trim(), this.username(minerId)) && this.matches(minerId, String(password ?? ''));
    if (!ok) {
      const cur = f && now - f.first < FAIL_WINDOW_MS ? f : { n: 0, first: now, lockedUntil: 0 };
      cur.n++;
      if (cur.n >= MAX_FAILS) {
        cur.lockedUntil = now + LOCK_MS;
        cur.n = 0;
        cur.first = now;
      }
      this.fails.set(minerId, cur);
      throw new AuthError('Wrong username or password.', 401);
    }
    this.fails.delete(minerId);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_MS;
    this.sessions.set(token, { minerId, expiresAt });
    this.prune(now);
    return { token, expiresAt };
  }

  /** is this a valid session for this miner? */
  check(token: string | undefined, minerId: string, now = Date.now()): boolean {
    if (!token) return false;
    const s = this.sessions.get(token);
    if (!s || s.expiresAt < now) return false;
    return s.minerId === minerId;
  }

  /** which of these tokens are still valid, and for which miner */
  valid(tokens: string[], now = Date.now()): { token: string; minerId: string; expiresAt: number }[] {
    return tokens
      .map((token) => ({ token, s: this.sessions.get(token) }))
      .filter((x): x is { token: string; s: Session } => !!x.s && x.s.expiresAt > now)
      .map(({ token, s }) => ({ token, minerId: s.minerId, expiresAt: s.expiresAt }));
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  /** new username and/or password; the current password must be right. Other sessions are signed out. */
  change(minerId: string, currentPassword: string, username: string, newPassword: string, keepToken?: string): void {
    if (!this.matches(minerId, String(currentPassword ?? ''))) throw new AuthError('The current password is not right.', 403);
    const name = String(username ?? '').trim() || this.username(minerId);
    if (!USERNAME_RE.test(name)) throw new AuthError('Use 1 to 32 letters, digits or . _ @ - for the username.', 400);
    const pw = String(newPassword ?? '');
    if (pw) {
      if (pw.length < 8) throw new AuthError('Use a password of at least 8 characters.', 400);
      if (pw === DEFAULT_LOGIN.password) throw new AuthError('Pick a password other than the default one.', 400);
    }
    // only a username change keeps the current (maybe default) password
    const current = this.creds.get(minerId) ?? { ...hashed(DEFAULT_LOGIN.username, DEFAULT_LOGIN.password), defaultPassword: true };
    this.creds.set(minerId, pw ? hashed(name, pw) : { ...current, username: name });
    for (const [t, s] of this.sessions) if (s.minerId === minerId && t !== keepToken) this.sessions.delete(t);
  }

  /** factory reset: back to admin / 123456789 */
  reset(minerId: string, keepToken?: string): void {
    this.creds.delete(minerId);
    for (const [t, s] of this.sessions) if (s.minerId === minerId && t !== keepToken) this.sessions.delete(t);
  }

  private matches(minerId: string, password: string): boolean {
    const c = this.creds.get(minerId);
    if (!c) return safeEqual(password, DEFAULT_LOGIN.password); // still the default login
    return safeEqual(crypto.scryptSync(password, c.salt, 32).toString('hex'), c.hash);
  }

  private prune(now: number): void {
    if (this.sessions.size < 1000) return;
    for (const [t, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(t);
  }
}

function hashed(username: string, password: string): Credential {
  const salt = crypto.randomBytes(16).toString('hex');
  return { username, salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
