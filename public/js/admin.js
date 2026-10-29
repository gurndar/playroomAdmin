import {
  api, syncClock, serverNow, remainingOf, liveStatus, formatDuration, formatClock,
  poll, el, toast, STATUS_LABEL, TYPE_LABEL,
} from './common.js';
import { createNotifier } from './notify.js';

const $ = (id) => document.getElementById(id);

let state = null;        // snapshot of today
let historyDate = null;  // date shown in the 기록 tab (null = today)
let historyState = null;
let filter = 'all';
let dialogEntryId = null;
let dialogRoomId = null;
const roomCards = new Map(); // roomId -> { card, list, input, ... } kept so typing survives refreshes

const notifier = createNotifier({
  onPermissionChange: renderNotice,
});

// ---------- auth ----------

let needsSetup = false;

async function boot() {
  const me = await api('GET', '/api/me');
  needsSetup = me.needsSetup;
  $('login-view').hidden = me.admin;
  $('app-view').hidden = !me.admin;
  $('login-title').textContent = needsSetup ? '🎮 관리자 비밀번호 설정' : '🎮 Playroom 관리자 로그인';
  $('setup-help').hidden = !needsSetup;
  $('password-confirm').hidden = !needsSetup;
  $('password-confirm').required = needsSetup;
  $('password').autocomplete = needsSetup ? 'new-password' : 'current-password';
  $('login-submit').textContent = needsSetup ? '설정하고 시작하기' : '로그인';
  if (me.admin) {
    await refresh();
    renderNotice();
  } else {
    $('password').focus();
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('password').value;
  if (needsSetup && password !== $('password-confirm').value) {
    $('login-error').textContent = '비밀번호 확인이 일치하지 않습니다.';
    return;
  }
  try {
    await api('POST', needsSetup ? '/api/setup' : '/api/login', { password });
    $('password').value = '';
    $('password-confirm').value = '';
    $('login-error').textContent = '';
    notifier.unlockSound();
    await boot();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  state = null;
  boot();
});

// ---------- data ----------

let lastFetch = 0;
let inflight = null;

function refresh() {
  inflight ??= load().finally(() => (inflight = null));
  return inflight;
}

async function load() {
  try {
    const next = await api('GET', '/api/state');
    lastFetch = Date.now();
    syncClock(next.now);
    state = next;
    if (historyDate && historyDate !== state.today) {
      historyState = await api('GET', `/api/state?date=${historyDate}`);
    } else {
      historyState = null;
    }
    render();
  } catch (err) {
    if (err.status === 401) return boot();
    toast(err.message, 'error');
  }
}

async function act(method, url, body, success) {
  notifier.unlockSound();
  try {
    await api(method, url, body);
    if (success) toast(success);
    await refresh();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 401) boot();
    return false;
  }
}

const entryUrl = (id, action = '') => `/api/entries/${id}${action ? `/${action}` : ''}`;

// ---------- rendering ----------

function render() {
  if (!state) return;
  renderBoard();
  renderAlerts();
  renderRoomTable();
  renderHistory();
  tick();
}

function activeEntries() {
  return state.entries.filter((e) => e.status !== 'done');
}

function timeText(entry) {
  const ms = remainingOf(entry);
  return ms < 0 ? `+${formatDuration(-ms)} 초과` : formatDuration(ms);
}

function studentRow(entry) {
  const status = liveStatus(entry);
  const paused = status === 'paused';
  return el('div', { class: `student ${status}`, dataset: { entry: entry.id } },
    el('div', { class: 'line' },
      el('span', { class: 'sname' }, entry.name),
      el('span', { class: `badge ${status}`, dataset: { role: 'badge' } }, STATUS_LABEL[status]),
      el('span', { class: 'time', dataset: { role: 'time' } }, timeText(entry)),
    ),
    el('div', { class: 'actions' },
      el('button', {
        class: 'small',
        type: 'button',
        onclick: () => act('POST', entryUrl(entry.id, paused ? 'resume' : 'pause')),
      }, paused ? '▶ 재개' : '⏸ 정지'),
      el('button', { class: 'small', type: 'button', onclick: () => adjust(entry, -5) }, '−5분'),
      el('button', { class: 'small', type: 'button', onclick: () => adjust(entry, 5) }, '+5분'),
      el('button', { class: 'small', type: 'button', onclick: () => adjust(entry, 10) }, '+10분'),
      el('button', { class: 'small ghost', type: 'button', title: '시간 직접 조정 · 구역 이동 · 삭제', onclick: () => openEntryDialog(entry.id) }, '⋯'),
      el('button', {
        class: `small push ${status === 'expired' ? 'danger solid' : 'danger'}`,
        type: 'button',
        onclick: () => checkOut(entry),
      }, '퇴실'),
    ),
  );
}

