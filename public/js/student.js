import { api, syncClock, remainingOf, liveStatus, formatDuration, formatClock, poll, el, STATUS_LABEL, TYPE_LABEL } from './common.js';

const form = document.getElementById('search-form');
const input = document.getElementById('name');
const result = document.getElementById('result');
const STORAGE_KEY = 'playroom:lastName';

let current = null; // { query, entry }

function readSaved() {
  try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
}
function save(name) {
  try { localStorage.setItem(STORAGE_KEY, name); } catch { /* private mode */ }
}

function render() {
  result.hidden = !current;
  if (!current) return;
  const { query, entry } = current;
  if (!entry) {
    result.replaceChildren(
      el('div', { class: 'name' }, `'${query}' 학생을 찾을 수 없어요`),
      el('p', { class: 'note' }, '오늘 입장 기록이 없어요. 이름을 정확히 입력했는지 확인하거나 선생님께 문의하세요.'),
    );
    return;
  }
  const status = liveStatus(entry);
  const note = {
    running: `입장 ${formatClock(entry.checkInAt)} · 종료 예정 ${formatClock(entry.endAt)}`,
    paused: '선생님이 시간을 잠시 멈췄어요. 다시 시작되면 이어서 줄어들어요.',
    expired: '이용 시간이 끝났어요. 정리하고 퇴실해 주세요.',
    done: '퇴실 처리가 완료되었어요. 즐거운 시간 보냈길 바라요!',
  }[status];
  result.replaceChildren(
    el('div', { class: 'name' }, entry.name),
    el('div', { class: 'room-line' }, `${entry.roomName} `, el('span', { class: `badge ${entry.roomType}` }, TYPE_LABEL[entry.roomType])),
    el('div', { class: `countdown ${status}`, id: 'countdown' }, formatDuration(remainingOf(entry))),
    el('div', {}, el('span', { class: `badge ${status}` }, STATUS_LABEL[status])),
    el('p', { class: 'note' }, note),
  );
}

async function lookup(query) {
  try {
    const data = await api('GET', `/api/lookup?name=${encodeURIComponent(query)}`);
    syncClock(data.now);
    current = { query, entry: data.entry };
    if (data.entry) save(query);
    render();
  } catch (err) {
    current = { query, entry: null };
    result.hidden = false;
    result.replaceChildren(el('p', { class: 'note' }, err.message));
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const query = input.value.trim();
  if (query) lookup(query);
});

setInterval(() => {
  if (!current?.entry) return;
  const status = liveStatus(current.entry);
  const box = document.getElementById('countdown');
  if (!box) return;
  if (!box.classList.contains(status)) render();
  else box.textContent = formatDuration(remainingOf(current.entry));
}, 250);

poll(() => current && lookup(current.query), 15_000);

const saved = readSaved();
if (saved) {
  input.value = saved;
  lookup(saved);
}
