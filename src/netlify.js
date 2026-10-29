import { Store } from './store.js';
import { Auth, LoginLimiter } from './auth.js';
import { handleApi } from './api.js';

const KEY = 'state';
const MAX_ATTEMPTS = 5;

// Netlify function handler. Every request reads the whole state from Blobs, applies one
// action and, if anything changed, writes it back only if nobody else wrote in between
// (etag check). On a lost race the action is replayed on the fresh state.
export function createHandler({ blobs, env = {}, now = Date.now }) {
  const limiter = new LoginLimiter(now); // per warm instance
  const options = {
    now,
    timeZone: env.TIME_ZONE || 'Asia/Seoul',
    durationMs: Number(env.DURATION_MINUTES || 90) * 60 * 1000,
  };

  return async function handler(request, context = {}) {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const req = {
      method: request.method,
      pathname: url.pathname,
      query: url.searchParams,
      cookie: request.headers.get('cookie') ?? '',
      contentType: request.headers.get('content-type') ?? '',
      ip: context.ip ?? request.headers.get('x-nf-client-connection-ip') ?? 'unknown',
      secure: url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https',
      body,
    };

    const store = blobs();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
      const state = new Store({ ...options, data: current?.data ?? null });
      const auth = new Auth({ store: state, envPassword: env.ADMIN_PASSWORD, now });
      const result = handleApi(req, { store: state, auth, limiter });

      if (state.dirty) {
        const write = await store.setJSON(KEY, state.data, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
        if (!write.modified) continue;
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(result.cookie ? { 'Set-Cookie': result.cookie } : {}),
        },
      });
    }
    return new Response(JSON.stringify({ error: '동시에 요청이 몰렸습니다. 다시 시도해 주세요.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  };
}