function adjust(entry, minutes) {
  return act('POST', entryUrl(entry.id, 'adjust'), { minutes }, `${entry.name}: ${minutes > 0 ? '+' : ''}${minutes}분`);
}

function checkOut(entry) {
  if (liveStatus(entry) !== 'expired' && !confirm(`${entry.name} 학생의 시간이 ${timeText(entry)} 남았습니다. 퇴실 처리할까요?`)) return;
  act('POST', entryUrl(entry.id, 'checkout'), undefined, `${entry.name} 퇴실 완료`);
}

function makeRoomCard(room) {
  const input = el('input', { placeholder: '학생 이름', maxlength: 30, 'aria-label': `${room.name}에 입장할 학생 이름` });
  const form = el('form', { class: 'add-student', autocomplete: 'off' },
    input,
    el('button', { class: 'primary small', type: 'submit' }, '입장'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    const ok = await act('POST', '/api/entries', { name, roomId: room.id }, `${name} 입장 (${Math.round(state.durationMs / 60000)}분)`);
    if (ok) input.value = '';
    input.focus();
  });
  const title = el('h3');
  const badge = el('span', { class: 'badge' });
  const count = el('span', { class: 'count' });
  const list = el('div', { class: 'students' });
  const card = el('article', { class: 'card room' }, el('div', { class: 'room-head' }, title, badge, count), list, form);
  return { card, title, badge, count, list };
}

function renderBoard() {
  const container = $('rooms');
  const active = activeEntries();
  const rooms = state.rooms.filter((r) => filter === 'all' || r.type === filter);
  const seen = new Set();

  for (const room of rooms) {
    seen.add(room.id);
    let parts = roomCards.get(room.id);
    if (!parts) roomCards.set(room.id, (parts = makeRoomCard(room)));
    const inRoom = active.filter((e) => e.roomId === room.id);
    parts.card.className = `card room ${room.type}`;
    parts.title.textContent = room.name;
    parts.badge.className = `badge ${room.type}`;
    parts.badge.textContent = TYPE_LABEL[room.type];
    parts.count.textContent = `${inRoom.length}명 이용 중`;
    parts.list.replaceChildren(...(inRoom.length ? inRoom.map(studentRow) : [el('div', { class: 'empty' }, '이용 중인 학생 없음')]));
    container.append(parts.card); // append moves existing nodes, so this also keeps the sort order
  }
  for (const [id, parts] of roomCards) {
    if (!seen.has(id)) {
      parts.card.remove();
      if (!state.rooms.some((r) => r.id === id)) roomCards.delete(id);
    }
  }

  $('no-rooms').hidden = state.rooms.length > 0;
  const counts = { running: 0, paused: 0, expired: 0 };
  for (const e of active) counts[liveStatus(e)]++;
  const done = state.entries.length - active.length;
  $('summary').textContent = `이용 중 ${counts.running} · 정지 ${counts.paused} · 시간 종료 ${counts.expired} · 퇴실 ${done}`;
}

function renderAlerts() {
  const expired = activeEntries().filter((e) => liveStatus(e) === 'expired');
  $('alerts').hidden = expired.length === 0;
  $('alert-list').replaceChildren(...expired.map((e) =>
    el('li', {},
      el('span', { class: 'who' }, `${e.roomName} · ${e.name}`),
      el('span', { class: 'muted', dataset: { entry: e.id, role: 'time' } }, timeText(e)),
      el('button', { class: 'small', type: 'button', onclick: () => adjust(e, 10) }, '+10분'),
      el('button', { class: 'small danger solid', type: 'button', onclick: () => checkOut(e) }, '퇴실'),
    )));
}

