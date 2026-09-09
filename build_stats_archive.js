// ==========================================
// 박제된 패치 통계를 정적 파일로 내보낸다  →  public/stats_archive/p_16.16.js
//
//   ★★ 왜 파일인가 — 실측(2026-08-16)으로 DB 보관보다 훨씬 싸다.
//     패치 하나가 DB 에서는 인덱스까지 3.32MB 인데, 배열로 눕힌 파일은 345KB
//     (gzip 67KB / brotli 25KB) 다. 1년 26패치면 **Atlas 84MB 가 통째로 0** 이 된다.
//     은퇴한 패치의 집계는 두 번 다시 안 바뀌므로 skin_prices.js·champion_stats.js 와
//     성격이 같다 — 이 저장소가 원래 쓰던 방식이다.
//
//   ★ `statscopes` 행은 **지우지 않는다.** scope 드롭다운과 픽률·밴률 분모가 거기서
//     오는데 패치당 1~2행(약 350B)이라 26패치를 남겨도 18KB 다. 이 한 줄을 남겨 두면
//     서버 API 가 "목록에는 있는데 행이 없다 = 박제됨" 을 스스로 판단할 수 있다.
//
//   ★★ 지우는 건 `--delete` 를 따로 줘야 한다. 그리고 **파일을 되읽어 원본과
//     대조가 끝난 뒤에만** 지운다. 한번 지우면 되돌릴 수 없기 때문이다.
//
// 쓰는 법:
//   node build_stats_archive.js --scope p:16.16            # 재보기만 (파일 안 만듦)
//   node build_stats_archive.js --scope p:16.16 --write    # 파일 생성
//   node build_stats_archive.js --scope p:16.16 --verify   # 파일이 DB 와 맞는지만 대조
//   node build_stats_archive.js --scope p:16.16 --delete   # 검증 후 DB 행 삭제
//
// 실제 순서 (한 패치를 은퇴시킬 때):
//   ① --write 로 파일을 만들고  ② git 커밋·배포해서 실제로 받아지는지 확인한 뒤
//   ③ --delete 로 DB 행을 지운다. ②를 건너뛰면 화면에 옛 패치가 빈 채로 나온다.
// ==========================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(name);

const SCOPE = arg('--scope');
const WRITE = has('--write');
const VERIFY = has('--verify');
const DELETE = has('--delete');

// ★ 자리 뜻을 여기 한 군데에 적어 둔다. 화면(app.js 의 expandStatsArchive)이 같은
//   순서로 되돌리므로 **순서를 바꾸면 양쪽을 같이 고쳐야 한다.**
const KB_LIST = ['5-7', '8-10'];
//   ★ 새 type 은 **반드시 맨 뒤에** 붙일 것. 앞에 끼우면 이미 만든 박제 파일의 숫자가
//     통째로 다른 뜻이 된다 (파일에는 이름이 아니라 이 배열의 자리 번호가 들어간다).
const TYPE_LIST = ['rune', 'keystone', 'spell', 'shard', 'all', 'item',
    'skillord', 'skillpri', 'start', 'core', 'item4', 'item5', 'item6', 'tlall',   // 타임라인 8종은 2026-08-26 에 맨 뒤에 붙였다
    'skillord6', 'skillord10', 'early', 'earlyset', 'boots', 'set2', 'set4', 'set5', 'item1', 'item2', 'item3', 'perk',   // 같은 날 밤 12종 더
    'skilllv', 'skillord11'];   // 레벨별 스킬 · 11레벨 순서 (2026-09-09)

const OUT_DIR = path.join(__dirname, 'public', 'stats_archive');
const fileNameOf = (scope) => scope.replace(/:/g, '_') + '.js';
const KB = (b) => (b / 1024).toFixed(1) + 'KB';

