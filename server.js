import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';
import { Auth } from './src/auth.js';
import { createApp } from './src/app.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.PORT ?? 3000);
const minutes = Number(process.env.DURATION_MINUTES ?? 90);

// Without ADMIN_PASSWORD a random one is generated once and kept in the data folder.
function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const file = path.join(dataDir, 'admin-password.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const generated = crypto.randomBytes(6).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, generated + '\n');
  return generated;
}

const store = new Store({
  file: path.join(dataDir, 'playroom.json'),
  timeZone: process.env.TIME_ZONE ?? 'Asia/Seoul',
  durationMs: minutes * 60 * 1000,
});
const password = adminPassword();
const auth = new Auth({ password, secret: store.secret });
const server = createApp({ store, auth, publicDir: path.join(root, 'public') });

server.listen(port, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${port}`);
  console.log('Playroom 서버가 시작되었습니다.');
  console.log(`  관리자 페이지: http://localhost:${port}/admin  (알림이 동작하려면 이 주소 또는 HTTPS로 접속)`);
  console.log(`  학생 조회 페이지: ${[`http://localhost:${port}`, ...lan].join('  ')}`);
  console.log(`  기본 이용 시간: ${minutes}분`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`  관리자 비밀번호: ${password}  (${path.join(dataDir, 'admin-password.txt')} 에 저장됨)`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.closeStreams();
    server.close(() => process.exit(0));
  });
}
