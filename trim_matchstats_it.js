// ==========================================
// 이미 쌓인 matchstats 의 `it`(아이템 구매 타임라인)에서 **집계가 안 쓰는 구매**를 뺀다.
//
//   ★ 왜 — Atlas 무료 512MB 가 찼다 (2026-09-09). `it` 하나가 matchstats 308MB 중 186MB(60%)다.
//     판당 149건을 담는데 집계가 보는 건 **시작(≤90초) · 초반(90~600초) · 완성 아이템**뿐이라
//     600초 뒤에 산 **조합 재료**는 통째로 죽은 무게다. 실측: 149 → 80건(53%).
//
//   ★★ 1코어·2코어·시작템·신발 통계는 **손실이 없다** — 코어 순서는 완성 아이템으로 세고,
//     시작·초반은 600초 안이라 둘 다 남는다. `server.js` 의 toSlimTimeline 이 이제 같은 규칙으로
//     담으므로, 이 스크립트는 **그 규칙을 옛 문서에 소급**하는 것뿐이다.
//
//   ★ 되돌릴 수 없다 (라이엇 타임라인을 다시 받지 않는 한). 그래서 --write 를 따로 준다.
//
// 쓰는 법:
//   node trim_matchstats_it.js            # 재보기만 (얼마나 줄지)
//   node trim_matchstats_it.js --write    # 실제로 줄인다
// ==========================================
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const WRITE = process.argv.includes('--write');
const TL_EARLY_SEC = 600;
// ★★★ **server.js 의 값과 반드시 같아야 한다** (거기는 1000). 2026-09-09 에 여기만 1500 으로 적어
//   1000~1499 짜리 완성 아이템 — **2단계 신발 11종 전부** — 를 "완성이 아님" 으로 보고
//   10분 뒤 구매를 지워 버렸다. 그 패치의 신발 통계가 통째로 망가졌다.
const TL_COMPLETE_GOLD = 1000;
const ITEM_CONSUMABLES = [2003, 2031, 2033, 2055, 2138, 2139, 2140, 2010, 2052];
const mb = (b) => (b / 1024 / 1024).toFixed(1) + 'MB';

(async () => {
    // 완성 아이템 목록 — server.js 의 loadCompletedItems 와 **같은 규칙**이어야 한다
    const ver = (await axios.get('https://ddragon.leagueoflegends.com/api/versions.json')).data[0];
    const data = (await axios.get(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/ko_KR/item.json`)).data.data;
    const realInto = it => (it.into || []).filter(x => {
        const t = data[x];
        return t && t.maps?.['11'] && t.gold?.purchasable && !t.requiredAlly;
    });
    const keep = new Set();
    for (const [id, it] of Object.entries(data)) {
        const n = Number(id);
        if (!it.maps?.['11'] || !it.gold?.purchasable || it.requiredAlly) continue;
        if (ITEM_CONSUMABLES.includes(n) || (it.gold.total || 0) < TL_COMPLETE_GOLD) continue;
        if (realInto(it).length && !(it.tags || []).includes('Boots')) continue;
        keep.add(n);
    }
    console.log(`완성 아이템 ${keep.size}개 (DD ${ver}) · 남기는 규칙: ${TL_EARLY_SEC}초 이내 이거나 완성 아이템`);

    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const col = mongoose.connection.db.collection('matchstats');

    const total = await col.countDocuments({ it: { $exists: true, $ne: [] } });
    console.log(`대상 ${total.toLocaleString()}건`);

    let seen = 0, before = 0, after = 0, changed = 0, ops = [];
    const cursor = col.find({ it: { $exists: true, $ne: [] } }, { projection: { it: 1 } });
    for await (const d of cursor) {
        seen++;
        const it = d.it || [];
        before += it.length;
        const out = [];
        for (let i = 0; i < it.length; i += 3) {
            if (it[i] <= TL_EARLY_SEC || keep.has(it[i + 2])) out.push(it[i], it[i + 1], it[i + 2]);
        }
        after += out.length;
        if (out.length !== it.length) {
            changed++;
            if (WRITE) ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { it: out } } } });
        }
        if (WRITE && ops.length >= 500) { await col.bulkWrite(ops, { ordered: false }); ops = []; }
        if (seen % 10000 === 0) console.log(`  ${seen.toLocaleString()}건 처리…`);
    }
    if (WRITE && ops.length) await col.bulkWrite(ops, { ordered: false });

    // 숫자 하나가 약 8.8B (BSON 배열은 자리 번호까지 들고 있다 — 실측값)
    const savedBytes = (before - after) * 8.83;
    console.log(`\n훑은 문서 ${seen.toLocaleString()}건 · 바뀔 문서 ${changed.toLocaleString()}건`);
    console.log(`구매 ${(before / 3).toLocaleString()}건 → ${(after / 3).toLocaleString()}건 (${(after / before * 100).toFixed(0)}%)`);
    console.log(`예상 절감 ${mb(savedBytes)}`);
    console.log(WRITE ? '\n★ 실제로 줄였다.' : '\n(--write 를 붙여야 실제로 줄인다)');
    await mongoose.disconnect();
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