(async () => {
    if (!SCOPE) {
        console.error('--scope 를 줘야 한다 (예: --scope p:16.16)');
        process.exit(1);
    }
    if (!SCOPE.startsWith('p:')) {
        // 일별 scope 는 7일이면 사라지므로 박제할 이유가 없다
        console.error('패치 scope 만 박제한다 (p: 로 시작해야 한다)');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    const db = mongoose.connection.db;

    const scopes = await db.collection('statscopes').find({ scope: SCOPE }).toArray();
    if (!scopes.length) {
        console.error(`statscopes 에 ${SCOPE} 가 없다. scope 이름을 확인할 것.`);
        process.exit(1);
    }

    const cs = await db.collection('champstats').find({ scope: SCOPE }).toArray();
    const cb = await db.collection('champbuilds').find({ scope: SCOPE }).toArray();
    const cm = await db.collection('champmatchups').find({ scope: SCOPE }).toArray();
    console.log(`${SCOPE} — champstats ${cs.length}행 / champbuilds ${cb.length}행 / 상성 ${cm.length}행 / statscopes ${scopes.length}행`);

    if (!cs.length && !cb.length) {
        console.log('집계 행이 없다. 이미 박제된 패치이거나 아직 집계 전이다.');
        await mongoose.disconnect();
        return;
    }

    // ── 배열로 눕힌다. 키 이름이 통째로 사라져 절반 이하가 된다
    //    (슬림 경기 문서에서 쓴 것과 같은 수법이다)
    const kbIdx = (k) => KB_LIST.indexOf(k);
    const archive = {
        v: 1,
        scope: SCOPE,
        // 마지막 집계 시각. 화면이 캐시 무효화용 ?v= 로 쓴다
        updatedAt: Math.max(...scopes.map(s => +s.updatedAt || 0)),
        // [kb, games]
        t: scopes.map(s => [kbIdx(s.kb), s.games]),
        // [kb, champ, pos, games, wins, bans, banGames, kills, deaths, assists]
        r: cs.map(x => [kbIdx(x.kb), x.champ, x.pos, x.games, x.wins, x.bans, x.banGames, x.kills, x.deaths, x.assists]),
        // [champ, pos, type, games, wins, ...key]  — key 길이가 type 마다 다르므로 뒤에 붙인다
        //   ★ pos 는 2026-08-18에 끼워 넣었다. app.js 의 expandStatsArchive() 와 자리가
        //     같아야 하므로 **둘을 같이 고칠 것** (아직 박제한 패치가 없어서 안전하게 넣었다).
        b: cb.map(x => [x.champ, x.pos == null ? -1 : x.pos, TYPE_LIST.indexOf(x.type), x.games, x.wins, ...x.key]),
        // [pos, champ, foe, games, wins]  — 라인 상성 (2026-08-21 추가)
        //   ★ 안 담으면 패치가 은퇴할 때 상성이 통째로 사라진다. 원본(matchstats)이
        //     TTL 로 없어진 뒤에는 다시 만들 수 없다.
        //   ★ app.js 의 expandStatsArchive() 와 자리가 같아야 한다 — **둘을 같이 고칠 것.**
        //   ★ fpos(상대 라인)·rel(0 적/1 아군)은 2026-08-26 밤에 **뒤에** 붙였다 — 옛 파일은 이 두 칸이 없고 화면이 같은 라인 적으로 읽는다
        m: cm.map(x => [x.pos, x.champ, x.foe, x.games, x.wins, x.fpos == null ? x.pos : x.fpos, x.rel || 0])
    };

    const body = JSON.stringify(archive);
    const out = `// 자동 생성 — build_stats_archive.js (${new Date().toISOString().slice(0, 10)})
// 박제된 패치 통계. 은퇴한 패치라 두 번 다시 안 바뀐다.
// 자리 뜻은 build_stats_archive.js 주석 참고 — app.js 의 expandStatsArchive() 가 되돌린다.
window.statsArchive = window.statsArchive || {};
window.statsArchive['${SCOPE}'] = ${body};
`;

    console.log(`\n파일 크기 ${KB(Buffer.byteLength(out))}  gzip ${KB(zlib.gzipSync(Buffer.from(out), { level: 9 }).length)}  brotli ${KB(zlib.brotliCompressSync(Buffer.from(out)).length)}`);

    const dest = path.join(OUT_DIR, fileNameOf(SCOPE));

    if (WRITE) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(dest, out);
        console.log(`→ ${dest}`);
    } else if (!DELETE) {
        console.log('(--write 를 붙여야 파일을 만든다)');
    }

    // ==========================================
    // ★★ 삭제는 파일을 되읽어 원본과 대조한 뒤에만 한다.
    //   한번 지우면 되돌릴 방법이 없다 — 원본(matchstats)도 그때쯤이면 TTL 로 사라진다.
    // ==========================================
    if (VERIFY || DELETE) {
        if (!fs.existsSync(dest)) {
            console.error(`\n★ 파일이 없다: ${dest}\n  먼저 --write 로 만들고, git 에 커밋해서 배포한 뒤에 지울 것.`);
            process.exit(1);
        }

        // 파일을 진짜로 실행해서 되읽는다 (문자열 비교가 아니라 결과를 본다)
        const sandbox = { window: {} };
        try {
            new Function('window', fs.readFileSync(dest, 'utf8'))(sandbox.window);
        } catch (e) {
            console.error('\n★ 파일을 못 읽었다:', e.message);
            process.exit(1);
        }
        const back = sandbox.window.statsArchive?.[SCOPE];

        const problems = [];
        if (!back) problems.push('파일 안에 이 scope 가 없다');
        else {
            if (back.r.length !== cs.length) problems.push(`champstats 행 수가 다르다 (파일 ${back.r.length} / DB ${cs.length})`);
            if (back.b.length !== cb.length) problems.push(`champbuilds 행 수가 다르다 (파일 ${back.b.length} / DB ${cb.length})`);
            if ((back.m || []).length !== cm.length) problems.push(`상성 행 수가 다르다 (파일 ${(back.m || []).length} / DB ${cm.length})`);
            if (back.t.length !== scopes.length) problems.push('statscopes 행 수가 다르다');
            // 합계까지 대조한다 — 행 수만 같고 값이 밀렸을 수 있다
            const sum = (a, i) => a.reduce((s, x) => s + x[i], 0);
            if (sum(back.r, 3) !== cs.reduce((s, x) => s + x.games, 0)) problems.push('champstats games 합계가 다르다');
            if (sum(back.r, 4) !== cs.reduce((s, x) => s + x.wins, 0)) problems.push('champstats wins 합계가 다르다');
            // ★★ 자리 번호를 틀리면 **멀쩡한 박제가 「대조 실패」로 막힌다** (2026-09-09 실제로 걸렸다).
            //   champbuilds 줄은 `[champ, pos, type, games, wins, ...key]` 라 games 는 **3번**이다
            //   (2번은 type). 위 `r`·`m` 은 원래 3번이 맞아서 이 한 줄만 어긋나 있었다.
            if (sum(back.b, 3) !== cb.reduce((s, x) => s + x.games, 0)) problems.push('champbuilds games 합계가 다르다');
            if (sum(back.b, 4) !== cb.reduce((s, x) => s + x.wins, 0)) problems.push('champbuilds wins 합계가 다르다');
            if (sum(back.m || [], 3) !== cm.reduce((s, x) => s + x.games, 0)) problems.push('상성 games 합계가 다르다');
        }

        if (problems.length) {
            console.error('\n★ 대조 실패 — 아무것도 지우지 않았다:');
            problems.forEach(p => console.error('  - ' + p));
            console.error('  파일을 만든 뒤에 집계가 다시 돌면 이렇게 된다. --write 를 다시 할 것.');
            process.exit(1);
        }
        console.log('\n대조 통과 (행 수 · games · wins 합계 일치)');

        if (!DELETE) {
            console.log('(--delete 를 붙여야 DB 행을 지운다)');
            await mongoose.disconnect();
            return;
        }

        // ★ statscopes 는 남긴다 (scope 목록과 분모)
        const r1 = await db.collection('champstats').deleteMany({ scope: SCOPE });
        const r2 = await db.collection('champbuilds').deleteMany({ scope: SCOPE });
        const r3 = await db.collection('champmatchups').deleteMany({ scope: SCOPE });
        console.log(`champstats ${r1.deletedCount}행 / champbuilds ${r2.deletedCount}행 / 상성 ${r3.deletedCount}행 삭제. statscopes 는 남겼다.`);
        console.log('★ 이 파일이 배포돼 있어야 화면이 옛 패치를 그린다. git 에 커밋했는지 확인할 것.');
    }

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
