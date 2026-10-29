// Local run (npm start). The Netlify deployment uses netlify/functions/api.mjs instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';
import { Auth, LoginLimiter } from './src/auth.js';
import { createApp } from './src/app.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const dataFile = path.join(dataDir, 'playroom.json');
const port = Number(process.env.PORT ?? 3000);
const minutes = Number(process.env.DURATION_MINUTES ?? 90);

function save(data) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(`${dataFile}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${dataFile}.tmp`, dataFile);
}

const store = new Store({
  data: fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : null,
  onSave: save,
  timeZone: process.env.TIME_ZONE ?? 'Asia/Seoul',
  durationMs: minutes * 60 * 1000,
});
if (store.dirty) save(store.data);

const auth = new Auth({ store, envPassword: process.env.ADMIN_PASSWORD });
const server = createApp({ store, auth, limiter: new LoginLimiter(), publicDir: path.join(root, 'public') });

server.listen(port, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${port}`);
  console.log('Playroom 서버가 시작되었습니다.');
  console.log(`  관리자 페이지: http://localhost:${port}/admin  (알림이 동작하려면 이 주소 또는 HTTPS로 접속)`);
  console.log(`  학생 조회 페이지: ${[`http://localhost:${port}`, ...lan].join('  ')}`);
  console.log(`  기본 이용 시간: ${minutes}분`);
  if (!auth.configured) console.log('  관리자 비밀번호가 아직 없습니다. 관리자 페이지에 처음 접속해서 설정하세요.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
