import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Auth, LoginLimiter } from '../src/auth.js';
import { createApp } from '../src/app.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
let server;
let base;
let cookie = '';

async function call(method, url, body, { auth = true } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, setCookie: res.headers.get('set-cookie'), data: await res.json().catch(() => null) };
}

before(async () => {
  const store = new Store();
  server = createApp({ store, auth: new Auth({ store }), limiter: new LoginLimiter(), publicDir });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('first run asks for a password and login is refused until then', async () => {
  assert.deepEqual((await call('GET', '/api/me')).data, { admin: false, needsSetup: true });
  assert.equal((await call('POST', '/api/login', { password: 'x' })).status, 409);
  assert.equal((await call('GET', '/api/state')).status, 401);
});

test('setup sets the password once and logs in', async () => {
  assert.equal((await call('POST', '/api/setup', { password: '123' })).status, 400);
  const ok = await call('POST', '/api/setup', { password: 'secret-pw' });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  cookie = ok.setCookie.split(';')[0];
  assert.deepEqual((await call('GET', '/api/me')).data, { admin: true, needsSetup: false });
  assert.equal((await call('POST', '/api/setup', { password: 'hijack-pw' }, { auth: false })).status, 409);
});

test('login checks the password', async () => {
  assert.equal((await call('POST', '/api/login', { password: 'nope' }, { auth: false })).status, 401);
  const ok = await call('POST', '/api/login', { password: 'secret-pw' }, { auth: false });
  assert.equal(ok.status, 200);
  assert.ok(ok.setCookie);
});

test('a tampered cookie is not accepted', async () => {
  const res = await fetch(`${base}/api/me`, { headers: { Cookie: cookie.slice(0, -2) + 'xx' } });
  assert.equal((await res.json()).admin, false);
});

test('full flow: room, check-in, duplicate, adjust, pause, lookup, checkout', async () => {
  const room = (await call('POST', '/api/rooms', { name: '301호', type: 'M' })).data;
  assert.equal(room.type, 'M');

  const entry = (await call('POST', '/api/entries', { name: '홍길동', roomId: room.id })).data;
  assert.equal(entry.status, 'running');

  const dup = await call('POST', '/api/entries', { name: '홍길동', roomId: room.id });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /중복/);

  const adjusted = (await call('POST', `/api/entries/${entry.id}/adjust`, { minutes: 10 })).data;
  assert.ok(adjusted.remainingMs > 99 * 60 * 1000);

  const paused = (await call('POST', `/api/entries/${entry.id}/pause`)).data;
  assert.equal(paused.status, 'paused');

  const lookup = (await call('GET', `/api/lookup?name=${encodeURIComponent('홍길동')}`, undefined, { auth: false })).data;
  assert.equal(lookup.entry.roomName, '301호');
  assert.equal(lookup.entry.status, 'paused');

  const done = (await call('POST', `/api/entries/${entry.id}/checkout`)).data;
  assert.equal(done.status, 'done');

  const state = (await call('GET', '/api/state')).data;
  assert.equal(state.entries.length, 1);
  assert.equal(state.rooms.length, 1);
});

test('JSON content type is required for writes', async () => {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ name: '999호', type: 'M' }),
  });
  assert.equal(res.status, 415);
});

test('static pages are served and path traversal is blocked', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Playroom/);
  assert.equal((await fetch(`${base}/admin`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
});
