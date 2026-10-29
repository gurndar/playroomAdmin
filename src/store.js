import crypto from 'node:crypto';

export const ROOM_TYPES = { M: '남', F: '여' };

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// YYYY-MM-DD in the given time zone. 'en-CA' formats dates as ISO.
export function dateKey(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

// "홍 길동" and "홍길동" are treated as the same student.
export function normalizeName(name) {
  return String(name ?? '').replace(/\s+/g, '').toLowerCase();
}

const collator = new Intl.Collator('ko', { numeric: true });

const RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

export function emptyData() {
  return { version: 1, secret: crypto.randomBytes(32).toString('hex'), admin: null, rooms: [], entries: [] };
}

// Pure state + rules. Persistence is the caller's job: pass the loaded `data`
// in, and `onSave` (or checking `dirty`) gets the result out.
export class Store {
  constructor({ data = null, onSave = null, now = Date.now, timeZone = 'Asia/Seoul', durationMs = 90 * 60 * 1000 } = {}) {
    this.now = now;
    this.timeZone = timeZone;
    this.durationMs = durationMs;
    this.onSave = onSave;
    this.dirty = !data;
    this.data = data ? { ...emptyData(), ...data } : emptyData();
  }

  #commit() {
    this.dirty = true;
    this.onSave?.(this.data);
  }

  get secret() {
    return this.data.secret;
  }

  // ---------- admin password (scrypt hash, set once from the web on first run) ----------

  hasPassword() {
    return Boolean(this.data.admin?.hash);
  }

  get passwordHash() {
    return this.data.admin?.hash ?? null;
  }

  setPassword(password) {
    const clean = String(password ?? '');
    if (clean.length < 6) throw new StoreError(400, '비밀번호는 6자 이상으로 정해 주세요.');
    if (clean.length > 100) throw new StoreError(400, '비밀번호가 너무 깁니다.');
    const salt = crypto.randomBytes(16).toString('hex');
    this.data.admin = { salt, hash: crypto.scryptSync(clean, salt, 32).toString('hex') };
    this.#commit();
  }

  verifyPassword(password) {
    if (!this.hasPassword()) return false;
    const { salt, hash } = this.data.admin;
    const given = crypto.scryptSync(String(password ?? ''), salt, 32);
    return crypto.timingSafeEqual(given, Buffer.from(hash, 'hex'));
  }

  today() {
    return dateKey(this.now(), this.timeZone);
  }

  // ---------- rooms ----------

  #room(id) {
    const room = this.data.rooms.find((r) => r.id === id);
    if (!room) throw new StoreError(404, '존재하지 않는 구역입니다.');
    return room;
  }

  #validateRoom({ name, type }, exceptId = null) {
    const clean = String(name ?? '').trim();
    if (!clean) throw new StoreError(400, '호수를 입력해 주세요.');
    if (clean.length > 30) throw new StoreError(400, '호수는 30자 이내로 입력해 주세요.');
    if (!(type in ROOM_TYPES)) throw new StoreError(400, '구역 타입은 남/여 중 하나여야 합니다.');
    const dup = this.data.rooms.find((r) => r.id !== exceptId && normalizeName(r.name) === normalizeName(clean));
    if (dup) throw new StoreError(409, `'${clean}' 구역이 이미 있습니다.`);
    return clean;
  }

  addRoom({ name, type }) {
    const room = { id: crypto.randomUUID(), name: this.#validateRoom({ name, type }), type };
    this.data.rooms.push(room);
    this.#commit();
    return room;
  }

  updateRoom(id, { name, type }) {
    const room = this.#room(id);
    const next = { name: name ?? room.name, type: type ?? room.type };
    room.name = this.#validateRoom(next, id);
    room.type = next.type;
    this.#commit();
    return room;
  }

  deleteRoom(id) {
    this.#room(id);
    if (this.#todayEntries().some((e) => e.roomId === id && e.state !== 'done')) {
      throw new StoreError(409, '이용 중인 학생이 있는 구역은 삭제할 수 없습니다. 먼저 퇴실 처리해 주세요.');
    }
    this.data.rooms = this.data.rooms.filter((r) => r.id !== id);
    this.#commit();
  }

  sortedRooms() {
    return [...this.data.rooms].sort((a, b) => collator.compare(a.name, b.name));
  }

  // ---------- entries ----------

  #todayEntries() {
    const today = this.today();
    return this.data.entries.filter((e) => e.date === today);
  }

  #entry(id) {
    const entry = this.data.entries.find((e) => e.id === id);
    if (!entry) throw new StoreError(404, '존재하지 않는 기록입니다.');
    return entry;
  }

  #active(id) {
    const entry = this.#entry(id);
    if (entry.state === 'done') throw new StoreError(409, '이미 퇴실한 학생입니다.');
    return entry;
  }

  remainingMs(entry) {
    if (entry.state === 'running') return entry.endAt - this.now();
    if (entry.state === 'paused') return entry.remainingMs;
    return 0;
  }

  status(entry) {
    if (entry.state === 'done') return 'done';
    if (entry.state === 'running' && entry.endAt <= this.now()) return 'expired';
    return entry.state;
  }

  checkIn({ name, roomId }) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw new StoreError(400, '학생 이름을 입력해 주세요.');
    if (clean.length > 30) throw new StoreError(400, '이름은 30자 이내로 입력해 주세요.');
    const room = this.#room(roomId);
    const key = normalizeName(clean);
    const prev = this.#todayEntries().find((e) => e.nameKey === key);
    if (prev) {
      const where = this.data.rooms.find((r) => r.id === prev.roomId)?.name ?? prev.roomName;
      throw new StoreError(409, `${clean} 학생은 오늘 이미 입장했습니다 (${where}). 같은 날 중복 입장은 불가합니다.`);
    }
    const now = this.now();
    const entry = {
      id: crypto.randomUUID(),
      date: this.today(),
      name: clean,
      nameKey: key,
      roomId: room.id,
      roomName: room.name,
      roomType: room.type,
      checkInAt: now,
      state: 'running',
      endAt: now + this.durationMs,
      remainingMs: null,
      checkOutAt: null,
    };
    this.data.entries = this.data.entries.filter((e) => e.checkInAt > now - RETENTION_MS);
    this.data.entries.push(entry);
    this.#commit();
    return entry;
  }

  pause(id) {
    const entry = this.#active(id);
    if (entry.state === 'paused') return entry;
    entry.remainingMs = Math.max(0, entry.endAt - this.now());
    entry.endAt = null;
    entry.state = 'paused';
    this.#commit();
    return entry;
  }

  resume(id) {
    const entry = this.#active(id);
    if (entry.state === 'running') return entry;
    entry.endAt = this.now() + entry.remainingMs;
    entry.remainingMs = null;
    entry.state = 'running';
    this.#commit();
    return entry;
  }

  // Adding time to an already-expired student counts from now, not from the past end time.
  adjust(id, deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs === 0) throw new StoreError(400, '조정할 시간을 입력해 주세요.');
    const entry = this.#active(id);
    const now = this.now();
    if (entry.state === 'running') {
      entry.endAt = Math.max(now, Math.max(entry.endAt, now) + deltaMs);
    } else {
      entry.remainingMs = Math.max(0, entry.remainingMs + deltaMs);
    }
    this.#commit();
    return entry;
  }

  move(id, roomId) {
    const entry = this.#active(id);
    const room = this.#room(roomId);
    entry.roomId = room.id;
    entry.roomName = room.name;
    entry.roomType = room.type;
    this.#commit();
    return entry;
  }

  checkOut(id) {
    const entry = this.#active(id);
    entry.remainingMs = Math.max(0, this.remainingMs(entry));
    entry.endAt = null;
    entry.state = 'done';
    entry.checkOutAt = this.now();
    this.#commit();
    return entry;
  }

  // For registration mistakes: removing the record also lifts the same-day duplicate block.
  removeEntry(id) {
    this.#entry(id);
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    this.#commit();
  }

  // ---------- views ----------

  view(entry) {
    const room = this.data.rooms.find((r) => r.id === entry.roomId);
    return {
      id: entry.id,
      date: entry.date,
      name: entry.name,
      roomId: entry.roomId,
      roomName: room?.name ?? entry.roomName,
      roomType: room?.type ?? entry.roomType,
      checkInAt: entry.checkInAt,
      checkOutAt: entry.checkOutAt,
      status: this.status(entry),
      endAt: entry.endAt,
      remainingMs: this.remainingMs(entry),
    };
  }

  snapshot(date = this.today()) {
    return {
      now: this.now(),
      today: this.today(),
      date,
      durationMs: this.durationMs,
      dates: [...new Set(this.data.entries.map((e) => e.date))].sort().reverse(),
      rooms: this.sortedRooms(),
      entries: this.data.entries
        .filter((e) => e.date === date)
        .sort((a, b) => a.checkInAt - b.checkInAt)
        .map((e) => this.view(e)),
    };
  }

  lookup(name) {
    const key = normalizeName(name);
    if (!key) throw new StoreError(400, '이름을 입력해 주세요.');
    const entry = this.#todayEntries().find((e) => e.nameKey === key);
    const result = { now: this.now(), entry: null };
    if (entry) {
      const { id, name: n, roomName, roomType, status, endAt, remainingMs, checkInAt } = this.view(entry);
      result.entry = { id, name: n, roomName, roomType, status, endAt, remainingMs, checkInAt };
    }
    return result;
  }
}
