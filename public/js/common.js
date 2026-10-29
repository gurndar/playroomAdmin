// Shared helpers for the student and admin pages.

let clockOffset = 0; // server time - local time

export function serverNow() {
  return Date.now() + clockOffset;
}

export function syncClock(serverTime) {
  if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `요청 실패 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function remainingOf(entry) {
  if (entry.status === 'running' || entry.status === 'expired') return entry.endAt - serverNow();
  return entry.remainingMs ?? 0;
}

export function liveStatus(entry) {
  if (entry.status === 'running' && entry.endAt <= serverNow()) return 'expired';
  return entry.status;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

export const STATUS_LABEL = {
  running: '이용 중',
  paused: '일시정지',
  expired: '시간 종료',
  done: '퇴실 완료',
};

export const TYPE_LABEL = { M: '남', F: '여' };

// Server-sent events: the server only says "something changed", the page refetches.
export function subscribe(onChange) {
  const source = new EventSource('/api/events');
  source.addEventListener('change', onChange);
  source.addEventListener('open', onChange); // catch up after a reconnect
  return source;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer;
export function toast(message, kind = 'info') {
  let box = document.getElementById('toast');
  if (!box) {
    box = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  box.textContent = message;
  box.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.className = 'toast'), 3500);
}
