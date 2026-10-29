import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError, dateKey } from '../src/store.js';

const MIN = 60 * 1000;
// 2026-10-31 (Saturday) 14:00 KST
const START = Date.parse('2026-10-31T05:00:00Z');

function setup(opts = {}) {
  const clock = { t: START };
  const store = new Store({ now: () => clock.t, ...opts });
  const room = store.addRoom({ name: '301호', type: 'M' });
  return { clock, store, room };
}

test('dateKey uses the configured time zone', () => {
  // 23:30 UTC on the 30th is already the 31st in Seoul
  assert.equal(dateKey(Date.parse('2026-10-30T23:30:00Z'), 'Asia/Seoul'), '2026-10-31');
});

test('check-in starts a 90 minute countdown', () => {
  const { clock, store, room } = setup();
  const e = store.checkIn({ name: ' 홍길동 ', roomId: room.id });
  assert.equal(e.name, '홍길동');
  assert.equal(store.remainingMs(e), 90 * MIN);
  clock.t += 30 * MIN;
  assert.equal(store.remainingMs(e), 60 * MIN);
  assert.equal(store.status(e), 'running');
  clock.t += 60 * MIN;
  assert.equal(store.status(e), 'expired');
});

test('the same student cannot enter twice on the same day, even after checking out', () => {
  const { store, room } = setup();
  const e = store.checkIn({ name: '홍길동', roomId: room.id });
  assert.throws(() => store.checkIn({ name: '홍 길동', roomId: room.id }), (err) => err instanceof StoreError && err.status === 409);
  store.checkOut(e.id);
  assert.throws(() => store.checkIn({ name: '홍길동', roomId: room.id }), { message: /이미 입장/ });
});

test('the same student can enter again on the next day', () => {
  const { clock, store, room } = setup();
  store.checkIn({ name: '홍길동', roomId: room.id });
  clock.t += 7 * 24 * 60 * MIN;
  assert.doesNotThrow(() => store.checkIn({ name: '홍길동', roomId: room.id }));
});

test('removing a mistaken record lifts the duplicate block', () => {
  const { store, room } = setup();
  const e = store.checkIn({ name: '홍길동', roomId: room.id });
  store.removeEntry(e.id);
  assert.doesNotThrow(() => store.checkIn({ name: '홍길동', roomId: room.id }));
});

test('pause freezes the countdown and resume continues it', () => {
  const { clock, store, room } = setup();
  const e = store.checkIn({ name: 'A', roomId: room.id });
  clock.t += 10 * MIN;
  store.pause(e.id);
  clock.t += 30 * MIN;
  assert.equal(store.remainingMs(e), 80 * MIN);
  assert.equal(store.status(e), 'paused');
  store.resume(e.id);
  clock.t += 20 * MIN;
  assert.equal(store.remainingMs(e), 60 * MIN);
});

test('adjust adds and subtracts time, never below zero', () => {
  const { store, room } = setup();
  const e = store.checkIn({ name: 'A', roomId: room.id });
  store.adjust(e.id, 10 * MIN);
  assert.equal(store.remainingMs(e), 100 * MIN);
  store.adjust(e.id, -200 * MIN);
  assert.equal(store.remainingMs(e), 0);
  store.pause(e.id);
  store.adjust(e.id, 5 * MIN);
  assert.equal(store.remainingMs(e), 5 * MIN);
  store.adjust(e.id, -50 * MIN);
  assert.equal(store.remainingMs(e), 0);
});

test('adding time after expiry counts from now', () => {
  const { clock, store, room } = setup();
  const e = store.checkIn({ name: 'A', roomId: room.id });
  clock.t += 100 * MIN; // 10 minutes overdue
  store.adjust(e.id, 10 * MIN);
  assert.equal(store.remainingMs(e), 10 * MIN);
});

test('check-out freezes the record and blocks further changes', () => {
  const { clock, store, room } = setup();
  const e = store.checkIn({ name: 'A', roomId: room.id });
  clock.t += 30 * MIN;
  store.checkOut(e.id);
  assert.equal(store.status(e), 'done');
  assert.equal(e.remainingMs, 60 * MIN);
  assert.equal(e.checkOutAt, clock.t);
  assert.throws(() => store.pause(e.id), { status: 409 });
  assert.throws(() => store.adjust(e.id, MIN), { status: 409 });
});

test('rooms: validation, duplicates, natural sort, delete guard', () => {
  const { store, room } = setup();
  assert.throws(() => store.addRoom({ name: '', type: 'M' }), { status: 400 });
  assert.throws(() => store.addRoom({ name: '302호', type: 'X' }), { status: 400 });
  assert.throws(() => store.addRoom({ name: '301 호', type: 'F' }), { status: 409 });
  store.addRoom({ name: '1001호', type: 'F' });
  store.addRoom({ name: '205호', type: 'F' });
  assert.deepEqual(store.sortedRooms().map((r) => r.name), ['205호', '301호', '1001호']);

  const e = store.checkIn({ name: 'A', roomId: room.id });
  assert.throws(() => store.deleteRoom(room.id), { status: 409 });
  store.checkOut(e.id);
  store.deleteRoom(room.id);
  assert.equal(store.sortedRooms().length, 2);
});

test('move changes the room of an active entry', () => {
  const { store, room } = setup();
  const other = store.addRoom({ name: '402호', type: 'F' });
  const e = store.checkIn({ name: 'A', roomId: room.id });
  store.move(e.id, other.id);
  assert.equal(store.view(e).roomName, '402호');
  assert.equal(store.view(e).roomType, 'F');
});

test('lookup only finds today\'s entries and ignores spacing', () => {
  const { clock, store, room } = setup();
  store.checkIn({ name: '홍길동', roomId: room.id });
  const found = store.lookup('홍 길 동');
  assert.equal(found.entry.roomName, '301호');
  assert.equal(found.entry.status, 'running');
  assert.equal(store.lookup('김철수').entry, null);
  clock.t += 24 * 60 * MIN;
  assert.equal(store.lookup('홍길동').entry, null);
});

test('password: unset at first, scrypt-verified once set', () => {
  const { store } = setup();
  assert.equal(store.hasPassword(), false);
  assert.equal(store.verifyPassword('anything'), false);
  assert.throws(() => store.setPassword('123'), { status: 400 });
  store.setPassword('playroom!');
  assert.equal(store.verifyPassword('playroom!'), true);
  assert.equal(store.verifyPassword('wrong'), false);
  assert.doesNotMatch(JSON.stringify(store.data), /playroom!/);
});

test('state round-trips through onSave and reload', () => {
  let saved = null;
  const clock = { t: START };
  const a = new Store({ now: () => clock.t, onSave: (data) => (saved = JSON.parse(JSON.stringify(data))) });
  assert.equal(a.dirty, true); // fresh state must be written once so the secret sticks
  const room = a.addRoom({ name: '301호', type: 'M' });
  a.checkIn({ name: '홍길동', roomId: room.id });
  const b = new Store({ data: saved, now: () => clock.t });
  assert.equal(b.dirty, false);
  assert.equal(b.secret, a.secret);
  assert.equal(b.lookup('홍길동').entry.roomName, '301호');
  assert.throws(() => b.checkIn({ name: '홍길동', roomId: room.id }), { status: 409 });
});

test('records older than about a year are pruned on check-in', () => {
  const { clock, store, room } = setup();
  store.checkIn({ name: 'old', roomId: room.id });
  clock.t += 401 * 24 * 60 * MIN;
  store.checkIn({ name: 'new', roomId: room.id });
  assert.deepEqual(store.data.entries.map((e) => e.name), ['new']);
});