function renderRoomTable() {
  const active = activeEntries();
  $('room-table').replaceChildren(...(state.rooms.length ? state.rooms.map((room) =>
    el('tr', {},
      el('td', {}, el('b', {}, room.name)),
      el('td', {}, el('span', { class: `badge ${room.type}` }, TYPE_LABEL[room.type])),
      el('td', {}, `${active.filter((e) => e.roomId === room.id).length}명`),
      el('td', { style: 'text-align:right;white-space:nowrap' },
        el('button', { class: 'small', type: 'button', onclick: () => openRoomDialog(room) }, '수정'),
        ' ',
        el('button', {
          class: 'small danger',
          type: 'button',
          onclick: () => confirm(`${room.name} 구역을 삭제할까요?`) && act('DELETE', `/api/rooms/${room.id}`, undefined, `${room.name} 삭제됨`),
        }, '삭제'),
      ),
    )) : [el('tr', {}, el('td', { colspan: 4, class: 'empty' }, '등록된 구역이 없습니다.'))]));
}

function renderHistory() {
  const view = historyState ?? state;
  const select = $('history-date');
  const dates = [...new Set([state.today, ...state.dates])].sort().reverse();
  select.replaceChildren(...dates.map((d) => el('option', { value: d, selected: d === view.date }, d === state.today ? `${d} (오늘)` : d)));

  const isToday = view.date === state.today;
  const entries = [...view.entries].reverse();
  $('history-summary').textContent = `총 ${entries.length}명`;
  $('history-table').replaceChildren(...(entries.length ? entries.map((e) => {
    const status = isToday ? liveStatus(e) : e.status;
    return el('tr', {},
      el('td', {}, el('b', {}, e.name)),
      el('td', {}, `${e.roomName} `, el('span', { class: `badge ${e.roomType}` }, TYPE_LABEL[e.roomType])),
      el('td', { class: 'num' }, formatClock(e.checkInAt)),
      el('td', { class: 'num' }, e.checkOutAt ? formatClock(e.checkOutAt) : '—'),
      el('td', {}, el('span', { class: `badge ${status}` }, STATUS_LABEL[status])),
      el('td', { class: 'num', dataset: isToday && status !== 'done' ? { entry: e.id, role: 'time' } : {} },
        status === 'done' ? formatDuration(e.remainingMs) : timeText(e)),
      el('td', { style: 'text-align:right' },
        el('button', {
          class: 'small danger',
          type: 'button',
          onclick: () => confirm(`${e.name} 학생의 ${view.date} 기록을 삭제할까요?\n삭제하면 같은 날 다시 입장 등록할 수 있습니다.`)
            && act('DELETE', entryUrl(e.id), undefined, '기록 삭제됨'),
        }, '삭제'),
      ),
    );
  }) : [el('tr', {}, el('td', { colspan: 7, class: 'empty' }, '기록이 없습니다.'))]));
}

// Updates countdown text every tick without rebuilding the DOM, and fires the
// expiry alarm the moment a running timer crosses zero.
function tick() {
  $('clock').textContent = new Date(serverNow()).toLocaleTimeString('ko-KR');
  if (!state) return;
  let statusChanged = false;
  for (const entry of activeEntries()) {
    const status = liveStatus(entry);
    for (const node of document.querySelectorAll(`[data-entry="${entry.id}"][data-role="time"], [data-entry="${entry.id}"] [data-role="time"]`)) {
      node.textContent = timeText(entry);
    }
    const row = document.querySelector(`.student[data-entry="${entry.id}"]`);
    if (row && !row.classList.contains(status)) statusChanged = true;
    if (status === 'expired' && !notifier.hasAlerted(entry)) {
      // Another device may have added time since our last fetch; confirm before alarming.
      if (Date.now() - lastFetch > 10_000) refresh();
      else notifier.expired(entry);
    }
  }
  const expiredCount = activeEntries().filter((e) => liveStatus(e) === 'expired').length;
  notifier.setTitleAlert(expiredCount);
  if (statusChanged) render();
}

