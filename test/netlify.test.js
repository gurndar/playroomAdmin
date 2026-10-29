import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/netlify.js';

// In-memory stand-in for a Netlify Blobs store with etag-conditional writes.
function fakeBlobs() {
  let value = null;
  let version = 0;
  const api = {
    writes: 0,
    beforeWrite: null, // hook to simulate a concurrent writer
    async getWithMetadata() {
      return value === null ? null : { data: JSON.parse(value), etag: `"${version}"` };
    },
    async setJSON(key, data, opts = {}) {
      if (api.beforeWrite) {
        const hook = api.beforeWrite;
        api.beforeWrite = null;
        await hook();
      }
      if (opts.onlyIfNew && value !== null) return { modified: false };
      if (opts.onlyIfMatch && opts.onlyIfMatch !== `"${version}"`) return { modified: false };
      value = JSON.stringify(data);
      version++;
      api.writes++;
      return { modified: true, etag: `"${version}"` };
    },
    peek: () => (value === null ? null : JSON.parse(value)),
  };
  return api;
}

function client(handler) {
  let cookie = '';
  return async (method, path, body) => {
    const res = await handler(new Request(`https://playroom.netlify.app${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json(), setCookie };
  };
}

test('state persists across invocations through Blobs', async () => {
  const blobs = fakeBlobs();
  const call = client(createHandler({ blobs: () => blobs }));
  assert.deepEqual((await call('GET', '/api/me')).data, { admin: false, needsSetup: true });
  const secret = blobs.peek().secret; // first read writes the initial state so the secret is stable
  const setup = await call('POST', '/api/setup', { password: 'secret-pw' });
  assert.match(setup.setCookie, /Secure/);
  const room = (await call('POST', '/api/rooms', { name: '301호', type: 'M' })).data;
  await call('POST', '/api/entries', { name: '홍길동', roomId: room.id });
  assert.equal(blobs.peek().secret, secret);
  assert.equal((await call('GET', '/api/me')).data.admin, true);
  assert.equal((await call('GET', '/api/lookup?name=홍길동')).data.entry.roomName, '301호');
  assert.equal((await call('POST', '/api/entries', { name: '홍길동', roomId: room.id })).status, 409);
});

test('reads do not write', async () => {
  const blobs = fakeBlobs();
  const call = client(createHandler({ blobs: () => blobs }));
  await call('GET', '/api/me');
  const writes = blobs.writes;
  await call('GET', '/api/me');
  await call('GET', '/api/lookup?name=x');
  assert.equal(blobs.writes, writes);
});

test('a write that loses a race is replayed on the fresh state, so nothing is lost', async () => {
  const blobs = fakeBlobs();
  const handler = createHandler({ blobs: () => blobs });
  const admin1 = client(handler);
  const admin2 = client(handler);
  await admin1('POST', '/api/setup', { password: 'secret-pw' });
  await admin2('POST', '/api/login', { password: 'secret-pw' });

  // While admin1's request is between read and write, admin2 adds a room.
  blobs.beforeWrite = () => admin2('POST', '/api/rooms', { name: '302호', type: 'M' });
  const res = await admin1('POST', '/api/rooms', { name: '301호', type: 'M' });
  assert.equal(res.status, 200);
  assert.deepEqual(blobs.peek().rooms.map((r) => r.name).sort(), ['301호', '302호']);
});

test('ADMIN_PASSWORD env overrides the web-set password', async () => {
  const blobs = fakeBlobs();
  const call = client(createHandler({ blobs: () => blobs, env: { ADMIN_PASSWORD: 'from-env' } }));
  assert.equal((await call('GET', '/api/me')).data.needsSetup, false);
  assert.equal((await call('POST', '/api/setup', { password: 'whatever' })).status, 409);
  assert.equal((await call('POST', '/api/login', { password: 'from-env' })).status, 200);
});

test('DURATION_MINUTES env sets the session length', async () => {
  const blobs = fakeBlobs();
  const call = client(createHandler({ blobs: () => blobs, env: { DURATION_MINUTES: '60', ADMIN_PASSWORD: 'pw' } }));
  await call('POST', '/api/login', { password: 'pw' });
  const room = (await call('POST', '/api/rooms', { name: '1', type: 'F' })).data;
  const entry = (await call('POST', '/api/entries', { name: 'a', roomId: room.id })).data;
  assert.ok(entry.remainingMs <= 60 * 60 * 1000 && entry.remainingMs > 59 * 60 * 1000);
});
