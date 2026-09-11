// 패치 마무리 자동 절차 (2026-09-11 사용자 승인 — "네가 알아서 고고").
//
//   node finalize_patch.js --patch 16.17 --day 2026-09-08        # 한 번 검사하고, 조건이 맞으면 마무리까지 한다
//   종료 코드: 0 = 마무리 끝 · 2 = 아직 조건이 안 맞음(다음에 다시) · 1 = 오류(사람이 볼 것)
//
//   조건 (전부 맞아야 한다):
//     ① 백필 끝 — 그 패치 원본 중 `tlv≠2` 인데 타임라인(`sk`)이 있는 판이 0
//     ② 다시 훑기 끝 — `--day` 스냅샷의 rescanDone 이 명단을 다 덮었고, matchseens 에 `cnt2` 가 남아 있지 않다
//     ③ 대기열 비움 — 그 날짜 이하(경기일 ≤ 패치 마지막 날)의 cnt≥5 미처리 판이 0
//     ④ 그 뒤에 프로덕션 집계가 한 번 완전히 돌았다 — statscopes 의 gen·genB·genM 이 ③이 맞은 시각(+5분) 이후
//     ⑤ 지금 집계가 도는 중이 아니다 — 마지막 genM 이 3~12분 전 (매시간 한 번, 7분쯤 걸린다)
//   마무리:
//     a. 원본(matchstats v=패치) 삭제 — 이걸 먼저 해야 다음 집계가 그 패치를 다시 건드리지 않는다
//     b. build_stats_archive.js --write → --verify → git 커밋·푸시(배포) → 4분 기다림 → --delete
//   ★ 이 절차가 하는 일은 「마지막 경기 +3일」에 서버가 자동으로 하는 것(원본 삭제)과 「박제」(사람이 하던 것)를
//     하루 앞당긴 것뿐이다. 용량이 512 에 닿기 전에 끝내려고 앞당겼다.
require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const PATCH = arg('--patch');
const DAY = arg('--day');
if (!PATCH || !DAY) { console.error('--patch 16.17 --day 2026-09-08 을 줘야 한다'); process.exit(1); }
const SCOPE = `p:${PATCH}`;
const STATE = path.join(__dirname, `finalize_${PATCH}.state.json`);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const log = (s) => console.log(`[Finalize ${new Date().toISOString().slice(11, 19)}] ${s}`);
const MB = (b) => (b / 1048576).toFixed(1);

(async () => {
  const c = new MongoClient(process.env.MONGO_URI); await c.connect(); const db = c.db();
  const ms = db.collection('matchstats'), seen = db.collection('matchseens'), sc = db.collection('statscopes');

  // ── 조건 ①②③
  const bfLeft = await ms.countDocuments({ v: PATCH, tlv: { $ne: 2 }, sk: { $exists: true } });
  const snap = await db.collection('ranksnapshots').findOne({ day: DAY }, { projection: { puuids: 1, rescanDone: 1 } });
  const rescanLeft = snap ? snap.puuids.length - (snap.rescanDone || []).length : -1;
  const cnt2Left = await seen.countDocuments({ day: DAY, cnt2: { $exists: true } });
  const lastGame = await ms.find({ v: PATCH }, { projection: { t: 1 } }).sort({ t: -1 }).limit(1).next();
  const lastDay = lastGame ? new Date(lastGame.t * 1000 + 9 * 3600000).toISOString().slice(0, 10) : DAY;
  const queueLeft = await seen.countDocuments({ done: { $ne: true }, cnt: { $gte: 5 }, day: { $lte: lastDay } });
  const total = await ms.countDocuments({ v: PATCH });
  log(`${SCOPE} 원본 ${total.toLocaleString()}판 · 백필 남음 ${bfLeft} · 다시 훑기 남음 ${rescanLeft}명(cnt2 ${cnt2Left}) · ${lastDay} 까지 대기열 ${queueLeft}`);
  const ready = bfLeft === 0 && rescanLeft >= 0 && rescanLeft <= 30 && cnt2Left === 0 && queueLeft === 0;
  if (!ready) { await c.close(); process.exit(2); }
  if (!state.readyAt) { state.readyAt = Date.now(); save(); log(`조건이 맞았다 — 이 뒤에 프로덕션 집계가 한 번 완전히 돌기를 기다린다`); }

  // ── 조건 ④⑤
  const scope = await sc.findOne({ scope: SCOPE });
  if (!scope) { log(`statscopes 에 ${SCOPE} 가 없다`); await c.close(); process.exit(1); }
  const gens = [scope.gen, scope.genB, scope.genM].map(Number);
  const after = gens.every(g => g > state.readyAt + 5 * 60 * 1000);
  const sinceM = (Date.now() - Number(scope.genM)) / 60000;
  if (!after) { log(`집계 대기 — gen ${new Date(gens[0]).toISOString().slice(11, 16)} genB ${new Date(gens[1]).toISOString().slice(11, 16)} genM ${new Date(gens[2]).toISOString().slice(11, 16)} (기준 ${new Date(state.readyAt).toISOString().slice(11, 16)}+5분)`); await c.close(); process.exit(2); }
  if (sinceM < 3 || sinceM > 12) { log(`틈 대기 — 마지막 상성 집계가 ${sinceM.toFixed(0)}분 전 (3~12분 사이여야 한다)`); await c.close(); process.exit(2); }
  const gensB = await db.collection('champbuilds').distinct('g', { scope: SCOPE });
  if (gensB.length !== 1) { log(`champbuilds 세대가 ${gensB.length}개 — 교체 중이거나 두 벌. 다음에`); await c.close(); process.exit(2); }

  // ── a. 원본 삭제
  const before = await db.stats();
  log(`마무리 시작 — 클러스터 ${MB(before.dataSize + before.indexSize)}MB · ${SCOPE} 집계 games ${scope.games} / 원본 ${total}`);
  const del = await ms.deleteMany({ v: PATCH });
  const afterDel = await db.stats();
  log(`원본 ${del.deletedCount.toLocaleString()}판 삭제 → ${MB(afterDel.dataSize + afterDel.indexSize)}MB`);
  state.deletedAt = Date.now(); state.deleted = del.deletedCount; save();
  await c.close();

  // ── b. 박제
  const run = (cmd) => { log(`$ ${cmd}`); const out = execSync(cmd, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); process.stdout.write(out); return out; };
  run(`node build_stats_archive.js --scope ${SCOPE} --write`);
  run(`node build_stats_archive.js --scope ${SCOPE} --verify`);
  const file = `public/stats_archive/${SCOPE.replace(/:/g, '_')}.js`;
  run(`git add ${file}`);
  run(`git commit -q -m "통계 박제: ${SCOPE} (원본 ${del.deletedCount.toLocaleString()}판 삭제 뒤 자동 마무리)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`);
  run(`git push -q origin main`);
  log('배포 기다림 4분 (파일이 올라간 뒤에 DB 행을 지운다)');
  await new Promise(r => setTimeout(r, 4 * 60 * 1000));
  run(`node build_stats_archive.js --scope ${SCOPE} --delete`);
  const c2 = new MongoClient(process.env.MONGO_URI); await c2.connect();
  const fin = await c2.db().stats();
  log(`끝 — 클러스터 ${MB(fin.dataSize + fin.indexSize)}MB`);
  await c2.close();
  state.doneAt = Date.now(); save();
  process.exit(0);
})().catch(e => { console.error('[Finalize] 오류:', e.message); process.exit(1); });