// ---------- notification notice ----------

function renderNotice() {
  const info = notifier.status();
  $('notify-notice').hidden = info.ok;
  $('notify-text').textContent = info.message;
  $('notify-enable').hidden = !info.canRequest;
}

$('notify-enable').addEventListener('click', async () => {
  notifier.unlockSound();
  await notifier.request();
  notifier.test();
});

// ---------- tabs & filters ----------

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role="tab"]')) t.setAttribute('aria-selected', String(t === tab));
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  });
}

for (const btn of document.querySelectorAll('#filter button')) {
  btn.addEventListener('click', () => {
    filter = btn.dataset.filter;
    for (const b of document.querySelectorAll('#filter button')) b.setAttribute('aria-pressed', String(b === btn));
    renderBoard();
  });
}

function segmentedValue(container) {
  return container.querySelector('[aria-pressed="true"]').dataset.type;
}
function setSegmented(container, value) {
  for (const b of container.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.type === value));
}
for (const container of [$('room-type'), $('room-edit-type')]) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (btn) setSegmented(container, btn.dataset.type);
  });
}

$('history-date').addEventListener('change', (e) => {
  historyDate = e.target.value === state.today ? null : e.target.value;
  refresh();
});

// ---------- rooms ----------

$('room-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('room-name').value.trim();
  const ok = await act('POST', '/api/rooms', { name, type: segmentedValue($('room-type')) }, `${name} 추가됨`);
  if (ok) $('room-name').value = '';
  $('room-name').focus();
});

function openRoomDialog(room) {
  dialogRoomId = room.id;
  $('room-edit-name').value = room.name;
  setSegmented($('room-edit-type'), room.type);
  $('room-dialog').showModal();
}

$('room-dialog').addEventListener('close', () => {
  if ($('room-dialog').returnValue !== 'save' || !dialogRoomId) return;
  act('PATCH', `/api/rooms/${dialogRoomId}`, {
    name: $('room-edit-name').value.trim(),
    type: segmentedValue($('room-edit-type')),
  }, '구역 수정됨');
});

// ---------- entry dialog ----------

function openEntryDialog(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  dialogEntryId = id;
  $('entry-title').textContent = `${entry.name} · ${entry.roomName}`;
  $('adjust-minutes').value = '';
  $('move-room').replaceChildren(...state.rooms.map((r) =>
    el('option', { value: r.id, selected: r.id === entry.roomId }, `${r.name} (${TYPE_LABEL[r.type]})`)));
  $('entry-dialog').showModal();
}

$('adjust-apply').addEventListener('click', async () => {
  const minutes = Number($('adjust-minutes').value);
  if (!Number.isFinite(minutes) || minutes === 0) return toast('조정할 분을 입력해 주세요.', 'error');
  const entry = state.entries.find((e) => e.id === dialogEntryId);
  if (await adjust(entry, minutes)) $('entry-dialog').close();
});

$('move-apply').addEventListener('click', async () => {
  const room = state.rooms.find((r) => r.id === $('move-room').value);
  if (await act('POST', entryUrl(dialogEntryId, 'move'), { roomId: room.id }, `${room.name}(으)로 이동`)) $('entry-dialog').close();
});

$('entry-delete').addEventListener('click', async () => {
  const entry = state.entries.find((e) => e.id === dialogEntryId);
  if (!confirm(`${entry.name} 학생의 오늘 기록을 삭제할까요?\n잘못 등록한 경우에만 사용하세요. 삭제하면 다시 입장 등록할 수 있습니다.`)) return;
  if (await act('DELETE', entryUrl(dialogEntryId), undefined, '기록 삭제됨')) $('entry-dialog').close();
});

// ---------- start ----------

setInterval(tick, 500);
document.addEventListener('pointerdown', () => notifier.unlockSound());
poll(() => state && refresh(), 5_000);
boot().catch((err) => toast(err.message, 'error'));
