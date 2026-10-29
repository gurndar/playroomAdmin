import crypto from 'node:crypto';

const COOKIE = 'playroom_admin';
const SESSION_MS = 14 * 60 * 60 * 1000; // a full Saturday shift
const LOCK_AFTER = 10;
const LOCK_MS = 10 * 60 * 1000;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest();
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Brute-force guard: 10 wrong tries per IP locks login for 10 minutes.
// Lives in memory, so on serverless it is per warm instance — a speed bump, not a wall.
export class LoginLimiter {
  constructor(now = Date.now) {
    this.now = now;
    this.failures = new Map();
  }

  isLocked(ip) {
    const f = this.failures.get(ip);
    return Boolean(f && f.count >= LOCK_AFTER && this.now() - f.at < LOCK_MS);
  }

  fail(ip) {
    const f = this.failures.get(ip);
    const fresh = !f || this.now() - f.at >= LOCK_MS;
    this.failures.set(ip, { count: fresh ? 1 : f.count + 1, at: fresh ? this.now() : f.at });
  }

  clear(ip) {
    this.failures.delete(ip);
  }
}

// ADMIN_PASSWORD (env) wins over the password set from the web. The cookie signature
// is keyed with whichever is active, so changing the password logs everyone out.
export class Auth {
  constructor({ store, envPassword = '', now = Date.now }) {
    this.store = store;
    this.envPassword = envPassword || '';
    this.now = now;
  }

  get configured() {
    return Boolean(this.envPassword) || this.store.hasPassword();
  }

  get #key() {
    const material = this.envPassword ? `env:${this.envPassword}` : `web:${this.store.passwordHash}`;
    return crypto.createHmac('sha256', this.store.secret).update(material).digest();
  }

  #sign(exp) {
    return crypto.createHmac('sha256', this.#key).update(String(exp)).digest('base64url');
  }

  checkPassword(input) {
    if (this.envPassword) return crypto.timingSafeEqual(sha256(input), sha256(this.envPassword));
    return this.store.verifyPassword(input);
  }

  issueCookie(secure) {
    const exp = this.now() + SESSION_MS;
    const value = `${exp}.${this.#sign(exp)}`;
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  isAdmin(cookieHeader) {
    if (!this.configured) return false;
    const value = parseCookies(cookieHeader)[COOKIE];
    if (!value) return false;
    const [exp, sig] = value.split('.');
    if (!exp || !sig || Number(exp) < this.now()) return false;
    const expected = Buffer.from(this.#sign(exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }
}
