import crypto from 'node:crypto';

const COOKIE = 'playroom_admin';
const SESSION_MS = 14 * 60 * 60 * 1000; // a full Saturday shift

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest();
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  // Keying the signature with the password means changing the password logs everyone out.
  constructor({ password, secret, now = Date.now }) {
    this.passwordHash = sha256(password);
    this.key = crypto.createHmac('sha256', secret).update(password).digest();
    this.now = now;
    this.failures = new Map();
  }

  #sign(exp) {
    return crypto.createHmac('sha256', this.key).update(String(exp)).digest('base64url');
  }

  checkPassword(input) {
    return crypto.timingSafeEqual(sha256(input), this.passwordHash);
  }

  // Simple brute-force guard: 10 wrong tries per IP locks login for 10 minutes.
  isLocked(ip) {
    const f = this.failures.get(ip);
    return Boolean(f && f.count >= 10 && this.now() - f.at < 10 * 60 * 1000);
  }

  recordFailure(ip) {
    const f = this.failures.get(ip);
    const fresh = !f || this.now() - f.at >= 10 * 60 * 1000;
    this.failures.set(ip, { count: fresh ? 1 : f.count + 1, at: fresh ? this.now() : f.at });
  }

  clearFailures(ip) {
    this.failures.delete(ip);
  }

  issueCookie(secure) {
    const exp = this.now() + SESSION_MS;
    const value = `${exp}.${this.#sign(exp)}`;
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  isAdmin(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE];
    if (!value) return false;
    const [exp, sig] = value.split('.');
    if (!exp || !sig || Number(exp) < this.now()) return false;
    const expected = Buffer.from(this.#sign(exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }
}
