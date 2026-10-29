import { StoreError } from './store.js';

// Platform-neutral API handler shared by the local Node server and the Netlify function.
// req: { method, pathname, query: URLSearchParams, cookie, contentType, ip, secure, body: string }
// Returns { status, body, cookie? }. Persisting `store` afterwards is the caller's job.

function json(req) {
  if (!String(req.contentType ?? '').includes('application/json')) {
    throw new StoreError(415, 'JSON 요청만 허용됩니다.');
  }
  try {
    return req.body ? JSON.parse(req.body) : {};
  } catch {
    throw new StoreError(400, '잘못된 요청입니다.');
  }
}

const routes = [
  ['GET', /^\/api\/me$/, false, ({ req, auth }) => ({ admin: auth.isAdmin(req.cookie), needsSetup: !auth.configured })],
  ['GET', /^\/api\/lookup$/, false, ({ req, store }) => store.lookup(req.query.get('name'))],

  // First run only: whoever opens /admin first chooses the password.
  ['POST', /^\/api\/setup$/, false, ({ req, store, auth }) => {
    if (auth.configured) throw new StoreError(409, '이미 비밀번호가 설정되어 있습니다.');
    store.setPassword(json(req).password);
    return { admin: true, cookie: auth.issueCookie(req.secure) };
  }],
  ['POST', /^\/api\/login$/, false, ({ req, auth, limiter }) => {
    if (!auth.configured) throw new StoreError(409, '먼저 관리자 비밀번호를 설정해 주세요.');
    if (limiter.isLocked(req.ip)) throw new StoreError(429, '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.');
    if (!auth.checkPassword(json(req).password ?? '')) {
      limiter.fail(req.ip);
      throw new StoreError(401, '비밀번호가 올바르지 않습니다.');
    }
    limiter.clear(req.ip);
    return { admin: true, cookie: auth.issueCookie(req.secure) };
  }],
  ['POST', /^\/api\/logout$/, false, ({ auth }) => ({ admin: false, cookie: auth.clearCookie() })],

  ['GET', /^\/api\/state$/, true, ({ req, store }) => {
    const date = req.query.get('date');
    return store.snapshot(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined);
  }],
  ['POST', /^\/api\/rooms$/, true, ({ req, store }) => store.addRoom(json(req))],
  ['PATCH', /^\/api\/rooms\/([\w-]+)$/, true, ({ req, store, m }) => store.updateRoom(m[1], json(req))],
  ['DELETE', /^\/api\/rooms\/([\w-]+)$/, true, ({ store, m }) => {
    store.deleteRoom(m[1]);
    return { ok: true };
  }],
  ['POST', /^\/api\/entries$/, true, ({ req, store }) => store.view(store.checkIn(json(req)))],
  ['POST', /^\/api\/entries\/([\w-]+)\/(pause|resume|checkout)$/, true, ({ store, m }) => {
    const action = { pause: 'pause', resume: 'resume', checkout: 'checkOut' }[m[2]];
    return store.view(store[action](m[1]));
  }],
  ['POST', /^\/api\/entries\/([\w-]+)\/adjust$/, true, ({ req, store, m }) =>
    store.view(store.adjust(m[1], Number(json(req).minutes) * 60 * 1000))],
  ['POST', /^\/api\/entries\/([\w-]+)\/move$/, true, ({ req, store, m }) => store.view(store.move(m[1], json(req).roomId))],
  ['DELETE', /^\/api\/entries\/([\w-]+)$/, true, ({ store, m }) => {
    store.removeEntry(m[1]);
    return { ok: true };
  }],
];

export function handleApi(req, { store, auth, limiter }) {
  const route = routes.find(([method, re]) => method === req.method && re.test(req.pathname));
  if (!route) return { status: 404, body: { error: '없는 API입니다.' } };
  const [, re, adminOnly, handler] = route;
  try {
    if (req.body && req.body.length > 10_000) throw new StoreError(413, '요청이 너무 큽니다.');
    if (adminOnly && !auth.isAdmin(req.cookie)) throw new StoreError(401, '관리자 로그인이 필요합니다.');
    const { cookie, ...body } = handler({ req, store, auth, limiter, m: req.pathname.match(re) }) ?? {};
    return { status: 200, body, cookie };
  } catch (err) {
    if (err instanceof StoreError) return { status: err.status, body: { error: err.message } };
    console.error(err);
    return { status: 500, body: { error: '서버 오류가 발생했습니다.' } };
  }
}
