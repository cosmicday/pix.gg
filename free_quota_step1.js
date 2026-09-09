// ==========================================
// 1단계 — 쓰기 잠금을 풀 만큼만 비운다 (2026-09-09, Atlas 512MB 초과)
//
//   ★ Atlas M0 는 **논리 크기(dataSize + indexSize)** 로 센다 (실측: 클러스터 파일 합은 320MB
//     인데 Atlas 는 516MB 라고 했고, 논리 합이 그 값과 맞는다). 즉 **문서를 지우면 바로 반영된다.**
//     `compact` 는 M0 에서 막혀 있다 (CMD_NOT_ALLOWED).
//
//   ★★ 지우는 건 `champbuilds` **전부**다 (논리 53MB). 이건 원본이 아니라 **파생**이라
//     `matchstats` 에서 재집계하면 그대로 돌아온다 (REBUILD_STATS=1 또는 배포 시 자동).
//     16.16 은 이미 파일로 박제했다 (public/stats_archive/p_16.16.js).
//
//   ★ statscopes · matchstats 는 손대지 않는다 — 전자는 scope 목록·분모, 후자는 원본이다.
//
//   순서: ① 이 스크립트 → ② trim_matchstats_it.js --write → ③ 재집계(배포 or REBUILD_STATS)
// ==========================================
require('dotenv').config();
const mongoose = require('mongoose');
const mb = (b) => (b / 1024 / 1024).toFixed(1) + 'MB';

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const db = mongoose.connection.db;

    const stat = async (tag) => {
        const s = await db.command({ dbStats: 1, scale: 1 });
        console.log(`${tag}  dataSize ${mb(s.dataSize)} + index ${mb(s.indexSize)} = ${mb(s.dataSize + s.indexSize)}`);
    };
    await stat('전');

    const n = await db.collection('champbuilds').countDocuments();
    const r = await db.collection('champbuilds').deleteMany({});
    console.log(`champbuilds ${r.deletedCount.toLocaleString()}건 삭제 (있던 것 ${n.toLocaleString()}건) — 재집계로 복구된다`);

    await stat('후');

    try {
        await db.collection('__writetest').insertOne({ t: new Date() });
        await db.collection('__writetest').deleteMany({});
        console.log('\n★ 쓰기 열림 확인 — 다음: node trim_matchstats_it.js --write');
    } catch (e) {
        console.log('\n★ 아직 쓰기 막힘:', e.message.slice(0, 160));
        console.log('  더 비워야 한다. 다음 후보: champmatchups(논리 12.7MB) · matchstats 오래된 날짜');
    }
    await mongoose.disconnect();
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
