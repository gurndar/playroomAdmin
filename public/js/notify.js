// Expiry alarms for the admin page: a system notification, a beep, and a blinking tab title.
// Each (entry, end time) pair alarms once, so adding time and running out again alarms again.

const STORAGE_KEY = 'playroom:notified';

function loadNotified() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')); } catch { return new Set(); }
}

export function createNotifier({ onPermissionChange = () => {} } = {}) {
  const notified = loadNotified();
  const supported = 'Notification' in window;
  const baseTitle = document.title;
  let audio = null;
  let registration = null;
  let titleTimer = null;
  let titleCount = 0;

  // Android Chrome only shows notifications through a service worker.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').then((reg) => (registration = reg)).catch(() => {});
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...notified].slice(-500))); } catch { /* ignore */ }
  }

  function status() {
    if (!window.isSecureContext) {
      return {
        ok: false,
        canRequest: false,
        message: '⚠️ 브라우저 알림은 HTTPS 또는 http://localhost 주소에서만 동작합니다. 지금은 화면 경고와 소리로만 알려드려요.',
      };
    }
    if (!supported) return { ok: false, canRequest: false, message: '⚠️ 이 브라우저는 알림을 지원하지 않습니다. 화면 경고와 소리로만 알려드려요.' };
    if (Notification.permission === 'granted') return { ok: true };
    if (Notification.permission === 'denied') {
      return { ok: false, canRequest: false, message: '⚠️ 알림이 차단되어 있습니다. 주소창 왼쪽 자물쇠 아이콘 → 알림 → 허용으로 바꿔 주세요.' };
    }
    return { ok: false, canRequest: true, message: '🔔 학생 시간이 끝나면 알림을 받으려면 알림을 켜 주세요.' };
  }

  async function request() {
    if (supported && Notification.permission === 'default') await Notification.requestPermission();
    onPermissionChange();
  }

  // Browsers only allow audio after a user gesture, so this is called from clicks.
  function unlockSound() {
    try {
      audio ??= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch { /* no audio */ }
  }

  function beep() {
    if (!audio) return;
    const start = audio.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, start + i * 0.35);
      gain.gain.exponentialRampToValueAtTime(0.3, start + i * 0.35 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.35 + 0.25);
      osc.connect(gain).connect(audio.destination);
      osc.start(start + i * 0.35);
      osc.stop(start + i * 0.35 + 0.3);
    }
  }

  function show(title, body, tag) {
    if (!supported || Notification.permission !== 'granted') return;
    const options = { body, tag, renotify: true, requireInteraction: true, icon: '/icon.svg' };
    if (registration) {
      registration.showNotification(title, options).catch(() => {});
      return;
    }
    try {
      const n = new Notification(title, options);
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch { /* constructor unsupported (mobile without service worker) */ }
  }

  function expired(entry) {
    const key = `${entry.id}:${entry.endAt}`;
    if (notified.has(key)) return;
    notified.add(key);
    persist();
    show('⏰ Playroom 시간 종료', `${entry.roomName} ${entry.name} 학생의 이용 시간이 끝났습니다. 퇴실 처리해 주세요.`, entry.id);
    beep();
  }

  // While anyone is overdue: blink the tab title and repeat the beep every minute.
  function setTitleAlert(count) {
    titleCount = count;
    if (count === 0) {
      clearInterval(titleTimer);
      titleTimer = null;
      document.title = baseTitle;
      return;
    }
    if (titleTimer) return;
    let seconds = 0;
    titleTimer = setInterval(() => {
      seconds++;
      document.title = seconds % 2 ? `⏰ 시간 종료 ${titleCount}명!` : baseTitle;
      if (seconds % 60 === 0) beep();
    }, 1000);
  }

  function test() {
    show('🔔 Playroom 알림 테스트', '알림이 정상적으로 동작합니다.', 'test');
    beep();
  }

  return { status, request, unlockSound, expired, setTitleAlert, test };
}
