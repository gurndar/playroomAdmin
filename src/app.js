import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { StoreError } from './store.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const PAGES = { '/': '/index.html', '/admin': '/admin.html' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new StoreError(415, 'JSON 요청만 허용됩니다.');
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new StoreError(413, '요청이 너무 큽니다.');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new StoreError(400, '잘못된 요청입니다.');
  }
}

function isSecure(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;
}

export function createApp({ store, auth, publicDir }) {
  const streams = new Set();
  let expiryTimer = null;

  const broadcast = () => {
    for (const res of streams) res.write('event: change\ndata: {}\n\n');
  };

  // Push an update the moment a timer hits zero. Event delivery is not throttled in
  // background tabs the way setInterval is, so the admin's notification fires on time.
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    const next = store.nextExpiry();
    if (next === null) return;
    const delay = Math.min(next - store.now() + 50, 2 ** 31 - 1);
    expiryTimer = setTimeout(() => {
      broadcast();
      scheduleExpiry();
    }, Math.max(0, delay));
  };

  store.onChange(() => {
    broadcast();
    scheduleExpiry();
  });
  scheduleExpiry();

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': ping\n\n');
  }, 25_000);

  const routes = [
    ['GET', /^\/api\/me$/, false, (req) => ({ admin: auth.isAdmin(req) })],
    ['GET', /^\/api\/lookup$/, false, (req, url) => store.lookup(url.searchParams.get('name'))],
    ['POST', /^\/api\/login$/, false, async (req, url, m, res) => {
      const ip = clientIp(req);
      if (auth.isLocked(ip)) throw new StoreError(429, '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.');
      const { password } = await readJson(req);
      if (!auth.checkPassword(password ?? '')) {
        auth.recordFailure(ip);
        throw new StoreError(401, '비밀번호가 올바르지 않습니다.');
      }
      auth.clearFailures(ip);
      res.setHeader('Set-Cookie', auth.issueCookie(isSecure(req)));
      return { admin: true };
    }],
    ['POST', /^\/api\/logout$/, false, (req, url, m, res) => {
      res.setHeader('Set-Cookie', auth.clearCookie());
      return { admin: false };
    }],
    ['GET', /^\/api\/state$/, true, (req, url) => {
      const date = url.searchParams.get('date');
      return store.snapshot(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined);
    }],
    ['POST', /^\/api\/rooms$/, true, async (req) => store.addRoom(await readJson(req))],
    ['PATCH', /^\/api\/rooms\/([\w-]+)$/, true, async (req, url, m) => store.updateRoom(m[1], await readJson(req))],
    ['DELETE', /^\/api\/rooms\/([\w-]+)$/, true, (req, url, m) => {
      store.deleteRoom(m[1]);
      return { ok: true };
    }],
    ['POST', /^\/api\/entries$/, true, async (req) => store.view(store.checkIn(await readJson(req)))],
    ['POST', /^\/api\/entries\/([\w-]+)\/(pause|resume|checkout)$/, true, (req, url, m) => {
      const action = { pause: 'pause', resume: 'resume', checkout: 'checkOut' }[m[2]];
      return store.view(store[action](m[1]));
    }],
    ['POST', /^\/api\/entries\/([\w-]+)\/adjust$/, true, async (req, url, m) => {
      const { minutes } = await readJson(req);
      return store.view(store.adjust(m[1], Number(minutes) * 60 * 1000));
    }],
    ['POST', /^\/api\/entries\/([\w-]+)\/move$/, true, async (req, url, m) => {
      const { roomId } = await readJson(req);
      return store.view(store.move(m[1], roomId));
    }],
    ['DELETE', /^\/api\/entries\/([\w-]+)$/, true, (req, url, m) => {
      store.removeEntry(m[1]);
      return { ok: true };
    }],
  ];

  function serveStatic(req, res, pathname) {
    const rel = PAGES[pathname] ?? pathname;
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, url.pathname);
    }

    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) return send(res, 404, { error: '없는 API입니다.' });
    const [, re, adminOnly, handler] = route;
    try {
      if (adminOnly && !auth.isAdmin(req)) throw new StoreError(401, '관리자 로그인이 필요합니다.');
      const result = await handler(req, url, url.pathname.match(re), res);
      send(res, 200, result);
    } catch (err) {
      if (err instanceof StoreError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: '서버 오류가 발생했습니다.' });
    }
  });

  server.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(expiryTimer);
  });
  server.closeStreams = () => {
    for (const res of streams) res.end();
    streams.clear();
  };
  return server;
}
