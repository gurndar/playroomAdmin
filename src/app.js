import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { handleApi } from './api.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PAGES = { '/': '/index.html', '/admin': '/admin.html' };

// Local server: one in-memory store for the process, persisted by the store's onSave.
export function createApp({ store, auth, limiter, publicDir }) {
  function serveStatic(res, pathname) {
    const file = path.normalize(path.join(publicDir, PAGES[pathname] ?? pathname));
    if (!file.startsWith(publicDir + path.sep)) return notFound(res);
    fs.readFile(file, (err, buf) => {
      if (err) return notFound(res);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
    });
  }

  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
      return serveStatic(res, url.pathname);
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10_000) break;
    }
    const result = handleApi({
      method: req.method,
      pathname: url.pathname,
      query: url.searchParams,
      cookie: req.headers.cookie,
      contentType: req.headers['content-type'],
      ip: String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress,
      secure: Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https',
      body,
    }, { store, auth, limiter });

    res.writeHead(result.status, {
      'Content-Type': MIME['.json'],
      'Cache-Control': 'no-store',
      ...(result.cookie ? { 'Set-Cookie': result.cookie } : {}),
    });
    res.end(JSON.stringify(result.body));
  });
}
