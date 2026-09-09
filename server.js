require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');
const crypto = require('crypto');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// ==========================================
// [1] DB 연결 및 스키마 정의
// ==========================================
mongoose.set('bufferCommands', false);

// 연결이 끊기거나 복구될 때 로그를 남김
mongoose.connection.on('disconnected', () => console.error("[System] MongoDB 연결 끊김"));
mongoose.connection.on('reconnected', () => console.log("[System] MongoDB 재연결 완료"));

const matchCacheSchema = new mongoose.Schema({
    matchId: { type: String, required: true, unique: true },
    detail: { type: Object, required: true },
    timeline: { type: Object },
    // ★ 7일이다 (2026-08-15에 14일에서 줄였다). 검색 트래픽이 거의 없어서 원본을
    //   2주씩 들고 있을 이유가 적고, 통계 슬림(matchstats)에 자리를 내주기 위해서다.
    //   ※ expires 를 고쳐도 **이미 만들어진 TTL 인덱스는 안 바뀐다** — ensureStatIndexes() 참고
    //   ★★ 2026-08-26: 7 → 3일. 타임라인 슬림(빌드 통계)에 자리를 내준다.
    //     실측으로 이 컬렉션이 **3.0MB / 35건** 밖에 안 됐다 — 검색 트래픽이 거의 없어서
    //     예상 평형(92MB)의 30분의 1이다. 줄여도 잃는 게 사실상 없다.
    createdAt: { type: Date, expires: '3d', default: Date.now }
});

// ★ 폴백 조회용 인덱스 (puuid로 매치를 찾고 최신순 정렬)
matchCacheSchema.index({ 'detail.metadata.participants': 1, 'detail.info.gameEndTimestamp': -1 });

const MatchCache = mongoose.model('MatchCache', matchCacheSchema);

// ==========================================
// 통계 수집용 스키마 (2026-08-15 신설)
//   ★ 원본(detail)을 저장하지 않는다. 받는 즉시 쓸 값만 뽑아 배열로 눕히고 버린다.
//     한 판 82KB -> 0.76KB (108배). 원본 용량의 대부분은 값이 아니라 키 이름이다 —
//     "totalDamageDealtToChampions"(28자)를 참가자 10명 x 경기마다 반복 저장한다.
//     배열로 바꾸면 키가 통째로 사라진다.
// ==========================================

// matchlist 에서 본 경기. "명단 유저 몇 명에게서 보였나"를 센다.
//   ★★ 이 횟수가 곧 마스터+ 인원(k)의 하한이다. 한 판에 명단 유저가 k명 있으면
//     그 매치 ID 가 k명의 matchlist 에 중복으로 나타나기 때문이다.
//     그래서 detail 을 받기 **전에** 거를 수 있다 — 이게 호출 예산의 핵심이다.
//     (승격 직후라 명단에 아직 없는 사람은 안 세지므로 항상 하한이다. 넘치는 쪽으로만
//      보수적이라 통계가 오염되지 않는다.)
const matchSeenSchema = new mongoose.Schema({
    matchId: { type: String, required: true, unique: true },
    day: { type: String },                      // 이 경기가 속한 날짜 (KST "2026-08-14")
    cnt: { type: Number, default: 1 },          // 명단 유저 몇 명에게서 보였나
    done: { type: Boolean, default: false },    // detail 처리를 끝냈나
    createdAt: { type: Date, expires: '3d', default: Date.now }
});
matchSeenSchema.index({ done: 1, cnt: -1 });
const MatchSeen = mongoose.model('MatchSeen', matchSeenSchema);

// ==========================================
// 날짜별 명단 스냅샷 (2026-08-17 신설)
//   ★★ "지금 명단" 으로 **어제 경기**를 다루면 두 군데서 샌다:
//     ① 순회 — 어제 마스터로 게임을 했는데 오늘 아침 명단에서 빠진 사람에게는
//        "어제 뭐 했어?" 를 **아예 안 물어본다.** 그 사람 몫의 등장 횟수가 통째로 빠지고,
//        경계에 걸린 판(5명)은 4로 내려가 **detail 을 안 받아 통계에서 사라진다.**
//        실측(2026-08-17): 8/15 명단에 있다가 8/16 에 빠진 사람이 **437명(3.8%)**.
//        5명 중 최소 한 명이 빠질 확률이 약 18% 라 경계 판이 그만큼 샜다.
//     ② k 계산 — 아침에 5명이던 판이 저녁에 4명으로 세어졌다. 실측 140건(전체 3.5%)이고
//        전부 `cnt` 가 5~7 인 경계 판이었다 (cnt>=8 은 0건).
//   → 그래서 **그날 명단을 사진 찍어 두고, 어제 경기는 어제 명단으로 처리한다.**
//   ★ 하루 한 문서에 puuid 를 통째로 담는다 (1.1만 x 78B ≒ 0.9MB/일, TTL 5일 = 4.5MB).
//     16MB 문서 한도의 6%라 여유가 크다.
// ==========================================
const rankSnapshotSchema = new mongoose.Schema({
    day: { type: String, required: true, unique: true },   // KST "2026-08-17"
    n: { type: Number, default: 0 },
    puuids: { type: [String], default: [] },
    // ★ 그 날짜의 순회(scanMatchlists)가 끝까지 돌았나 (2026-08-27).
    //   수집이 전날 잔량을 따라잡을 때 이 표시가 있는 날만 손댄다 — 순회가 덜 된 날은
    //   등장 횟수(cnt)가 하한조차 못 되어 어떤 판이 5명 이상인지 모른다.
    scanDone: { type: Boolean, default: false },
    createdAt: { type: Date, expires: '5d', default: Date.now }
});
const RankSnapshot = mongoose.model('RankSnapshot', rankSnapshotSchema);

// ==========================================
// 랭커 LP 일별 이력 (2026-09-01, 로드맵 A-9) — 전적 페이지 LP 추이 그래프 몫
//   ★★ 로드맵의 "ranksnapshots 로 소급 가능" 은 틀렸다 — 거긴 puuid 목록뿐이고
//     LP 가 없다 (TTL 5일). 그래서 소급은 불가능하고 **배포일부터** 하루 한 점씩 쌓는다.
//   hist 한 칸 = [YYMMDD(수, 260901 꼴), LP, 티어 한 글자]. 날짜를 수로 담는 건 용량 때문 —
//   1.1만 명 x 180칸이면 문서당 ~5KB 라 문자열 날짜보다 1KB 씩 아낀다.
//   명단에서 빠진 지 180일 지난 문서는 잡이 지운다 (강등·계정 이동으로 떠난 사람이 무한히 안 쌓이게).
// ==========================================
const lpHistorySchema = new mongoose.Schema({
    puuid: { type: String, required: true, unique: true },
    lastDay: { type: Number, default: 0 },   // 마지막 기록일 (재실행 중복 방지 + 청소 기준)
    hist: { type: Array, default: [] }
}, { versionKey: false });
const LpHistory = mongoose.model('LpHistory', lpHistorySchema);

// ==========================================
// 상위 티어 어긋남 눈금 (2026-08-17 신설)
//   ★★ **라이엇이 티어를 언제 다시 계산하는지 알아내려고 둔 것이다.**
//     라이엇은 챌린저/그마 소속을 연속으로 갱신하지 않고 하루 한 번쯤 몰아서 처리한다.
//     그래서 갱신 직후에는 LP 순위와 소속이 정확히 맞고(1~300등이 전부 챌린저),
//     시간이 갈수록 아래 티어가 LP 로 치고 올라와 어긋난다.
//   → `c300`(1~300등 안의 챌린저 수)과 `g1000`(1~1000등 안의 그마 수)이
//     **300 / 700 으로 되돌아가는 순간이 곧 갱신 시각**이다.
//   ★ 라이엇 호출이 0 이다 — 이미 10분(밤에는 5분)마다 받는 명단을 세기만 한다.
// ==========================================
const apexDriftSchema = new mongoose.Schema({
    t: { type: Date, required: true },
    c300: { type: Number },      // 1~300등 안의 챌린저 수 (300 이면 안 어긋남)
    // ★ 1~1000등 안의 챌린저 수 (2026-08-18 추가). **정상값은 300 이다** — 챌린저 전원이
    //   1000등 안에 있어야 맞다. c300 은 "위쪽 경계가 얼마나 흐렸나" 를 보고,
    //   이 값은 "챌린저가 얼마나 멀리 밀려났나" 를 본다. 한 명이 1000등 밖까지
    //   밀리는 일은 정상 상태에서는 없어야 한다.
    c1000: { type: Number },
    g1000: { type: Number },     // 1~1000등 안의 그마 수 (700 이면 안 어긋남)
    cMin: { type: Number },      // 챌린저 최저 LP
    gMax: { type: Number },      // 그마 최고 LP  — cMin 보다 높으면 그만큼 흐른 것이다
    gMin: { type: Number },      // 그마 최저 LP
    mMax: { type: Number },      // 마스터 최고 LP
    createdAt: { type: Date, expires: '7d', default: Date.now }
});
apexDriftSchema.index({ t: -1 });
const ApexDrift = mongoose.model('ApexDrift', apexDriftSchema);

// ==========================================
// 컷라인 그래프용 — 하루 한 줄 (2026-08-18 신설 · 2026-08-19 정의 변경)
//   랭킹 탭 오른쪽 그래프가 읽는다. ★ TTL 이 없다 (하루 한 줄 x 100B, 1년 36KB).
//
//   ★★ **등수 기준이 아니라 티어 소속 기준이다** (2026-08-19).
//     `lpChal` = 챌린저 최저 LP · `lpGm` = 그마 최저 LP.
//     예전엔 `lp300`/`lp1000`(300등·1000등의 LP)이었는데, 재계산 전에 재면 그 300등이
//     **그마**이고 1000등이 **마스터**라 "티어 컷" 이 아니었다 — 8/18 실측이
//     300등 1830 / 챌린저 최저 1773, 1000등 1330 / 그마 최저 1175 로 갈렸다.
//   ★★ **필드 이름을 같이 바꾼 이유가 이것이다.** 이름을 두고 뜻만 바꾸면 옛 점과 새 점이
//     한 그래프에 섞여도 아무도 못 알아챈다.
//   ★ 화면의 "현재 커트라인" 숫자는 **여전히 300등·1000등의 LP** 다 (app.js 의 `lpAt`).
//     저건 실시간 값이라 "지금 몇 점이면 300등 안인가" 라는 뜻이고 목적이 다르다 —
//     **일부러 다른 기준이니 맞추려 하지 말 것.**
//   ★ apexdrifts 의 `c300`/`g1000` 은 **인원 수**라 이름만 비슷하고 뜻이 다르다.
// ==========================================
const rankCutoffSchema = new mongoose.Schema({
    day: { type: String, required: true, unique: true },   // 한국시간 날짜 (YYYY-MM-DD)
    t: { type: Date, default: Date.now },                  // 채택한 표본의 시각
    lpChal: { type: Number },    // 챌린저 최저 LP = 챌린저 컷
    lpGm: { type: Number }       // 그마 최저 LP   = 그랜드마스터 컷
});
const RankCutoff = mongoose.model('RankCutoff', rankCutoffSchema);

// 통계용 슬림 경기. 원본 대신 이것만 남는다.
const matchStatSchema = new mongoose.Schema({
    matchId: { type: String, required: true, unique: true },
    k: { type: Number, required: true },   // 마스터+ 인원 (detail 로 센 정확한 값)
    v: { type: String },                   // 패치 "16.16"
    t: { type: Number },                   // 경기 시작 (초)
    d: { type: Number },                   // 경기 길이 (초)
    // 참가자 10명 x 28칸. 자리 뜻은 toSlimMatch() 주석 참고 (자리가 곧 의미다)
    p: { type: [[Number]], required: true },
    b: { type: [Number] },                 // 밴 (-1 = 밴 안 함은 제외하고 담는다)

    // ★★ 타임라인 슬림 (2026-08-26 신설) — 시작 아이템 · 코어 빌드 순서 · 스킬 순서용.
    //   ★ 원본 타임라인은 **판당 759KB** 라 통째로 담으면 안 된다 (2026-08-15에 173MB 먹은 전적).
    //     필요한 이벤트만 뽑으면 3.4KB, 소모품까지 빼면 그 아래다 — 실측으로 확인했다.
    //   ★ 못 받으면 두 필드가 없다. **집계가 있는 판만 세면 되므로 통계가 안 깨진다.**
    //
    //   sk  참가자 10명의 **스킬 레벨업 순서 문자열** (`"QEWQQRQEQEREEWWRWW"`).
    //       배열 자리가 곧 참가자 번호다 (p 와 같은 순서). 최대 18자라 10명 190바이트.
    //   it  아이템 구매를 **평평한 배열**로 `[초, 참가자(0~9), 아이템id, 초, 참가자, id, …]`.
    //       ★ 3개씩 끊어 읽는다. 객체 배열로 담으면 키 이름이 매 건 반복돼 2배가 된다.
    //       ★ 소모품·장신구는 뺀다 (`TL_SKIP_ITEMS`) — 물약·와드는 빌드가 아니라 잡음이고
    //         구매 건수의 3분의 1을 차지한다.
    sk: { type: [String] },
    it: { type: [Number] },
    // ★ 30일이다 (2026-08-15에 룬·주문을 넣으면서 45 → 30). 한 건이 2.4KB 라
    //   하루 3,000판이면 7MB/일 → 정착점 213MB. 45일로 두면 320MB 가 되어
    //   matchcaches 와 합쳐 512MB 의 85%를 먹는다.
    //   ★★ 2026-08-26: 30 → 21일. 타임라인 슬림(시작템·코어순서·스킬순서)을 같이 담기 위해서다.
    //     ★ 줄이면 **박제 시한도 같이 당겨진다** — 첫 수집 8/16 + 21일 = **9/6 이 한계**다
    //       (30일이면 9/14 였다). 그 전에 옛 패치를 박제하지 않으면 판수가 조용히 줄어든다.
    createdAt: { type: Date, expires: '21d', default: Date.now }
});
// 집계는 "패치 + k" 로 훑는다. 원본은 재집계 대비용이라 90일이면 충분하다.
matchStatSchema.index({ v: 1, k: 1 });
matchStatSchema.index({ t: 1 });
const MatchStat = mongoose.model('MatchStat', matchStatSchema);

// 집계 결과. 화면이 읽는 건 이 두 컬렉션뿐이고 MatchStat 은 재집계용 원본이다.
//   scope = "p:16.16"(패치) 또는 "d:2026-08-15"(일자, 한국시간 기준)
//   kb    = k 밴드. "5-7" / "8-10" 으로 **나눠서** 담는다 —
//           마스터 하위권이 실제로 얼마나 들어오는지 보고 나중에 기준을 고르려면
//           합치는 건 되지만 나누는 건 소급이 안 되기 때문이다.
//   pos   = 0~4 라인별, -1 = 라인 무관 합계
const champStatSchema = new mongoose.Schema({
    scope: { type: String, required: true },
    kb: { type: String, required: true },
    champ: { type: Number, required: true },
    pos: { type: Number, required: true },
    games: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    // 밴은 라인 개념이 없어서 pos: -1 줄에만 담긴다. 두 가지를 다 센다 —
    //   bans     = 밴 슬롯을 몇 개 먹었나 (양 팀이 같은 챔피언을 밴하면 2)
    //   banGames = 몇 판에서 밴됐나       (양 팀이 밴해도 1)
    bans: { type: Number, default: 0 },
    banGames: { type: Number, default: 0 },
    kills: { type: Number, default: 0 },
    deaths: { type: Number, default: 0 },
    assists: { type: Number, default: 0 },
    g: { type: Number }   // 세대 딱지 (2026-08-31) — statScopeSchema.gen 주석 참고
}, { versionKey: false });   // ★ __v(몽고 문서 버전 칸) 끔 — 매시간 통째로 갈아엎는 표라 쓸 일이 없다 (2026-08-27, 27만 행 x 7B)
champStatSchema.index({ scope: 1, kb: 1, pos: 1 });
const ChampStat = mongoose.model('ChampStat', champStatSchema);

// scope 별 총 경기 수. 픽률·밴률의 **분모**라 따로 둔다.
const statScopeSchema = new mongoose.Schema({
    scope: { type: String, required: true },
    kb: { type: String, required: true },
    games: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
    // ★★ 세대 딱지 (2026-08-31). 재집계가 "지우고 넣기" 대신 "넣고 → 딱지 갱신 → 옛 세대 삭제" 로
    //   돌므로, 조회는 항상 딱지가 가리키는 완성된 한 벌만 읽는다 — 재집계 중에도 빈 결과가 없다.
    //   컬렉션마다 딱지가 따로다: gen = champstats · genB = champbuilds · genM = champmatchups.
    //   딱지가 없으면(얼어붙은 옛 패치 등) 조회가 세대 필터 없이 그대로 읽는다.
    gen: { type: Number },
    genB: { type: Number },
    genM: { type: Number }
});
statScopeSchema.index({ scope: 1, kb: 1 }, { unique: true });
const StatScope = mongoose.model('StatScope', statScopeSchema);

// 챔피언별 룬·소환사 주문 빌드 (2026-08-16 신설)
//   ★★ 이걸 만든 진짜 이유는 화면이 아니라 **원본 삭제 준비**다. 룬·주문은
//     MatchStat.p 의 15~27번 칸에만 있어서, 지난 패치 원본을 지우면 그 패치의 룬 통계는
//     영영 복구가 안 된다. 승률·픽률·밴률은 이미 champstats 에 집계돼 있어서 안전한데
//     룬만 집계가 없었다. **원본을 지우기 전에 반드시 이 집계가 먼저 있어야 한다.**
//
//   ★ champstats 와 다른 점 세 가지 (일부러 다르게 했다):
//     ① **kb 밴드로 안 쪼갠다.** 룬 선택이 마스터+ 인원 수에 따라 달라질 이유가 없고,
//        표본이 지금도 얇아서 반으로 가르면 top 조합이 한두 판짜리가 된다
//     ② **일별 scope 를 안 만든다.** 하루치 룬 조합은 거의 전부 1판짜리라 뜻이 없고,
//        집계 비용만 두 배가 된다. 패치 scope 만 만든다
//     ③ **라인별로 안 쪼갠다.** 럼블처럼 탑/미드를 오가는 챔피언은 룬이 갈리지만,
//        지금 표본으로 라인까지 나누면 남는 게 없다. 표본이 쌓이면 그때 pos 를 더한다
//
//   key 의 자리 뜻은 type 마다 다르다 (참가자 배열 칸 번호는 toSlimMatch() 주석 참고):
//     rune     [주계열, 키스톤, 주룬1, 주룬2, 주룬3, 보조계열, 보조룬1, 보조룬2]  (17~24번 칸)
//     keystone [주계열, 키스톤]                                                  (17~18번 칸)
//     spell    [주문A, 주문B]  — **작은 id 가 앞이다.** 안 그러면 점멸/점화와
//                                점화/점멸이 다른 조합으로 갈려 표본이 반으로 쪼개진다
//     shard    [공격 파편, 유연 파편, 방어 파편]                                 (25~27번 칸)
//     all      []  — 이 챔피언의 총 판수. **픽률의 분모라 따로 담는다** (아래 참고)
const champBuildSchema = new mongoose.Schema({
    scope: { type: String, required: true },
    champ: { type: Number, required: true },
    // ★★ 라인 (2026-08-18 추가). `0~4` 는 라인별, **`-1` 은 라인 무관 전체**다.
    //   champstats 의 `pos` 와 같은 뜻이고 같은 함정이 있다 —
    //   **라인 판정이 실패한 참가자(원본 pos = -1)는 전체에만 담고 라인별에는 안 담는다.**
    //   양쪽에 다 담으면 이중 계산이다.
    //   ★ 수집은 바꾼 게 없다. 라인은 슬림 문서 참가자 1번 칸에 처음부터 있었고,
    //     여기서 그걸 group 키에 넣기만 한 것이라 **지난 원본도 소급해서 다시 세어진다.**
    pos: { type: Number, default: -1 },
    type: { type: String, required: true },
    key: { type: [Number], default: [] },
    games: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    g: { type: Number }   // 세대 딱지 (2026-08-31) — statScopeSchema.gen 주석 참고
}, { versionKey: false });   // __v 끔 (champstats 와 같은 이유)
champBuildSchema.index({ scope: 1, champ: 1 });
const ChampBuild = mongoose.model('ChampBuild', champBuildSchema);

// ★★ 라인 상성 (2026-08-21 신설). "같은 라인에서 마주친 두 챔피언" 한 쌍이 한 줄이다.
//   champ 이 나, foe 가 상대이고 **양방향으로 두 줄**을 만든다 (A vs B / B vs A).
//   그래야 화면에서 한 챔피언만으로 조회할 수 있다 — 두 배가 되지만 한 줄이 40B 다.
//   ★ 수집은 바꾼 게 없다. 슬림 문서 참가자 칸에 챔피언(0)·라인(1)·승패(2)·팀(3)이
//     처음부터 다 있어서 **지난 원본도 소급해서 세어진다** (룬 빌드를 라인별로 쪼갤 때와 같다).
//   ★ 실측(2026-08-21, 19,737판): **라인 5쌍이 온전한 판이 100.0%** 다
//     (라인 판정 실패 참가자가 197,370명 중 7명). 그래서 짝이 안 맞는 판은 그냥 버린다.
//   ★ `kb`(마스터+ 인원) 로 안 쪼갠다 — 룬 빌드와 같은 이유로 칸이 절반씩 얇아진다.
//   ★ 라인 무관(-1) 줄은 **안 만든다.** 화면이 필요하면 라인별 줄을 더해서 쓴다
//     (줄 수가 그만큼 줄고, 어차피 상성은 라인 안에서만 뜻이 있다).
const champMatchupSchema = new mongoose.Schema({
    scope: { type: String, required: true },
    pos: { type: Number, required: true },     // 0~4 내 라인
    champ: { type: Number, required: true },   // 나
    foe: { type: Number, required: true },     // 상대 (아군이면 그 아군)
    // ★★ 2026-08-26 밤 — "같은 라인 상대" 만 세던 것을 **한 판의 나머지 9명 전부**로 넓혔다 (lolalytics 의
    //   Counter 5줄 + Synergy 4줄). fpos = 그 사람의 라인, rel = 0 적 / 1 아군. 옛 뜻(같은 라인 적)은
    //   `rel: 0, fpos == pos` 줄이다. 실측(16.16, 5판 이상): 11,778 → 105,872행 (15초)
    fpos: { type: Number, default: -1 },
    rel: { type: Number, default: 0 },
    games: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    g: { type: Number }   // 세대 딱지 (2026-08-31) — statScopeSchema.gen 주석 참고
}, { versionKey: false });   // __v 끔 (champstats 와 같은 이유)
champMatchupSchema.index({ scope: 1, champ: 1 });
const ChampMatchup = mongoose.model('ChampMatchup', champMatchupSchema);

const summonerCacheSchema = new mongoose.Schema({
    puuid: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },   // 화면 표시용 원본 ("Faker#KR1")
    updatedAt: { type: Number, required: true },

    // ★ 검색 전용 소문자 사본 (인덱스를 타기 위함)
    nameLower: { type: String },      // "faker#kr1"
    namePartLower: { type: String },  // "faker"  (태그 제외)

    // ★ 자동완성 표시/정렬용
    tier: { type: String },
    rank: { type: String },
    lp: { type: Number },
    tierScore: { type: Number },      // 티어 정렬용 점수
    iconId: { type: Number },
    level: { type: Number },

    // ★ 숙련도 상위 5개 championId (랭킹 표의 "숙련도 TOP5" 칸).
    //   전 큐 통합 누적값이라 "솔랭 모스트" 가 아니다 — 라이엇이 그것만 준다.
    //   fillMasteryInBackground 가 분당 10명씩 채운다.
    mastery: { type: [Number] },
    masteryAt: { type: Number },

    // ★ 통계 수집 잡이 이 사람에게서 **어느 날짜의 경기를** 훑었는지 (KST "2026-08-14").
    //   시각이 아니라 날짜인 이유는 아래 scanMatchlists 주석 참고 —
    //   모두가 같은 날짜 창을 봐야 매치 등장 횟수(k 하한)가 정확해진다.
    //   DB 에 남겨야 재시작해도 순회 위치가 유지된다.
    matchScanDay: { type: String }
});

summonerCacheSchema.index({ displayName: 1 });
summonerCacheSchema.index({ namePartLower: 1, tierScore: -1 });

const SummonerCache = mongoose.model('SummonerCache', summonerCacheSchema);

// ==========================================
// 신화급 상점 일일 상품 (2026-08-16 신설)
//   윈도우 로컬 수집기(별도 프로젝트)가 롤 클라 화면을 읽어 POST /api/mythic-shop 로 보낸다.
//   명세는 mythic-collector/SERVER_SPEC.md 다.
//
//   ★ 정적 파일이 아니라 DB 인 이유: Railway 파일시스템이 배포마다 날아가서 서버가
//     파일을 못 만든다. 정적 파일로 가면 수집할 때마다 사람이 git push 를 해야 한다.
//   ★ TTL 이 없다 — **영구 기록이다.** 하루 4건 x 200B 면 1년에 300KB 라 지울 이유가 없다.
//   ★ `date` 는 **UTC 기준 날짜**다. 로테이션이 00:00 UTC(한국 09:00) 갱신이라
//     그 날짜가 곧 로테이션 ID 다. 한국 날짜와 다를 수 있으니 화면에서 조심할 것.
// ==========================================
const mythicShopSchema = new mongoose.Schema({
    date: { type: String, required: true },                 // "2026-08-16" (UTC)
    // ★★ 구획 (2026-08-17 추가). 인게임 상점 탭 그대로 — featured/biweekly/weekly/daily.
    //   **없으면 'daily' 다** — 구획이 생기기 전 수집기가 보내던 것이 전부 일일이었고,
    //   그 수집기를 안 고쳐도 계속 동작해야 하기 때문이다 (기존 문서도 시작할 때 메워 둔다).
    section: { type: String, required: true, default: 'daily' },
    collectedAt: { type: Date, required: true },            // 수집 시각 (표시용)
    items: [{
        _id: false,
        name: { type: String, required: true },    // 정식 명칭 (수집기가 CD 로 대조해 보낸다)
        // 'icon' | 'emote' | 'skin' | 'chroma' | 'ward' | 'border' | 'bundle' | 'other'
        //   ★ 일일 구획은 icon/emote/ward 만 받는다 (아래 validateMythicBody · MYTHIC_PRICE). 와드는 2026-08-27 에 추가
        type: { type: String, required: true },
        price: { type: Number, required: true },   // 신화 정수. 일일은 5|25|50 고정
        catalogId: { type: String },               // CommunityDragon id
        // ★ 이미지 URL 은 **수집기가 만들어 보낸다. 서버·프론트가 만들지 말 것.**
        //   아이콘은 id 로 경로를 만들 수 있지만 감정표현은 경로가 제각각이라 유추가 안 된다.
        image: { type: String },
        score: { type: Number }                    // 이름 대조 점수 0~1 (감사용, 화면엔 안 쓴다)
    }],
    collectorVersion: { type: String },
    createdAt: { type: Date, default: Date.now }
});
// ★★ unique 가 `date` 단독이 아니라 `date + section` 이다 (2026-08-17).
//   같은 날짜에 일일과 주간이 따로 들어와야 하는데, 단독 unique 로 두면 **두 번째가
//   11000 으로 막힌다.** 옛 `date_1` 인덱스는 ensureStatIndexes 가 지운다.
mythicShopSchema.index({ date: 1, section: 1 }, { unique: true });
mythicShopSchema.index({ 'items.catalogId': 1, date: -1 });   // "마지막 등장일" 조회용
mythicShopSchema.index({ section: 1, date: -1 });             // 구획별 최신 조회용
const MythicShop = mongoose.model('MythicShop', mythicShopSchema);

// ==========================================
// PBE 패치 미리보기 글 (2026-08-27 신설)
//   ★★ 왜 저장하나 — RSS 는 **최근 20글**만 준다. 그중 Preview 가 8건이라
//     화면이 두 달치밖에 못 보여줬다. 30분마다 읽는 김에 본 것을 적어 두면
//     지우지 않는 한 계속 쌓인다 (한 줄 100B 남짓 · TTL 없음).
//   ★ 과거분은 `backfill_pbe_notes.js` 가 한 번 채운다 (웨이백 + tweet-result).
// ==========================================
const pbeNoteSchema = new mongoose.Schema({
    tid: { type: String, required: true, unique: true },   // 트윗 id — 이게 열쇠다
    patch: { type: String },        // "26.17" (2024~2025 초 글은 옛 표기 "14.20"·"15.17" 이 그대로 온다)
    detail: { type: Boolean },      // 첫 줄에 Full 이 있으면 상세
    url: { type: String },
    date: { type: Date }
});
pbeNoteSchema.index({ date: -1 });
const PbeNote = mongoose.model('PbeNote', pbeNoteSchema);

// ==========================================
// [2] 전역 변수 및 서버(Express) 세팅
// ==========================================
const app = express();
app.set('trust proxy', 1);
// ★ IS_PROD (2026-09-03 감사 L-18). NODE_ENV 가 production 이 아니면 요청마다 index.html 을 다시 만들고
//   (readFileSync + statSync ~15회) Express 기본 에러 핸들러가 스택을 응답에 실었다. Railway 변수 화면에서
//   NODE_ENV 를 확인하기 전까지는 **Railway 표식(RAILWAY_PROJECT_ID)** 도 운영으로 친다 — 로컬 `node server.js` 는 그대로 개발
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_PROJECT_ID;
if (IS_PROD) app.set('env', 'production');

// ★★ 오리진 잠금 (2026-09-04 감사 M-7 · 실측으로 우회 확정). Cloudflare 를 우회해 오리진(m9focdi9.up.railway.app)에
//   직접 붙으면 cf-connecting-ip 를 매 요청 다른 값으로 위조해 세 리미터가 전부 무력화된다 (그 뒤에 versus-build
//   전수 스캔·라이엇 프록시가 있다). CF Transform Rule 이 모든 요청에 붙이는 x-origin-guard 헤더를 서버가 확인해
//   **CF 를 거친 요청만** 통과시킨다.
//   ★ ORIGIN_GUARD 가 설정됐을 때만 켠다 — 없으면 완전 통과(로컬 `node server.js`·변수 미설정 배포 무영향, no-op).
//   ★★ 배포 순서: ① 이 코드 배포(무변화) → ② CF 룰 등록 → ③ 브라우저로 사이트 확인 → ④ 마지막에 Railway 변수.
//     Railway 변수를 CF 룰보다 먼저 넣으면 서버는 검사를 켜는데 CF 는 헤더를 안 붙여 **전 요청 403(사이트 다운)** 이 된다.
//   ★ riot.txt(라이엇 도메인 인증)는 검증 봇 경로가 불확실하고 파일 자체가 무해하므로 항상 예외 — 잠겨도 심사에 지장 없게.
const ORIGIN_GUARD = process.env.ORIGIN_GUARD || '';
if (ORIGIN_GUARD) {
    const guardBuf = Buffer.from(ORIGIN_GUARD);
    app.use((req, res, next) => {
        if (req.path === '/riot.txt') return next();
        const got = req.headers['x-origin-guard'];
        if (typeof got === 'string' && got.length === ORIGIN_GUARD.length) {
            try { if (crypto.timingSafeEqual(Buffer.from(got), guardBuf)) return next(); } catch (_) {}
        }
        res.status(403).type('text/plain').send('forbidden');
    });
    console.log('[OriginGuard] 오리진 잠금 켜짐 (x-origin-guard 검사)');
}

// ★ 기본 보안 헤더 (2026-09-04 감사 L-15). helmet 을 쓰지 않고 부작용 없는 것만 직접 넣는다.
//   ★★ CSP 는 일부러 안 넣는다 — 인라인 onclick 54곳·style= 401곳이라 unsafe-inline 없이는 사이트가 죽고,
//     넣으면 방어 효과가 0 이라 의미가 없다. HSTS 도 서버에 안 넣는다(되돌리기 어려워 CF 에서 관리). cors 는 그대로.
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// ★ useClones:false (2026-09-03 감사 M-6) — 기본값 true 면 get 할 때마다 저장 객체를 깊은 복사한다.
//   랭킹 응답은 11,000 객체라 캐시 적중일 때조차 요청마다 11,000회 클론이 돌았다.
//   ★★ 대신 **캐시에서 꺼낸 객체를 호출부가 고치면 안 된다** — 고치면 캐시 본체가 바뀐다.
//     /api/summoner 의 expireAt 이 그 자리였고, 응답에서 `{...cached, expireAt}` 로 복사해 보낸다.
//   ★ maxKeys 는 일부러 안 뒀다 — node-cache 는 상한에 닿으면 set() 이 ECACHEFULL 을 **던져서** 그 라우트가
//     500 이 된다. 대신 사용자 입력이 키에 들어가는 자리(vs 빌드·신화상점 기간)를 검증·정규화해 키 폭을 막는다
const myCache = new NodeCache({ stdTTL: 300, useClones: false });
const API_KEY = process.env.API_KEY;

// 라이엇 API 전용 호출기 (키를 헤더에 담아 전송)
const riotApi = axios.create({
    headers: { 'X-Riot-Token': API_KEY },
    timeout: 10000
});

let currentVersion = "16.1.1";
let challengerList = [];
let rankUpdatedAt = 0;        // 랭킹 명단을 마지막으로 받아온 시각 (화면에 "N분 전 갱신")
let resolvedNames = {};
let failedPuuids = {};        // ★ 추가: 조회 실패한 puuid와 실패 시각
let isFetchingNames = false;
let resolvedMastery = {};     // puuid -> { top: [championId x5], updatedAt }
let failedMasteryPuuids = {};
let isFetchingMastery = false;
let resolvedCountIn10Mins = 0;
let arenaAugments = {};

// ★ 통계 수집 (2026-08-15)
let rankPuuidSet = new Set();   // 명단 puuid 집합. k 를 셀 때 쓴다 (updateChallengerList 가 갱신)
let matchScanDay = {};          // puuid -> 마지막으로 훑은 경기 날짜 (KST "2026-08-14")
let isScanningMatches = false;
let isFetchingStats = false;
let isBuildingStats = false;
let statCounters = { scan: 0, seen: 0, fetch: 0, save: 0, skip: 0 };

app.use(cors());
// ★ 응답 압축 (2026-09-03 감사 M-6). 없어서 오리진→Cloudflare 구간이 통째로 비압축이었다 —
//   /api/ranking 1.2MB · /api/champion-stats 117KB(gzip 16.8KB) 가 그대로 나갔다
app.use(compression());

// ==========================================
// index.html 자산 버전 자동 주입
//   브라우저가 예전 app.js / style.css를 붙들고 있으면
//   새 index.html이 내려가도 기능이 옛날 그대로 동작한다.
//   그래서 파일 수정 시각(mtime)을 쿼리스트링으로 붙여
//   내용이 바뀔 때만 브라우저가 새 파일로 인식하게 한다.
//
//     <script src="/app.js">  ->  <script src="/app.js?v=1754382910123">
//
//   index.html은 손댈 필요 없다. 여기서 응답할 때 자동으로 붙는다.
//   배포할 때 버전을 손으로 올리는 걸 깜빡할 일도 없다.
// ==========================================
const PUBLIC_DIR = path.join(__dirname, 'public');
let indexHtmlCache = null;

function renderIndexHtml() {
    if (indexHtmlCache) return indexHtmlCache;

    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

    // 같은 서버에서 주는 .js / .css 참조에만 버전을 붙인다 (CDN 주소는 그대로)
    //
    // ★ data-src 도 같이 잡는다 (2026-08-11). 챔피언 페이지 전용 데이터 3종은
    //   index.html 에서 바로 안 받고 app.js 가 챔피언 탭에 들어갈 때 붙인다.
    //   그때 src 로 두면 브라우저가 미리 받아버리므로 data-src 로 재워 두는데,
    //   여기서 버전을 안 붙이면 custom_values.js 를 고쳐도 옛 수치가 그대로 나온다.
    html = html.replace(/(src|href|data-src)="\/([A-Za-z0-9_\-.]+\.(?:js|css))"/g, (match, attr, file) => {
        try {
            const v = Math.floor(fs.statSync(path.join(PUBLIC_DIR, file)).mtimeMs);
            return `${attr}="/${file}?v=${v}"`;
        } catch (e) {
            return match;   // 파일이 없으면 원본 그대로
        }
    });

    // 운영 환경에서만 캐싱. 로컬은 매번 다시 읽어야 파일을 고치는 즉시 반영된다.
    if (IS_PROD) indexHtmlCache = html;
    return html;
}

// ★ og: 미리보기 카드 (2026-09-03, 기능 감사 F10). 경기 공유 링크(🔗)를 만들어 놨는데 카톡에 붙이면
//   제목만 나가던 반쪽을 채운다. 주소 꼴 셋(/summoner · /stats/<챔프> · /versus/<A>/<B>)만 제목을 바꾸고
//   나머지는 사이트 기본. 캐시된 index.html 위에 요청마다 <title> 앞에 끼워 넣는다 — DB 는 안 읽는다
//   (경기 번호까지 있는 링크도 소환사 이름으로만 적는다. 경기 한 판을 위해 DB 를 열 만큼의 값이 아니다)
const OG_SITE = 'PIXLOL.KR';
const OG_DEFAULT_DESC = '리그오브레전드 전적 검색 · 마스터+ 랭킹 · 챔피언 통계 · 도감';
const OG_POS_KR = { top: '탑', jungle: '정글', mid: '미드', middle: '미드', adc: '바텀', bottom: '바텀', bot: '바텀', support: '서포터', utility: '서포터' };
const escOg = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const champKrName = (key) => {
    if (!key) return null;
    const k = String(key).toLowerCase();
    for (const [ck, v] of Object.entries(champKeyMap)) if (ck.toLowerCase() === k) return v.name;
    return null;
};

function buildOgTags(reqPath) {
    let title = `${OG_SITE}: 리그오브레전드`, desc = OG_DEFAULT_DESC;
    const seg = reqPath.split('/').map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
    if (seg[1] === 'summoner' && seg[2]) {
        title = `${seg[2]} 전적 - ${OG_SITE}`;
        desc = `${seg[2]} 의 최근 전적 · 티어 · 인게임 정보`;
    } else if (seg[1] === 'stats' && seg[2] && !['patch', 'duo', 'trend'].includes(seg[2])) {
        const kr = champKrName(seg[2]) || seg[2];
        const pos = OG_POS_KR[String(seg[3] || '').toLowerCase()];
        title = `${kr}${pos ? ` ${pos}` : ''} 통계 · 빌드 - ${OG_SITE}`;
        desc = `${kr} 승률 · 픽률 · 룬 · 아이템 · 상성 (마스터+ 솔로랭크)`;
    } else if (seg[1] === 'versus' && seg[2] && seg[3]) {
        const a = champKrName(seg[2]) || seg[2], b = champKrName(seg[3]) || seg[3];
        title = `${a} vs ${b} 맞대결 - ${OG_SITE}`;
        desc = `${a} 와 ${b} 의 맞대결 승률 · 빌드 비교`;
    }
    const url = `https://pixlol.kr${reqPath}`;
    return [
        `<meta name="description" content="${escOg(desc)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="${OG_SITE}">`,
        `<meta property="og:title" content="${escOg(title)}">`,
        `<meta property="og:description" content="${escOg(desc)}">`,
        `<meta property="og:url" content="${escOg(url)}">`,
        `<meta property="og:image" content="https://pixlol.kr/favicon_lol_180.png">`,
        `<meta name="twitter:card" content="summary">`
    ].join('\n    ');
}

function sendIndexHtml(req, res) {
    // index.html 자체는 절대 캐시하면 안 된다.
    // 이 파일이 캐시되면 위에서 붙인 새 버전 번호가 전달되지 않는다.
    res.set('Cache-Control', 'no-cache');
    const html = renderIndexHtml().replace('<title>', () => buildOgTags(req.path) + '\n    <title>');
    res.type('html').send(html);
}

// express.static보다 먼저 잡아야 한다. 뒤에 두면 static이 원본을 그냥 내보낸다.
app.get('/', sendIndexHtml);
app.get('/index.html', sendIndexHtml);

// ★ 정적 자산 캐시 (2026-09-03, 감사 H-2). 예전엔 maxAge 기본값 0 이라 방문마다 전부 재검증(304)했다.
//   .js/.css 는 renderIndexHtml 이 ?v=mtime 을 붙이므로 영구 캐시가 안전하고, 배포하면 주소가 바뀌어
//   즉시 새 파일을 받는다. 그 밖(png·ico·lore/*.json·riot.txt)은 주소가 안 바뀌므로 4시간만.
app.use(express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res, filePath) {
        if (/\.(?:js|css)$/.test(filePath)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        else res.set('Cache-Control', 'public, max-age=14400');
    }
}));

// API 속도 제한 (Rate Limiting) - 1분에 30번
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => ipKeyGenerator(req.headers['cf-connecting-ip'] || req.ip),
    message: { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." }
});
app.use('/api/', apiLimiter);

// 자동완성 전용 제한 (라이엇 API를 쓰지 않으므로 넉넉하게)
const suggestLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
    keyGenerator: (req) => ipKeyGenerator(req.headers['cf-connecting-ip'] || req.ip),
    message: { error: "요청이 너무 많습니다." }
});
app.use('/api/suggest', suggestLimiter);

// ==========================================
// [3] 백그라운드 스케줄러 (데이터 갱신)
// ==========================================
async function loadResolvedNames() {
    try {
        const summoners = await SummonerCache.find({});
        summoners.forEach(s => {
            resolvedNames[s.puuid] = { displayName: s.displayName, updatedAt: s.updatedAt };
            // ★ 숙련도도 같이 메모리에 올려야 랭킹 응답에서 쓸 수 있다.
            //   DB 에만 있고 여기서 안 올리면 재시작할 때마다 전부 다시 받게 된다 (18시간짜리다).
            if (s.mastery && s.mastery.length) {
                resolvedMastery[s.puuid] = { top: s.mastery, updatedAt: s.masteryAt || 0 };
            }
            // ★ 통계 수집 순회 위치도 같이 올린다. 안 올리면 재시작마다 명단 전체를
            //   처음부터 다시 훑어 반나절치 호출을 통째로 날린다.
            if (s.matchScanDay) matchScanDay[s.puuid] = s.matchScanDay;
        });
        console.log(`[System] DB 로드: 닉네임 ${summoners.length}명, 숙련도 ${Object.keys(resolvedMastery).length}명, 전적 ${await MatchCache.countDocuments()}게임`);
    } catch (err) {
        console.error("[System] DB 로드 실패:", err.message);
    }
}

// ★ 챔피언 영문 키 → { id, name(한글) } (2026-09-03). og: 카드 제목용 — 서버에 챔피언 이름표가 없었다.
//   버전을 받는 김에 champion.json 한 번(부팅 + 갱신 주기). 실패해도 빈 표라 화면엔 영문 키가 나갈 뿐이다
let champKeyMap = {};
async function updateVersion() {
    try {
        const res = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json');
        currentVersion = res.data[0];
        console.log(`[Task] Data Dragon 최신 버전 갱신: ${currentVersion}`);
    } catch (e) {
        console.error("[Task] 버전 갱신 실패. 기본값을 사용합니다.");
    }
    try {
        const { data } = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${currentVersion}/data/ko_KR/champion.json`, { timeout: 10000 });
        const next = {};
        for (const c of Object.values(data?.data || {})) next[c.id] = { id: Number(c.key), name: c.name };
        if (Object.keys(next).length) champKeyMap = next;
    } catch (e) {
        console.error(`[Task] champion.json 갱신 실패 (og 제목은 영문 키로): ${e.message}`);
    }
}

async function updateArenaAugments() {
    try {
        const res = await axios.get('https://raw.communitydragon.org/latest/cdragon/arena/ko_kr.json');
        const raw = res.data?.augments;
        const list = Array.isArray(raw) ? raw : Object.values(raw || {});

        const map = {};
        for (const a of list) {
            if (a?.id == null) continue;
            const path = String(a.iconLarge || a.iconSmall || '').toLowerCase();
            map[a.id] = {
                name: a.name || '',
                desc: (a.desc || '').replace(/<[^>]+>/g, ''),
                icon: path ? `https://raw.communitydragon.org/latest/game/${path}` : null
            };
        }
        if (Object.keys(map).length > 0) {
            arenaAugments = map;
            console.log(`[Task] 아레나 증강체 데이터 갱신 완료 (${Object.keys(map).length}종)`);
        }
    } catch (err) {
        console.error("[Task] 아레나 증강체 갱신 실패:", err.message);
    }
}

// 티어별로 마지막에 성공한 명단을 따로 들고 있는다.
//   한 티어가 실패했다고 그 구간을 통째로 비우면 랭킹 페이지가 중간에서 끊긴다.
//   (마스터는 1만 명이라 응답이 커서 504 게이트웨이 타임아웃이 유독 자주 났다)
const RANK_TIERS = ['challengerleagues', 'grandmasterleagues', 'masterleagues'];
const rankListByTier = { challengerleagues: [], grandmasterleagues: [], masterleagues: [] };
const TIER_LETTER = { challengerleagues: 'C', grandmasterleagues: 'G', masterleagues: 'M' };
// ★ puuid → [티어 한 글자, LP] (2026-09-01). 상세 전적의 참가자 티어 배지 몫 —
//   명단이 갱신될 때마다 같이 다시 만든다. 조회는 buildHistoryEntry 가 한다 (라이엇 호출 0).
let rankTierByPuuid = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 504 같은 일시적 오류는 잠시 뒤 다시 하면 대개 성공한다.
async function fetchRankTier(tier, tries = 3) {
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const res = await riotApi.get(`https://kr.api.riotgames.com/lol/league/v4/${tier}/by-queue/RANKED_SOLO_5x5`);
            const entries = res.data?.entries || [];
            if (entries.length > 0) return entries;
            console.warn(`[Task] ${tier} 빈 응답 (${attempt}/${tries})`);
        } catch (e) {
            console.warn(`[Task] ${tier} 조회 실패 ${e.response?.status || e.message} (${attempt}/${tries})`);
        }
        if (attempt < tries) await sleep(3000 * attempt);
    }
    return null;   // 세 번 다 실패
}

async function updateChallengerList() {
    try {
        const results = await Promise.all(RANK_TIERS.map(tier => fetchRankTier(tier)));

        results.forEach((entries, i) => {
            const tier = RANK_TIERS[i];
            if (entries) {
                // ★ 어느 티어에서 왔는지를 항목에 찍어 둔다 (2026-08-13).
                //   합치고 나면 LP 로만 정렬해서 소속을 알 길이 없어진다. 화면이 순위 번호로
                //   (300위 이하 = 챌린저 식으로) 짐작하고 있었는데 그게 틀린다 —
                //   라이엇이 승격을 주기적으로만 처리해서 **마스터가 그마보다 LP 가 높은 일**이
                //   실제로 생긴다. 여기서 실명을 붙여 두면 추측할 일이 없다.
                entries.forEach(e => { e.tier = tier; });
                rankListByTier[tier] = entries;
                console.log(`[Task] ${tier}: ${entries.length}명`);
            } else {
                // 실패한 티어는 이전 명단을 그대로 쓴다
                console.error(`[Task Error] ${tier} 갱신 실패 — 기존 ${rankListByTier[tier].length}명 유지`);
            }
        });

        const combinedEntries = RANK_TIERS.flatMap(tier => rankListByTier[tier]);

        if (combinedEntries.length > 0) {
            challengerList = combinedEntries.sort((a, b) => b.leaguePoints - a.leaguePoints);
            // ★ k 판정용 집합을 같이 갱신한다. 명단이 10분마다 바뀌므로 여기서만 만든다.
            rankPuuidSet = new Set(challengerList.map(p => p.puuid));
            rankTierByPuuid = new Map(challengerList.map(p => [p.puuid, [TIER_LETTER[p.tier] || 'M', p.leaguePoints]]));
            rankUpdatedAt = Date.now();
            myCache.del('challenger_ranking_data');   // 새 명단이 왔으면 옛 응답을 버린다
            console.log(`[Task] 랭킹 명단 갱신 완료 (총 ${challengerList.length}명)`);
            // 오늘 명단을 사진 찍어 둔다 (내일 이 날짜 경기를 다룰 때 쓴다)
            saveRankSnapshot().catch(e => console.error('[Snapshot] 저장 실패:', e.message));
            saveApexDrift().catch(e => console.error('[Apex] 기록 실패:', e.message));
        } else {
            console.error("[Task Error] 랭킹 명단이 비어 있어 갱신하지 않음");
        }
    } catch (err) {
        console.error("[Task Error] 랭킹 명단 갱신 실패:", err.message);
    }
}

async function resolveNamesInBackground() {
    if (challengerList.length === 0 || isFetchingNames) return;
    isFetchingNames = true;

    const now = Date.now();
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
    const TOP_PRIORITY = 1000;   // 상위 1000명은 항상 먼저 처리

    // 아직 모르거나, 14일이 지나 갱신이 필요한 사람만 추림
    const ONE_DAY = 24 * 60 * 60 * 1000;

    const pending = challengerList
        .map((p, rank) => ({ ...p, rank }))
        .filter(p => {
            // 최근 24시간 내 조회 실패한 계정은 건너뜀
            if (failedPuuids[p.puuid] && now - failedPuuids[p.puuid] < ONE_DAY) return false;
            return !resolvedNames[p.puuid] || (now - resolvedNames[p.puuid].updatedAt > FOURTEEN_DAYS);
        });

    // 상위권을 앞으로 끌어올림
    const topPending = pending.filter(p => p.rank < TOP_PRIORITY);
    const restPending = pending.filter(p => p.rank >= TOP_PRIORITY);

    const targets = [...topPending, ...restPending].slice(0, 20);

    const skipped = Object.keys(failedPuuids).length;
    if (pending.length > 0) {
        console.log(`[Task] 닉네임 변환: 대기 ${pending.length}명 (상위권 ${topPending.length}명 / 조회불가 ${skipped}명 제외)`);
    }

    if (targets.length > 0) {
        for (const p of targets) {
            try {
                const accRes = await riotApi.get(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-puuid/${p.puuid}`);
                if (accRes.data.gameName) {
                    const dName = `${accRes.data.gameName}#${accRes.data.tagLine}`;
                    resolvedNames[p.puuid] = { displayName: dName, updatedAt: now };
                    delete failedPuuids[p.puuid];
                    await SummonerCache.findOneAndUpdate(
                        { puuid: p.puuid },
                        { displayName: dName, updatedAt: now, ...toSearchFields(dName) },
                        { upsert: true }
                    );
                    myCache.del('challenger_ranking_data');
                }
            } catch (err) {
                const status = err.response?.status;
                if (status === 404) {
                    // 존재하지 않는 계정 → 24시간 동안 재시도 안 함
                    failedPuuids[p.puuid] = now;
                } else {
                    // 429, 500 등 일시적 오류는 다음 사이클에 재시도
                    console.error(`[Name] 오류 ${p.puuid.substring(0, 8)}: ${status || err.message}`);
                }
            }

            resolvedCountIn10Mins++; // 처리할 때마다 카운트 1씩 증가 (로그는 안 띄움)
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    }
    isFetchingNames = false;
}

// ==========================================
// 숙련도 TOP5 채우기 (랭킹 표의 마지막 칸)
//   ★ 이 값은 champion-mastery v4 의 "전 큐 통합 누적 숙련도" 다.
//     솔랭 모스트가 아니다 — 큐별 모스트는 라이엇이 안 주고, 직접 세려면
//     1인당 경기 상세를 수십 번 받아야 해서 1.1만 명한테는 불가능하다.
//   ★ 닉네임 잡과 같은 구조인데 속도는 절반(분당 10명)이다. 두 잡이 동시에 몰리지 않도록
//     startJobs 에서 30초 어긋나게 띄운다.
//   ★ 한 바퀴에 약 18시간이 걸린다 (11,000명 / 분당 10명). 그래서 DB 에 저장하고
//     loadResolvedNames 가 다시 메모리에 올린다 — 재시작마다 처음부터면 영영 못 채운다.
// ==========================================
// 4주마다 갱신. 누적 숙련도는 랭크 모스트와 달리 순위가 잘 안 바뀌는 값이라
// 자주 받을 이유가 없다 (닉네임 14일보다도 길게 잡았다).
const MASTERY_TTL = 28 * 24 * 60 * 60 * 1000;

async function fillMasteryInBackground() {
    if (challengerList.length === 0 || isFetchingMastery) return;
    isFetchingMastery = true;

    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const TOP_PRIORITY = 1000;

    const pending = challengerList
        .map((p, rank) => ({ ...p, rank }))
        .filter(p => {
            if (failedMasteryPuuids[p.puuid] && now - failedMasteryPuuids[p.puuid] < ONE_DAY) return false;
            // ★ 닉네임이 아직 없는 사람은 건너뛴다. 두 가지 이유가 있다 —
            //   ① SummonerCache 에 줄이 없어서 저장할 곳이 없다(스키마상 displayName 이 필수라
            //      upsert 도 못 한다). 메모리에만 남으면 재시작 때 날아가 호출이 헛돈다
            //   ② 닉네임도 못 받은 줄은 화면에서 클릭도 안 되는 자리다. 숙련도가 더 급할 리 없다
            if (!resolvedNames[p.puuid]) return false;
            return !resolvedMastery[p.puuid] || (now - resolvedMastery[p.puuid].updatedAt > MASTERY_TTL);
        });

    const topPending = pending.filter(p => p.rank < TOP_PRIORITY);
    const restPending = pending.filter(p => p.rank >= TOP_PRIORITY);
    const targets = [...topPending, ...restPending].slice(0, 10);

    if (pending.length > 0) {
        console.log(`[Task] 숙련도: 대기 ${pending.length}명 (상위권 ${topPending.length}명 / 채움 ${Object.keys(resolvedMastery).length}명)`);
    }

    for (const p of targets) {
        try {
            const res = await riotApi.get(
                `https://kr.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${p.puuid}/top?count=5`
            );
            const top = (res.data || []).map(m => m.championId).filter(Boolean);
            resolvedMastery[p.puuid] = { top, updatedAt: now };
            delete failedMasteryPuuids[p.puuid];
            await SummonerCache.findOneAndUpdate(
                { puuid: p.puuid },
                { mastery: top, masteryAt: now },
                { upsert: false }   // 닉네임도 없는 사람에게 숙련도만 있는 줄을 만들지 않는다
            );
            myCache.del('challenger_ranking_data');
        } catch (err) {
            const status = err.response?.status;
            if (status === 404) {
                failedMasteryPuuids[p.puuid] = now;
            } else {
                console.error(`[Mastery] 오류 ${p.puuid.substring(0, 8)}: ${status || err.message}`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
    }

    isFetchingMastery = false;
}

// ==========================================
// 통계 수집 (2026-08-15 신설)
//
//   흐름:  명단 11,000명 matchlist  ->  매치 ID 등장 횟수 = k 하한
//            -> k >= 5 인 것만 detail  ->  슬림 문서로 저장하고 원본은 버린다
//
//   ★ matchlist 로 먼저 거르는 게 핵심이다. detail 을 받고 나서 걸러도 통계는 같지만
//     호출은 이미 나간 뒤라 한 푼도 아껴지지 않는다.
//   ★ 하루 1바퀴로 충분하다. 순회를 더 자주 돌아도 마스터+ 가 하루에 하는 판은 정해져
//     있어서 **수집되는 판 수가 안 늘고** 집계 지연만 줄어든다.
// ==========================================
const POS_CODE = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };
const STAT_QUEUE = 420;                      // 솔로랭크만 (라인 개념이 있고 표본이 가장 크다)
const STAT_MIN_K = 5;                        // 이 인원 이상일 때만 detail 을 받는다

// ★★ 하루를 반으로 나눠 역할을 분리한다 (2026-08-15).
//     00~12시  명단 순회      분당 16명 x 720분 = 11,520명  (명단 11,000명)
//     12~24시  detail 수집    분당 10건 x 720분 =  7,200건  (필요량 약 3,400건)
//   이렇게 하면 **정오에 순회가 완전히 끝나서 등장 횟수(k 하한)가 확정된 뒤에**
//   detail 을 받는다. 순회 도중에 받으면 아직 덜 세어진 판을 놓칠 수 있다.
//   덤으로 두 잡의 호출이 시간대로 갈려서 순간 호출량도 낮아진다.
const SCAN_PER_CYCLE = 16;                   // 분당 matchlist 호출 (순회 단계)
const FETCH_PER_CYCLE = 10;                  // 분당 detail 호출 (수집 단계)

// 한국시간 날짜
const kstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);

// ★ 단계는 **시각이 아니라 진행 상태**로 가른다.
//   분당 16명이면 11,000명에 11.5시간이라 자정에 시작해 정오쯤 끝나고, 결과적으로
//   "오전 순회 / 오후 수집" 이 된다. 그런데 시각으로 하드코딩하면 재시작하거나
//   429 로 밀렸을 때 **그날 순회를 통째로 건너뛴다.** 남은 인원으로 판단하면
//   늦게 시작해도 알아서 따라잡는다.
// 상위 티어가 LP 순위와 얼마나 어긋났나를 한 줄 남긴다.
//   ★ 명단이 덜 찼으면 세지 않는다 — 마스터 조회만 실패해도 1~1000등이 통째로 달라져
//     "갑자기 어긋남이 사라진 것" 처럼 보인다. 그게 바로 우리가 찾는 신호라 더 위험하다.
async function saveApexDrift() {
    if (challengerList.length < RANK_SET_MIN) return;

    const lp = (t) => {
        const v = challengerList.filter(p => p.tier === t).map(p => p.leaguePoints);
        return v.length ? { max: Math.max(...v), min: Math.min(...v) } : null;
    };
    const c = lp('challengerleagues'), g = lp('grandmasterleagues'), m = lp('masterleagues');
    if (!c || !g || !m) return;

    // challengerList 는 이미 LP 내림차순이라 앞에서 잘라 세면 그게 등수다
    const top1000 = challengerList.slice(0, 1000);
    const c300 = challengerList.slice(0, 300).filter(p => p.tier === 'challengerleagues').length;
    const c1000 = top1000.filter(p => p.tier === 'challengerleagues').length;
    const g1000 = top1000.filter(p => p.tier === 'grandmasterleagues').length;

    await ApexDrift.create({
        t: new Date(), c300, c1000, g1000,
        cMin: c.min, gMax: g.max, gMin: g.min, mMax: m.max
    });

    // 0 으로 떨어지는 순간이 곧 티어 재계산 시각이다
    console.log(`[Apex] 어긋남 챌린저 ${300 - c300}명(300등) · ${300 - c1000}명(1000등)` +
        ` · 그마 ${700 - g1000}명` +
        ` (챌 최저 ${c.min} / 그마 최고 ${g.max} / 마스터 최고 ${m.max})`);

}

// ==========================================
// ★★ 컷라인 — 23:45~23:59 의 1분 표본 15개 중 **하나를 골라** 하루 한 줄 (2026-08-19 개편)
//   `apexdrifts` 와 목적이 다르다. 저쪽은 어긋남을 분 단위로 보려는 것이라 TTL 7일이고,
//   이쪽은 날짜별 컷 추이를 길게 보려는 것이라 TTL 이 없다.
//
//   ★★ **고르는 기준은 `c300 + g1000` 이 가장 큰 표본이다.**
//     c300 = 상위 300등 안의 챌린저 수(최대 300) · g1000 = 상위 1000등 안의 그마 수(최대 700).
//     **둘 다 클수록 LP 순위와 티어 소속이 덜 어긋난 순간**이고, 그 순간의 티어 최저 LP 가
//     곧 그날의 진짜 컷이다. 합이 999~1000 이면 재계산 직후를 집은 것이다.
//     · 동점이면 **먼저 나온 표본**을 쓴다 (`>` 비교) — 재계산 직후 가장 이른 시점이다.
//   ★★ 예전 방식(창의 **첫 성공 한 줄**을 그대로 저장)이 왜 틀렸나: 23:45 는 재계산 10분
//     전이라 **하루 중 어긋남이 가장 큰 순간**이었다. 8/18 실측이 챌린저 8명·그마 20명
//     어긋난 상태였고, 그래서 "300등의 LP"(1830)가 실제 챌린저 컷(1773)과 57 차이 났다.
//   ★★ **표본을 따로 들고 있지 않는다** — `apexdrifts` 가 이미 분마다 c300·g1000·cMin·gMin
//     을 저장하므로 그걸 되읽는다. 재시작해도 안전하고, **규칙이 바뀌면 소급해서 다시 뽑을 수
//     있다** (apexdrifts TTL 7일 안에서). 백필로 8/17·8/18 을 이 규칙으로 다시 찍었다.
//   ★★ **명단 갱신 잡에 안 묶여 있다 (2026-08-19).** `scheduleCutoffJob()` 이 **한국시간
//     자정 +30초**에 하루 한 번 혼자 돈다. 예전엔 `saveApexDrift()` 끝에 얹혀 있었는데,
//     그러면 **그 사이클의 라이엇 조회가 실패하면 저장 시도조차 못 해서** 시각 창을 넓히고
//     여러 번 재시도하는 군더더기가 필요했다. 떼어내니 **라이엇 호출과 무관해져서**
//     한 번만 돌면 된다 — 표본은 이미 `apexdrifts` 에 다 들어 있다.
//   ★ `day` 는 지금 날짜가 아니라 **어제**다 (자정 직후에 도니까). 안 그러면 8/18 밤 자료가
//     8/19 로 들어간다.
//   ★ 표본이 아직 없으면 5분 뒤 다시 시도한다. `$setOnInsert` 라 두 번 돌아도 안 덮인다.
// ==========================================
const CUTOFF_FROM = 23 * 60 + 45;      // 표본 창 23:45 ~ 23:59 (rankRefreshMs 의 1분 창과 같다)
const CUTOFF_WINDOW_MIN = 15;          // 그 창의 길이(분). 1분 주기라 표본 15개가 정상이다
const CUTOFF_JOB_OFFSET = 30 * 1000;   // 한국시간 자정 + 30초에 돈다
const CUTOFF_RETRY = 5 * 60 * 1000;    // 실패하면 5분 뒤 다시 (성공하면 내일 자정)

// 그날 23:45~23:59 표본 중 c300+g1000 이 최대인 줄을 돌려준다. 없으면 null.
async function pickCutoffSample(day) {
    const from = new Date(`${day}T${String(Math.floor(CUTOFF_FROM / 60)).padStart(2, '0')}:` +
        `${String(CUTOFF_FROM % 60).padStart(2, '0')}:00+09:00`);
    const to = new Date(from.getTime() + CUTOFF_WINDOW_MIN * 60000);

    const rows = await ApexDrift.find({ t: { $gte: from, $lt: to } }).sort({ t: 1 }).lean();
    const ok = rows.filter(r => typeof r.cMin === 'number' && typeof r.gMin === 'number'
        && typeof r.c300 === 'number' && typeof r.g1000 === 'number');
    if (!ok.length) return null;

    let best = ok[0];
    for (const r of ok) if (r.c300 + r.g1000 > best.c300 + best.g1000) best = r;   // 동점은 먼저 것
    return { best, n: ok.length };
}

// 성공(또는 이미 있음)이면 true. 표본이 아직 없으면 false 를 돌려 재시도를 부른다.
async function saveRankCutoff() {
    const day = kstDay(Date.now() - 24 * 3600000);          // 표본을 모은 날 = 어제
    const picked = await pickCutoffSample(day);
    if (!picked) {
        console.warn(`[Cutoff] ${day} 표본이 없다 — ${CUTOFF_RETRY / 60000}분 뒤 다시 시도`);
        return false;
    }
    const { best, n } = picked;

    const r = await RankCutoff.updateOne(
        { day },
        { $setOnInsert: { day, t: best.t, lpChal: best.cMin, lpGm: best.gMin } },
        { upsert: true }
    );
    const hhmm = new Date(best.t.getTime() + 9 * 3600000).toISOString().slice(11, 19);
    if (r.upsertedCount) {
        console.log(`[Cutoff] ${day} 챌린저컷 ${best.cMin} / 그마컷 ${best.gMin}` +
            ` (표본 ${n}개 중 ${hhmm} 채택 · c300+g1000=${best.c300 + best.g1000})`);
    } else {
        console.log(`[Cutoff] ${day} 는 이미 있다 — 건너뜀`);
    }
    return true;
}

// ★ 다음 한국시간 자정(+30초)까지 남은 시간. 자정 직후에 불려도 오늘 것을 겨냥한다.
function nextCutoffDelay() {
    const kstNow = Date.now() + 9 * 3600000;
    let wait = CUTOFF_JOB_OFFSET - (kstNow % 86400000);
    if (wait <= 0) wait += 86400000;
    return wait;
}

function scheduleCutoffJob(overrideMs) {
    setTimeout(async () => {
        let ok = false;
        try { ok = await saveRankCutoff(); }
        catch (e) { console.error('[Cutoff] 저장 실패:', e.message); }
        scheduleCutoffJob(ok ? undefined : CUTOFF_RETRY);   // 실패하면 5분 뒤, 성공하면 내일 자정
    }, overrideMs === undefined ? nextCutoffDelay() : overrideMs);
}

// ==========================================
// 랭커 LP 일별 기록 잡 (2026-09-01) — 한국시간 자정 +2분, 하루 한 번
//   ★ 컷라인 잡(+30초)과 일부러 어긋나게 — 1.1만 건 쓰기가 자정 정각에 몰리지 않게.
//   ★ 라이엇 호출 0 — 이미 5~10분마다 받아 둔 명단(challengerList)을 재사용한다.
//   ★ day 딱지는 **어제**다 (컷라인 잡과 같은 규칙 — 자정 직후의 명단은 어젯밤 마감 LP 다).
// ==========================================
const LP_HIST_MAX = 180;                 // 스플릿 하나 길이 (2026-09-01 사용자 결정)
const LP_JOB_OFFSET = 2 * 60 * 1000;
const LP_JOB_RETRY = 5 * 60 * 1000;

const yymmdd = (ms) => Number(kstDay(ms).slice(2).replace(/-/g, ''));   // "2026-09-01" → 260901

async function saveLpHistory() {
    if (!challengerList.length) return false;    // 부팅 직후 명단이 비면 5분 뒤 재시도
    const day = yymmdd(Date.now() - 86400000);   // 어제

    const ops = challengerList.map(p => ({
        updateOne: {
            // ★ lastDay 가드 — 재시작·중복 실행이 같은 날 두 점을 만들지 않게.
            //   이미 기록된 문서는 filter 에 안 걸려 upsert 가 중복 키(E11000)로 터지는데,
            //   그건 "이미 했다" 는 뜻이라 아래에서 삼킨다.
            filter: { puuid: p.puuid, lastDay: { $ne: day } },
            update: {
                $set: { lastDay: day },
                $push: { hist: { $each: [[day, p.leaguePoints, TIER_LETTER[p.tier] || 'M']], $slice: -LP_HIST_MAX } }
            },
            upsert: true
        }
    }));
    let written = 0;
    for (let i = 0; i < ops.length; i += 2000) {
        try {
            const r = await LpHistory.bulkWrite(ops.slice(i, i + 2000), { ordered: false });
            written += (r.modifiedCount || 0) + (r.upsertedCount || 0);
        } catch (e) {
            if (e.code !== 11000 && !/E11000/.test(e.message || '')) throw e;
            written += e.result?.nModified || 0;
        }
    }
    // 명단에서 빠진 지 LP_HIST_MAX 일이 지난 문서는 지운다 (YYMMDD 수는 대소 비교가 날짜순과 같다)
    const cutoff = yymmdd(Date.now() - (LP_HIST_MAX + 1) * 86400000);
    await LpHistory.deleteMany({ lastDay: { $lt: cutoff, $gt: 0 } }).catch(() => { });
    console.log(`[LpHist] ${day} LP 기록 ${written}명 / 명단 ${challengerList.length}명`);
    return true;
}

function nextLpHistDelay() {
    const kstNow = Date.now() + 9 * 3600000;
    let wait = LP_JOB_OFFSET - (kstNow % 86400000);
    if (wait <= 0) wait += 86400000;
    return wait;
}

function scheduleLpHistoryJob(overrideMs) {
    setTimeout(async () => {
        let ok = false;
        try { ok = await saveLpHistory(); }
        catch (e) { console.error('[LpHist] 저장 실패:', e.message); }
        scheduleLpHistoryJob(ok ? undefined : LP_JOB_RETRY);
    }, overrideMs === undefined ? nextLpHistDelay() : overrideMs);
}

// ★★ 스냅샷을 **합집합으로** 쌓는다 — "그날 명단에 한 번이라도 있던 사람" 이 맞다.
//   명단은 10분마다 갈리므로 어느 한 순간을 찍으면 그날 낮에 강등된 사람이 빠진다.
//   첫 저장만 1.1만 건이고 그 뒤로는 **새로 들어온 사람만** 더한다 (하루 400명 남짓).
let rankSnapshotDay = null;
let rankSnapshotSet = new Set();

async function saveRankSnapshot() {
    if (rankPuuidSet.size === 0) return;
    const day = kstDay(Date.now());

    // 날짜가 넘어갔거나 방금 재시작했으면 그날 문서를 먼저 읽어 온다.
    // ★ 안 읽으면 재시작할 때마다 1.1만 건을 통째로 다시 밀어 넣는다 ($addToSet 이라
    //   결과는 같지만 쓸데없이 큰 쓰기가 배포마다 한 번씩 생긴다).
    if (rankSnapshotDay !== day) {
        const doc = await RankSnapshot.findOne({ day }).select('puuids').lean().catch(() => null);
        rankSnapshotSet = new Set(doc?.puuids || []);
        rankSnapshotDay = day;
    }

    const fresh = [...rankPuuidSet].filter(id => !rankSnapshotSet.has(id));
    if (fresh.length === 0) return;

    const size = rankSnapshotSet.size + fresh.length;
    await RankSnapshot.updateOne(
        { day },
        { $addToSet: { puuids: { $each: fresh } }, $set: { n: size }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
    fresh.forEach(id => rankSnapshotSet.add(id));
    console.log(`[Snapshot] ${day} 명단 ${size}명 (새로 ${fresh.length}명)`);
}

// ★★ 순회 대상 = **오늘 명단 ∪ 대상일(어제) 명단** (2026-08-17).
//   어제 마스터였다가 오늘 빠진 사람에게도 물어봐야 그 사람 몫의 등장 횟수가 안 샌다.
//   ★ 대상일 스냅샷이 없으면(도입 첫날·재시작 직후) 지금 명단만 쓴다 — 예전과 같은 동작이라
//     안전한 쪽으로 물러나는 것이다. 없다고 순회를 멈추면 그날이 통째로 빈다.
let scanExtraDay = null;
let scanExtraSet = new Set();

async function loadScanExtra() {
    const day = scanTargetDay();
    if (scanExtraDay === day) return;
    const doc = await RankSnapshot.findOne({ day }).select('puuids').lean().catch(() => null);
    scanExtraSet = new Set(doc?.puuids || []);
    scanExtraDay = day;
    console.log(`[Snapshot] 순회 대상일 ${day} 명단 ${scanExtraSet.size}명을 물려받았다`);
}

// ★ scanPending 과 scanMatchlists 가 **같은 목록**을 봐야 한다.
//   여기가 어긋나면 순회가 영원히 안 끝나 수집 단계로 못 넘어간다 (단계 전환 조건이 이 값이다).
const scanTargets = (day) => {
    const all = new Set(rankPuuidSet);
    scanExtraSet.forEach(id => all.add(id));
    return [...all].filter(puuid => matchScanDay[puuid] !== day);
};

const scanPending = () => scanTargets(scanTargetDay()).length;

// ★★ 수집 대상은 **어제 하루 전체**다 ("최근 24시간" 이 아니다).
//   예전엔 각자 "훑는 시점 기준 24시간" 을 봤는데, 순회가 반나절에 걸쳐 있어서
//   **사람마다 보는 창이 어긋났다.** A 를 0시에 훑으면 전날 0~24시를, B 를 11시에
//   훑으면 전날 11시~당일 11시를 보게 되어, 같은 판을 했어도 한쪽만 세는 일이 생긴다.
//   실측에서 `cnt < 실제 k` 가 52건 중 50건이었던 게 이것이다.
//   날짜로 못 박으면 전원이 같은 창을 보므로 등장 횟수가 정확해지고,
//   **일별 통계도 그 날짜가 통째로 채워진다** (지금은 부분만 채워진다).
const scanTargetDay = () => kstDay(Date.now() - 86400000);

// 룬 11칸을 뽑는다. 실측 1,000명 전원이 "주 계열 + 룬 4개 / 보조 계열 + 룬 2개 /
// 스탯 파편 3개" 로 형태가 같아서 길이를 못 박아도 안전하다.
function perkValues(p) {
    const styles = p.perks?.styles || [];
    const primary = styles.find(s => s.description === 'primaryStyle') || styles[0] || {};
    const sub = styles.find(s => s.description === 'subStyle') || styles[1] || {};
    const ps = (primary.selections || []).map(s => s.perk);
    const ss = (sub.selections || []).map(s => s.perk);
    const sp = p.perks?.statPerks || {};
    return [
        primary.style ?? 0, ps[0] ?? 0, ps[1] ?? 0, ps[2] ?? 0, ps[3] ?? 0,
        sub.style ?? 0, ss[0] ?? 0, ss[1] ?? 0,
        sp.offense ?? 0, sp.flex ?? 0, sp.defense ?? 0
    ];
}

// detail -> 슬림 문서. 통계에 쓸 값만 배열로 눕힌다.
//
// ★★ 참가자 1명 = 28칸이고 **자리가 곧 의미다.** 집계가 $arrayElemAt 으로 자리를
//   찍어 읽으므로, 순서를 바꾸거나 중간에 끼워 넣으면 **이미 저장된 문서가 통째로
//   어긋난다.** 새 값은 반드시 **뒤에** 붙일 것.
//
//    0 챔피언   1 라인(0탑~4서폿, -1 판정실패)   2 승패   3 팀(100/200)
//    4 킬   5 데스   6 어시   7 챔피언 딜량   8 골드
//    9~14 최종 아이템 6칸
//   15 소환사 주문1   16 소환사 주문2
//   17 주 룬계열   18~21 주 룬 4개
//   22 보조 룬계열   23~24 보조 룬 2개
//   25 공격 파편   26 유연 파편   27 방어 파편
//   ★ rankSet 은 **그 경기 날짜의 명단**이다 (2026-08-17). 예전엔 전역 rankPuuidSet
//     ("지금 명단")을 직접 봤는데, 수집이 경기 다음 날 저녁이라 그 사이 강등된 사람이
//     안 세어져 5명짜리가 4명으로 찍혔다. 부르는 쪽에서 날짜에 맞는 집합을 넘긴다.
// ★★ 타임라인에서 **빌드에 쓰는 것만** 뽑는다 (2026-08-26 신설).
//   원본이 판당 759KB 라 통째로는 못 담는다 — 실측 기준 이 함수가 3.4KB 로 줄인다.
//
//   ★ 소모품·장신구는 뺀다. 물약·와드는 "빌드" 가 아니라 잡음인데 **구매 건수의 3분의 1**을
//     차지한다. 시작 아이템(도란검·롱소드)과 완성템은 그대로 남는다.
//   ★ `ITEM_UNDO`(되사기 취소)는 **직전 구매를 지운다.** 안 지우면 "샀다 무른" 아이템이
//     빌드에 섞인다 — 상점에서 잘못 눌렀다 무르는 일이 흔하다.
const TL_SKIP_ITEMS = new Set([
    2003, 2031, 2033, 2010,          // 체력 물약 · 충전형 물약 · 부패 물약 · 비스킷
    2055,                            // 제어 와드
    3340, 3363, 3364,                // 장신구 (투명 와드 · 망원형 개조 · 예언자의 렌즈)
    2138, 2139, 2140,                // 영약 3종
    2422, 2419                       // 잡화(추적자의 팔목 등 되팔리는 자리)
]);

// ★★ `keepIds` 를 주면 **집계가 쓰는 구매만** 담는다 (2026-09-09 — Atlas 512MB 가 찼다).
//   남기는 규칙: **600초(TL_EARLY_SEC) 안 구매** 이거나 **완성 아이템**.
//   집계(buildOneTimelineScope)가 보는 건 시작(≤90초) · 초반(90~600초) · 완성 아이템(코어 순서)뿐이라
//   **1코어·2코어·시작템·신발 통계에 손실이 없다.** 빠지는 건 600초 뒤에 산 조합 재료다.
//   실측: 판당 149건 → 80건(53%). 안 주면(null) 예전처럼 전부 담는다.
function toSlimTimeline(timeline, keepIds) {
    const frames = timeline?.info?.frames;
    if (!Array.isArray(frames)) return null;

    const skills = {};           // 참가자 → 스킬 슬롯 배열
    const buys = [];             // [초, 참가자0~9, 아이템id]

    frames.forEach(f => (f.events || []).forEach(e => {
        const pid = e.participantId;
        if (!pid || pid < 1 || pid > 10) return;

        if (e.type === 'SKILL_LEVEL_UP') {
            const ch = 'QWER'[(e.skillSlot || 0) - 1];
            if (ch) (skills[pid] || (skills[pid] = [])).push(ch);
        } else if (e.type === 'ITEM_PURCHASED') {
            if (TL_SKIP_ITEMS.has(e.itemId)) return;
            const sec = Math.round((e.timestamp || 0) / 1000);
            // ★ 되무름(ITEM_UNDO)이 뒤에서 찾아 지우므로 **거르는 건 여기서** 해야 짝이 맞는다
            if (keepIds && sec > TL_EARLY_SEC && !keepIds.has(e.itemId)) return;
            buys.push([sec, pid - 1, e.itemId]);
        } else if (e.type === 'ITEM_UNDO') {
            // 되무른 아이템을 뒤에서부터 하나 지운다 (같은 참가자의 마지막 구매)
            const gone = e.beforeId;
            if (!gone) return;
            for (let i = buys.length - 1; i >= 0; i--) {
                if (buys[i][1] === pid - 1 && buys[i][2] === gone) { buys.splice(i, 1); break; }
            }
        }
    }));

    // 참가자 순서대로 문자열 10칸. 없는 자리는 빈 문자열이라 자리는 유지된다.
    const sk = Array.from({ length: 10 }, (_, i) => (skills[i + 1] || []).join(''));
    if (!buys.length && sk.every(x => !x)) return null;
    return { sk, it: buys.flat() };
}

function toSlimMatch(detail, rankSet) {
    const info = detail?.info;
    const meta = detail?.metadata;
    if (!info || !meta || info.queueId !== STAT_QUEUE) return null;
    if (!Array.isArray(info.participants) || info.participants.length !== 10) return null;

    // ★ 리메이크(다시하기)는 뺀다. 실제 경기가 아닌데 win 이 5:5 로 찍혀서
    //   안 빼면 승률에 그대로 노이즈가 섞인다. 솔랭 기준 0.7% 정도 나온다.
    //   gameDuration 으로 자르면 안 된다 — 리메이크는 65~90초인데 5분 근처엔
    //   정상 경기(326초 GameComplete)도 있다. 전용 필드가 정확하다.
    if (info.participants.some(p => p.gameEndedInEarlySurrender)) return null;

    // ★ 정확한 k 는 여기서 나온다. matchlist 등장 횟수는 하한일 뿐이다.
    const k = (meta.participants || []).filter(id => rankSet.has(id)).length;

    return {
        matchId: meta.matchId,
        k,
        v: (info.gameVersion || '').split('.').slice(0, 2).join('.'),
        t: Math.floor((info.gameCreation || 0) / 1000),
        d: info.gameDuration || 0,
        p: info.participants.map(p => [
            p.championId ?? 0,
            POS_CODE[p.teamPosition] ?? -1,
            p.win ? 1 : 0,
            p.teamId ?? 0,
            p.kills ?? 0, p.deaths ?? 0, p.assists ?? 0,
            p.totalDamageDealtToChampions ?? 0, p.goldEarned ?? 0,
            p.item0 ?? 0, p.item1 ?? 0, p.item2 ?? 0, p.item3 ?? 0, p.item4 ?? 0, p.item5 ?? 0,
            p.summoner1Id ?? 0, p.summoner2Id ?? 0,
            ...perkValues(p)
        ]),
        // ★ -1 은 "밴을 안 했다" 는 뜻이라 뺀다. 솔랭 판의 66%에 하나 이상 들어 있어서
        //   그대로 담으면 밴률 분자가 엉킨다.
        b: (info.teams || []).flatMap(t => (t.bans || []).map(x => x.championId)).filter(id => id > 0)
    };
}

// ① 명단을 훑으며 매치 ID 등장 횟수를 센다 (오전에만 돈다)
async function scanMatchlists() {
    if (challengerList.length === 0 || isScanningMatches) return;
    isScanningMatches = true;

    try {
        const day = scanTargetDay();
        const from = Math.floor(Date.parse(`${day}T00:00:00+09:00`) / 1000);
        const to = from + 86400;

        // ★ 대상일 명단을 물려받는다 (하루 한 번만 읽는다)
        await loadScanExtra();

        // 이 날짜를 아직 안 훑은 사람만. 다 훑었으면 쉰다 (그때부터 수집 단계다).
        //   ★ 오늘 명단 + 대상일 명단이다. 오늘 빠진 사람도 어제 게임은 했다.
        const targets = scanTargets(day).slice(0, SCAN_PER_CYCLE).map(puuid => ({ puuid }));
        if (targets.length === 0) {
            // ★ 순회가 끝난 날짜에 표시를 남긴다 (하루 한 번). 수집이 다음 날 이 날짜의 잔량을
            //   따라잡을지 정하는 근거다 — 메모리에만 두면 재시작 때 잃어서 스냅샷 문서에 적는다.
            if (scanDoneMarkedDay !== day) {
                scanDoneMarkedDay = day;
                RankSnapshot.updateOne({ day }, { $set: { scanDone: true } }).catch(() => { });
            }
            isScanningMatches = false;
            return;
        }

        for (const p of targets) {
            try {
                // ★ endTime 까지 준다. 하루가 통째로 닫힌 구간이라 전원이 같은 창을 본다.
                //   count 는 100(최대)로 둔다 — 하루 100판을 넘기는 사람은 없고,
                //   모자라면 그 사람 판이 통째로 누락되므로 넉넉한 쪽이 안전하다.
                const res = await riotApi.get(
                    `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${p.puuid}/ids` +
                    `?queue=${STAT_QUEUE}&startTime=${from}&endTime=${to}&start=0&count=100`
                );
                const ids = res.data || [];

                if (ids.length > 0) {
                    // 한 번에 밀어 넣는다. 낱개로 보내면 DB 왕복만 그만큼이다.
                    await MatchSeen.bulkWrite(ids.map(id => ({
                        updateOne: {
                            filter: { matchId: id },
                            update: { $inc: { cnt: 1 }, $setOnInsert: { day, createdAt: new Date() } },
                            upsert: true
                        }
                    })), { ordered: false });
                    statCounters.seen += ids.length;
                }

                matchScanDay[p.puuid] = day;
                statCounters.scan++;
                // 닉네임이 없는 사람은 SummonerCache 에 줄이 없다(displayName 이 필수라
                // upsert 도 못 한다). 그런 사람은 메모리에만 두고 넘어간다.
                SummonerCache.updateOne({ puuid: p.puuid }, { matchScanDay: day }).catch(() => { });

            } catch (err) {
                const status = err.response?.status;
                if (status === 429) {
                    // 한도에 닿았으면 이번 사이클은 접는다. 다음 분에 다시 온다.
                    console.warn('[Stat] 429 — 이번 사이클 중단');
                    break;
                }
                // 그 외 오류는 다음 사이클에 자연히 재시도된다 (matchScanDay 를 안 찍는다)
                console.error(`[Stat] matchlist 실패 ${p.puuid.substring(0, 8)}: ${status || err.message}`);
            }
            await sleep(1200);
        }
    } finally {
        isScanningMatches = false;
    }
}

// ② 기준을 넘긴 매치만 detail 을 받아 슬림으로 저장한다 (오후에만 돈다)
//   ★ 순회가 끝난 뒤에 도는 게 핵심이다. 순회 도중이면 등장 횟수가 아직 덜 세어져서
//     기준(5)을 못 넘긴 판을 그냥 지나칠 수 있다.
// ★★ 명단이 이만큼은 차 있어야 k 를 센다 (2026-08-16 사고로 추가).
//   정상값은 11,000명(챌 300 + 그마 700 + 마스터 1만)이라 5,000이면 넉넉한 하한이다.
const RANK_SET_MIN = 5000;

// k 를 셀 때 쓸 집합. **대상일 스냅샷이 있으면 그것**, 없으면 지금 명단이다.
//   하루에 한 번만 읽는다 (분마다 0.9MB 를 읽을 이유가 없다).
// ★ 날짜별로 캐시한다 (2026-08-27) — 수집이 전날 잔량까지 따라잡으면서 한 사이클에
//   두 날짜의 명단이 필요해졌다. 오래된 날짜는 지워서 두 개 넘게 안 쌓인다.
const statRankCacheByDay = new Map();
let statRankWarnedDay = null;
let scanDoneMarkedDay = null;

// 그 날짜의 순회가 끝까지 돌았나 (스냅샷 문서의 scanDone). 날짜별로 한 번만 읽는다 —
// true 만 캐시한다. false 는 "아직" 일 수 있어서 다음 사이클에 다시 본다.
const scanDoneCache = new Set();
async function scanDoneOn(day) {
    if (scanDoneCache.has(day)) return true;
    const doc = await RankSnapshot.findOne({ day }).select('scanDone').lean().catch(() => null);
    if (doc?.scanDone) { scanDoneCache.add(day); return true; }
    return false;
}

// ★ 수집 창에서 빠져나간 날짜의 결산을 한 줄 남긴다 (2026-08-27).
//   창은 {대상일, 그 전날} 이라 자정에 대상일이 넘어가면 "그저께" 가 빠진다 — 그 순간이
//   그 날짜의 최종 처리량이 확정되는 때다. 이 줄이 "그날 통계가 얼마나 온전한가" 의 기록이다.
//   matchseens TTL 이 3일이라 이때까진 문서가 남아 있다 (순회는 경기 다음 날 아침이므로 ~2일).
let statWindowDay = null;
async function reportClosedStatDay() {
    const day = scanTargetDay();
    if (statWindowDay === day) return;
    const first = statWindowDay === null;
    statWindowDay = day;
    if (first) return;                                   // 기동 직후엔 결산할 날짜가 없다
    const closed = kstDay(Date.now() - 3 * 86400000);
    const cond = { day: closed, cnt: { $gte: STAT_MIN_K } };
    const [total, done] = await Promise.all([
        MatchSeen.countDocuments(cond), MatchSeen.countDocuments({ ...cond, done: true })
    ]).catch(() => [0, 0]);
    if (!total) return;
    const scanned = await scanDoneOn(closed);
    const miss = total - done;
    const line = `[Stat] ${closed} 수집 종료: ${done}/${total}판 처리` +
        (miss ? ` — ${miss}판 놓침` : '') + (scanned ? '' : ' (순회 미완료)');
    (miss ? console.warn : console.log)(line);
}

async function statRankSet(day = scanTargetDay()) {
    if (statRankCacheByDay.has(day)) return statRankCacheByDay.get(day);

    const doc = await RankSnapshot.findOne({ day }).select('puuids').lean().catch(() => null);
    const snap = new Set(doc?.puuids || []);

    if (snap.size >= RANK_SET_MIN) {
        console.log(`[Stat] k 판정에 ${day} 명단 ${snap.size}명을 쓴다`);
        statRankCacheByDay.set(day, snap);
        for (const d of statRankCacheByDay.keys()) if (d < kstDay(Date.now() - 3 * 86400000)) statRankCacheByDay.delete(d);
        return snap;
    }

    // ── 도입 첫날이거나 스냅샷이 덜 찬 경우. 예전 동작(지금 명단)으로 물러난다.
    //   ★★ 이 경로는 **캐시하지 않는다.** 두 가지 이유가 다 중요하다:
    //     ① `rankPuuidSet` 은 10분마다 **새 Set 으로 갈아 끼워진다.** 참조를 캐시해 두면
    //        그 시점 명단에 하루 종일 묶여 옛 명단으로 k 를 세게 된다.
    //     ② 스냅샷이 조금 뒤에 채워질 수도 있다. 캐시를 안 하면 다음 사이클에 알아서 갈아탄다.
    if (statRankWarnedDay !== day) {
        console.warn(`[Stat] ${day} 스냅샷이 ${snap.size}명뿐이라 지금 명단(${rankPuuidSet.size}명)으로 k 를 센다`);
        statRankWarnedDay = day;   // 분마다 찍히면 로그가 묻힌다
    }
    return rankPuuidSet;
}

async function fetchMatchStats() {
    // ★★ `size === 0` 만 보면 안 된다 — **명단이 "일부만" 찬 창이 실제로 있었다.**
    //   2026-08-16 14시대에 저장된 586건 중 98건(16.7%)이 `cnt=9 인데 k=0` 으로 들어갔다.
    //   재시작 직후 updateChallengerList 에서 일부 티어만 성공하면 rankListByTier 의
    //   나머지가 빈 배열이라(첫 기동이라 물려받을 이전 명단도 없다) rankPuuidSet 이
    //   수백 명짜리가 된다. size 는 0이 아니니 이 가드를 통과하고, 그 상태로 수집하면
    //   **마스터 9명이 낀 판이 k=0 으로 기록된다.**
    //   ★ k 는 원본을 안 남겨서 나중에 다시 셀 수 없다 (슬림 문서에 puuid 가 없다).
    //     그래서 "틀리게 저장하느니 안 하는" 쪽이 맞다 — 잠깐 쉬면 다음 분에 다시 온다.
    if (isFetchingStats || rankPuuidSet.size < RANK_SET_MIN) {
        if (!isFetchingStats && rankPuuidSet.size > 0) {
            console.warn(`[Stat] 명단이 ${rankPuuidSet.size}명뿐이라 수집을 건너뛴다 (최소 ${RANK_SET_MIN})`);
        }
        return;
    }
    // ★ 순회가 남아 있으면 손대지 않는다. 등장 횟수가 아직 덜 세어져서
    //   기준(5)을 못 넘긴 판을 그냥 지나치게 된다.
    //   ★ 대상일 명단을 여기서도 먼저 물려받는다 — 안 그러면 재시작 직후 첫 1분에
    //     **대상일 명단 몫(437명)을 뺀 채로** pending 을 세어 0 으로 보고 수집을 시작한다.
    await loadScanExtra();
    if (scanPending() > 0) return;
    isFetchingStats = true;

    // ★★ 타임라인에서 **집계가 쓰는 구매만** 남기려고 완성 아이템 목록을 미리 받아 둔다
    //   (2026-09-09, Atlas 512MB 가 차서). 실측: 판당 149건 → 80건(53%) · `it` 186MB → 99MB.
    //   ★ 1코어·2코어·시작템·초반템 통계는 **손실이 없다** — 코어는 완성 아이템이고,
    //     시작·초반은 600초 안 구매라 둘 다 남는다. 빠지는 건 600초 뒤에 산 **조합 재료**뿐이다.
    //   ★ 목록을 못 받으면 null 을 넘겨 예전처럼 전부 담는다 (틀리게 줄이느니 큰 게 낫다).
    let tlKeepIds = null;
    try {
        const ci = await loadCompletedItems();
        tlKeepIds = new Set(ci.complete);
    } catch (e) {
        console.warn('[Stat] 완성 아이템 목록을 못 받아 타임라인을 통째로 담는다:', e.message);
    }

    try {
        // ★★ k 는 **그 경기 날짜의 명단**으로 센다 (2026-08-17). 수집이 경기 다음 날
        //   저녁이라 "지금 명단" 으로 세면 그 사이 강등된 사람이 빠져 5명짜리가 4명이 된다.
        //   ★ 스냅샷이 없거나 너무 작으면 지금 명단으로 물러난다 — 예전과 같은 동작이다.
        //     여기서 멈추면 그날 수집이 통째로 날아가므로, 조금 틀리더라도 도는 편이 낫다.
        // ★ 대상일(어제)을 먼저, 남는 자리에 **그 전날 잔량**을 채운다 (2026-08-27).
        //   예전엔 대상일만 봤다 — 자정이 지나면 못 끝낸 판은 대상에서 빠져 TTL 로 사라졌고
        //   (429 가 이어지거나 서버가 반나절 죽은 날), 로그도 없이 그날 통계가 얇게 굳었다.
        //   ★ 전날은 **순회가 끝까지 돈 날(`scanDone`)만** 따라잡는다. 서버를 늦게 띄워
        //     순회가 반만 된 날은 cnt 가 하한조차 못 되어 그 판들을 처리하면 편향이 생긴다 —
        //     그런 날은 예전처럼 버린다.
        //   ★ 전날 판이 늦게 들어오면 매시간 집계가 그 날짜를 다시 계산해 숫자가 조금 오른다.
        //     전체 재계산 구조라 값은 정확해지는 방향이다.
        // 사람이 많이 낀 판부터 처리한다. 명단 커버리지가 높은 판이 통계 가치도 높다.
        const day = scanTargetDay();
        const pending = (d, n) => MatchSeen
            .find({ done: { $ne: true }, cnt: { $gte: STAT_MIN_K }, day: d })
            .sort({ cnt: -1 }).limit(n).lean();
        let targets = await pending(day, FETCH_PER_CYCLE);
        if (targets.length < FETCH_PER_CYCLE) {
            const prev = kstDay(Date.now() - 2 * 86400000);
            if (await scanDoneOn(prev)) {
                targets = targets.concat(await pending(prev, FETCH_PER_CYCLE - targets.length));
            }
        }

        for (const t of targets) {
            try {
                // ★ k 는 그 경기 날짜의 명단으로 센다 — 날짜가 둘일 수 있어 판마다 고른다
                const rankSet = await statRankSet(t.day || day);
                const { data } = await riotApi.get(
                    `https://asia.api.riotgames.com/lol/match/v5/matches/${t.matchId}`
                );
                const slim = toSlimMatch(data, rankSet);

                if (slim) {
                    // ★★ 타임라인도 같이 받는다 (2026-08-26) — 시작템·코어순서·스킬순서용.
                    //   ★ 별도 잡을 만들지 않은 이유: 이 루프가 이미 그 매치를 처리 중이고
                    //     `MatchSeen.done` 도 여기서 찍는다. 잡을 나누면 "detail 은 받았는데
                    //     타임라인은 못 받은" 상태를 따로 관리해야 한다.
                    //   ★ **실패해도 detail 은 살린다** — 타임라인은 곁가지라 그것 때문에
                    //     통계 본체를 버리면 손해가 크다. 그 판은 `sk`/`it` 이 없을 뿐이다.
                    //   ★ 호출이 판당 2회가 된다 (분당 10 → 20). 순간 최대 22/50 라 여유가 있다.
                    //   ★★ **16.17 패치부터만 받는다** (2026-08-26 밤, 사용자 지시 — 16.16 은 아이템·스킬 로그 없이 간다).
                    //     낮에 켤 때 버전을 안 가려서 16.16 판 1,032개에 이미 들어갔는데, 집계(`TL_MIN_PATCH`)가
                    //     16.16 을 건너뛰므로 화면엔 안 나온다.
                    if (patchAtLeast(slim.v, TL_MIN_PATCH)) try {
                        const tl = await riotApi.get(
                            `https://asia.api.riotgames.com/lol/match/v5/matches/${t.matchId}/timeline`
                        );
                        // ★★ `it` 는 **집계가 쓰는 구매만** 담는다 (2026-09-09, Atlas 512MB 가 차서).
                        //   목록을 못 받아 오면 keep 이 null 이라 예전처럼 전부 담는다 (안전한 쪽).
                        const st = toSlimTimeline(tl.data, tlKeepIds);
                        if (st) { slim.sk = st.sk; slim.it = st.it; statCounters.tl = (statCounters.tl || 0) + 1; }
                    } catch (e) {
                        if (e.response?.status === 429) throw e;   // 429 는 바깥에서 사이클을 끊는다
                        statCounters.tlFail = (statCounters.tlFail || 0) + 1;
                    }

                    await MatchStat.updateOne({ matchId: slim.matchId }, { $set: slim }, { upsert: true });
                    statCounters.save++;
                } else {
                    statCounters.skip++;   // 리메이크 / 다른 큐 / 형태가 이상한 판
                }
                statCounters.fetch++;
                await MatchSeen.updateOne({ _id: t._id }, { $set: { done: true } });

            } catch (err) {
                const status = err.response?.status;
                if (status === 429) {
                    console.warn('[Stat] 429 — detail 이번 사이클 중단');
                    break;
                }
                if (status === 404) {
                    // 없는 경기는 다시 시도해도 소용없다
                    await MatchSeen.updateOne({ _id: t._id }, { $set: { done: true } });
                } else {
                    console.error(`[Stat] detail 실패 ${t.matchId}: ${status || err.message}`);
                }
            }
            await sleep(1200);
        }
    } catch (e) {
        console.error('[Stat] 수집 오류:', e.message);
    } finally {
        isFetchingStats = false;
    }
}

// ==========================================
// ③ 집계 — 슬림 경기를 챔피언별 통계로 (라이엇 호출 0회, DB 안에서만 돈다)
//
//   ★ 증분이 아니라 scope 단위 **전체 재계산**이다. 증분은 중복 반영·누락 버그가
//     나기 쉬운데, 일별은 하루치(3~4천 건)라 가볍고 패치별도 2주치뿐이다.
// ==========================================
// ★★ 인원 밴드(8-10 / 5-7)를 폐지했다 (2026-08-21). 수집이 이미 **마스터+ 5명 이상**
//   (`STAT_MIN_K`)인 판만 담으므로 그게 곧 기준이고, 쪼개 봐야 칸이 절반씩 얇아지기만 했다.
//   `kb` 필드는 남겨 두되 값이 항상 'all' 이다 — 스키마·인덱스·박제 파일 자리를 그대로 두려는 것이다.
//   ★ 옛 '5-7'/'8-10' 줄은 champstats 는 통째로 갈아 끼우니 저절로 사라지는데,
//     statscopes 는 upsert 라 남는다. 아래에서 따로 지운다 — 안 지우면 **분모가 두 배**가 된다.
const K_BAND_ALL = 'all';
const DAILY_SCOPE_DAYS = 7;        // 최근 며칠치 일별 집계를 **다시 계산**할지 (원본이 온전한 폭만)
// ★ 보관은 따로 더 길다 (2026-09-01, 패치 영향 페이지). 일별 줄을 42일치 남겨야
//   "이번 패치 + 직전 패치" 그래프가 그려진다 (하루 ~730행 · 166B 라 42일 ≈ 10MB, 실측).
//   ★★ 재계산 창(7일)을 늘리면 안 된다 — 원본(matchstats)은 얼어붙은 패치 삭제·TTL 로
//   사라지므로, 원본이 빠진 날짜를 다시 계산하면 멀쩡한 일별 줄이 쪼그라든 값으로 덮인다
//   ("916판 → 12판" 과 같은 모양). 오래된 날짜는 **건드리지 않고 남겨만** 둔다.
const DAILY_KEEP_DAYS = 42;        // 일별 집계를 며칠치 보관할지 (현재 + 직전 패치를 덮는 폭)
const PATCH_FREEZE_DAYS = 3;       // 최신이 아닌 패치의 마지막 경기가 이만큼 지나면 재집계를 멈춘다 (2026-08-27)
let frozenLoggedKey = '';          // 얼어붙은 패치 목록 로그를 바뀔 때만 찍으려고

// 한국시간 기준 날짜 문자열. 경기 시각(t)이 UTC epoch 라 그냥 자르면 하루가 밀린다.
// (한국시간 날짜 헬퍼는 위 수집 절의 kstDay 를 그대로 쓴다)

async function buildOneScope(scopeKey, matchCond) {
    const rows = await MatchStat.aggregate([
        { $match: matchCond },
        { $addFields: { kb: K_BAND_ALL } },
        {
            $facet: {
                // 참가자를 펼쳐 챔피언 x 라인으로 센다
                picks: [
                    { $unwind: '$p' },
                    {
                        $group: {
                            _id: { kb: '$kb', c: { $arrayElemAt: ['$p', 0] }, pos: { $arrayElemAt: ['$p', 1] } },
                            games: { $sum: 1 },
                            wins: { $sum: { $arrayElemAt: ['$p', 2] } },
                            kills: { $sum: { $arrayElemAt: ['$p', 4] } },
                            deaths: { $sum: { $arrayElemAt: ['$p', 5] } },
                            assists: { $sum: { $arrayElemAt: ['$p', 6] } }
                        }
                    }
                ],
                // ★★ 롤 솔랭은 **양 팀이 같은 챔피언을 밴할 수 있다** — 실측 685판 중
                //   59.3% 에서 실제로 일어난다. 그래서 세는 방법이 두 가지고 뜻이 다르다:
                //     bans     = 밴 슬롯을 몇 개 먹었나 (양 팀이 밴하면 2)  ← 지금 화면 기본값
                //     banGames = 몇 판에서 밴됐나       (양 팀이 밴해도 1)  ← 흔히 말하는 "밴률"
                //   카밀 실측이 612회(89.3%) vs 480판(70.1%) 로 19%p 차이가 난다.
                //   ★ bans 를 쓰면 **픽률 + 밴률이 100%를 넘을 수 있다**. 버그가 아니라
                //     정의상 그렇다 (밴 슬롯은 판당 10개라 합계가 1000%까지 가능하다).
                //     둘 다 담아 두는 건 나중에 화면에서 고르기 위해서다.
                bans: [
                    { $unwind: '$b' },
                    { $group: { _id: { kb: '$kb', c: '$b' }, bans: { $sum: 1 } } }
                ],
                banGames: [
                    { $addFields: { b: { $setUnion: ['$b', []] } } },
                    { $unwind: '$b' },
                    { $group: { _id: { kb: '$kb', c: '$b' }, n: { $sum: 1 } } }
                ],
                totals: [{ $group: { _id: '$kb', games: { $sum: 1 } } }]
            }
        }
    ]).allowDiskUse(true);

    const f = rows[0] || { picks: [], bans: [], banGames: [], totals: [] };
    if (!f.totals.length) return 0;

    const agg = new Map();
    const put = (kb, c, pos, add) => {
        const key = `${kb}|${c}|${pos}`;
        let cur = agg.get(key);
        if (!cur) agg.set(key, cur = {
            scope: scopeKey, kb, champ: c, pos,
            games: 0, wins: 0, bans: 0, banGames: 0, kills: 0, deaths: 0, assists: 0
        });
        for (const k in add) cur[k] += add[k];
    };

    f.picks.forEach(r => {
        const { kb, c } = r._id;
        if (c == null) return;
        const pos = r._id.pos ?? -1;
        const add = { games: r.games, wins: r.wins, kills: r.kills, deaths: r.deaths, assists: r.assists };
        // ★ pos 가 -1(라인 판정 실패)이면 합계에만 넣는다. 둘 다 넣으면 이중 계산이다.
        if (pos >= 0) put(kb, c, pos, add);
        put(kb, c, -1, add);
    });
    // ★ 밴은 라인 개념이 없으므로 pos: -1 줄에만 얹는다.
    f.bans.forEach(r => { if (r._id.c != null) put(r._id.kb, r._id.c, -1, { bans: r.bans }); });
    f.banGames.forEach(r => { if (r._id.c != null) put(r._id.kb, r._id.c, -1, { banGames: r.n }); });

    // ★★ 세대 교체 (2026-08-31): 예전엔 `deleteMany → insertMany` 라 도는 동안 컬렉션이 비어서
    //   그 순간 조회가 "표본을 모으는 중" 을 받았다 (배포 5번 몰아서 한 날 사용자가 실제로 걸렸다).
    //   지금은 **새 세대를 넣고 → statscopes 의 딱지(gen)를 바꾸고 → 옛 세대를 지운다.**
    //   조회는 딱지가 가리키는 세대만 읽으므로 재집계 중에도 항상 완성된 한 벌을 본다.
    //   재계산마다 통째로 갈아 끼우는 건 그대로다 — $set 으로 덮으면 이번에 안 나온 챔피언 줄이
    //   옛 숫자를 그대로 들고 남기 때문이다. 대가는 재집계 몇 분 동안 그 scope 만 두 벌인 것.
    const docs = [...agg.values()];
    const gen = Date.now();
    docs.forEach(d => { d.g = gen; });
    if (docs.length) await ChampStat.insertMany(docs, { ordered: false });

    await StatScope.bulkWrite(f.totals.map(t => ({
        updateOne: {
            filter: { scope: scopeKey, kb: t._id },
            update: { $set: { games: t.games, updatedAt: new Date(), gen } },
            upsert: true
        }
    })));
    // ★ 밴드 폐지 전에 만들어진 줄을 지운다. 화면이 statscopes 를 **더해서** 분모로 쓰므로
    //   남겨 두면 판수가 두 배로 보인다.
    await StatScope.deleteMany({ scope: scopeKey, kb: { $ne: K_BAND_ALL } });
    // ★ 딱지를 바꾼 뒤에야 옛 세대를 지운다 ($ne 는 g 가 없는 옛 문서도 잡는다)
    await ChampStat.deleteMany({ scope: scopeKey, g: { $ne: gen } });

    return f.totals.reduce((a, t) => a + t.games, 0);
}

// ★ 조합별로 top 몇 개까지 남길지. 룬 페이지는 조합 가짓수가 커서(주 4 x 3 x 3 x 3 x
//   보조 계열 4 x 조합) 판당 새 조합이 나오다시피 한다 — 자르지 않으면 1판짜리 줄이
//   컬렉션을 뒤덮는다. 화면은 어차피 top 3 만 쓰므로 12면 넉넉하다.
const BUILD_TOP_N = 12;

// ★★ 최종 6칸에 남는 소모품은 뺀다 (2026-08-21). 실측(19,737판 x 10명 = 118만 칸):
//   **제어 와드 8.9% · 충전형 물약 8.7%** 로 둘이 전체 아이템 상위 10위 안에 든다.
//   안 빼면 "이 챔피언의 최종 아이템 1위 = 제어 와드" 가 된다.
//   ★ 장신구는 뺄 필요가 없다 — 6번째 칸(item6)이라 슬림 문서에 애초에 안 담긴다.
const ITEM_CONSUMABLES = [
    2003,  // 체력 물약
    2010,  // 비스킷
    2031,  // 충전형 물약
    2033,  // 부패 물약
    2055,  // 제어 와드
    2138, 2139, 2140,   // 영약 3종
    2150, 2151, 2152    // 강화 영약 3종
];

// ★★ 타임라인 집계 — 슬림 문서의 `sk`(스킬 순서)·`it`(구매) 에서 센다 (2026-08-26 신설, 같은 날 밤 확장).
//   같은 컬렉션(champbuilds)에 type 만 다르게 담는다. 화면(챔피언 통계 상세 페이지)이 lolalytics 와
//   같은 자리(Skill Priority · Skill Order · Starting · Early · Sets · Boots · Item 1~6)를 그린다.
//
//   ★★ **16.17 패치부터만 센다** (`TL_MIN_PATCH`, 사용자 지시). 16.16 은 아이템·스킬 로그 없이 간다 —
//     오늘 낮에 켠 타임라인 수집이 버전을 안 가려서 16.16 판 1,032개에 로그가 들어갔지만, 집계도 수집도
//     16.17 미만은 건너뛴다 (수집 쪽은 fetchMatchStats 의 `patchAtLeast` 가드). 화면은 `tlall` 줄이 없으면
//     그 칸들을 통째로 안 그린다.
//   ★ 한 판의 `sk[i]`·`it` 의 참가자 번호 i 는 `p[i]` 와 같은 사람이다 (둘 다 participantId-1 순서).
//
//   | type        | key                                  | 뜻 |
//   |-------------|--------------------------------------|----|
//   | skillord    | 스킬 순서 (Q1 W2 E3 R4) **15레벨까지**   | Skill Order 격자. 18까지 담으면 길이가 판마다 달라 조합이 더 잘게 갈린다 |
//   | skillord6/10| 같은 것을 6·10레벨까지                  | Skill Priority 표의 Level 6+/10+ 탭 |
//   | skillpri    | 선마 순서 3개 (Q/W/E)                  | "5번째 포인트를 찍은 레벨" 이 빠른 순, 같으면 포인트 많은 순. 9포인트 미만 판은 안 센다 |
//   | start       | 시작 아이템 (90초 안 구매, id 정렬)      | 물약·와드는 수집 때 이미 뺐다 (TL_SKIP_ITEMS) — 도란검만 남는다 |
//   | early       | 초반 아이템 (90초~10분 구매, 낱개)        | Early Items. 시작템은 뺀다 |
//   | earlyset    | 초반 아이템 세트 (같은 구간, id 정렬)     | Early Item Sets |
//   | boots       | 처음 산 2단계 이상 장화 (낱개)            | Boots |
//   | core        | 완성 아이템 첫 3개 (구매 순서)            | Core Build. 완성 = 아래 loadCompletedItems |
//   | set2/4/5    | 완성 아이템 첫 2·4·5개 (구매 순서)        | Sets (3개는 core) |
//   | item1~6     | n번째 완성 아이템 (낱개)                 | Item 1~6 |
//   | tlall       | []                                   | 타임라인 있는 판의 참가자 수 — 위 전부의 픽률 분모 |
//
//   ★ 1판짜리 조합은 저장 단계에서 뺀다 (`$match games >= 2`, 조합 type) — 조합 가짓수가 룬 페이지보다도
//     많아서 1판 꼬리가 컬렉션을 덮는다. 낱개 type(skillpri·item1~6·boots·early)은 가짓수가 적어 그대로 둔다.
const TL_TYPES = ['skillord', 'skillpri', 'start', 'early', 'earlyset', 'boots',
    'core', 'set2', 'set4', 'set5', 'item1', 'item2', 'item3', 'item4', 'item5', 'item6',
    'skilllv', 'skillord11'];   // ★ 새 type 은 맨 뒤에 (박제 TYPE_LIST 와 자리를 맞춘다)
// ★ skillord6·skillord10 은 2026-09-09 에 화면에서 빠져 집계도 멈췄다 — 박제 TYPE_LIST 의 자리는 그대로 둔다 (자리 번호가 밀리면 안 된다)
const TL_MIN_PATCH = [16, 17];    // 이 패치부터 타임라인을 받고·센다
const TL_START_SEC = 90;          // 이 초 안에 산 것이 시작 아이템
const TL_EARLY_SEC = 600;         // 이 초 안(시작 구간 뒤)에 산 것이 초반 아이템
const TL_SKILL_ORDER_LEVELS = 16; // 스킬 순서 조합 키 길이 (2026-09-09: 15 → 16. R 셋째 포인트가 16레벨이다)
const TL_COMPLETE_GOLD = 1000;    // 완성 아이템 하한 (도란 450 · 1단계 장화 300 은 밑, 2단계 장화 1000~ 은 위)

// "16.16" 같은 게임 버전 문자열이 [16, 17] 이상인가. 문자열 비교는 안 된다 ("16.9" > "16.17")
function patchAtLeast(v, min) {
    const [a, b] = String(v || '').split('.').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return a > min[0] || (a === min[0] && b >= min[1]);
}

// ★★ "완성 아이템" 목록은 DD item.json 에서 만든다 (버전마다 한 번, 메모리 캐시).
//   규칙: 협곡(maps 11) · 구매 가능 · 소모품 아님 · 1000G 이상 · **더 조합되는 곳이 없다**.
//   ★ `into` 를 그대로 보면 안 된다 — 삼위일체 같은 전설급이 오른 장인 아이템·아레나 사본으로
//     `into` 가 있을 수 있고, **2단계 장화는 상위 장화(건메탈 군화 등)로 조합돼 `into` 가 있다.**
//     그래서 `into` 는 "협곡에서 살 수 있는 것" 만 세고, 장화(tags Boots)는 into 가 있어도 완성으로 친다.
//   실측(16.17.1): 153개. 삼위일체·판금 장화·거대한 히드라·건메탈 군화 포함, 도란검·장화·서폿 퀘스트템 제외.
//   ★ 장화 목록(`boots`)도 같이 돌려준다 — Boots 줄이 "처음 산 2단계 이상 장화" 를 세는 데 쓴다.
let completedItemCache = { ver: null, data: null };
async function loadCompletedItems() {
    if (completedItemCache.ver === currentVersion && completedItemCache.data) return completedItemCache.data;
    const res = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${currentVersion}/data/ko_KR/item.json`, { timeout: 20000 });
    const data = res.data?.data || {};
    const realInto = it => (it.into || []).filter(x => {
        const t = data[x];
        return t && t.maps?.['11'] && t.gold?.purchasable && !t.requiredAlly;
    });
    const complete = [], boots = [];
    for (const [id, it] of Object.entries(data)) {
        const n = Number(id);
        if (!it.maps?.['11'] || !it.gold?.purchasable || it.requiredAlly) continue;
        if (ITEM_CONSUMABLES.includes(n) || (it.gold.total || 0) < TL_COMPLETE_GOLD) continue;
        const isBoots = (it.tags || []).includes('Boots');
        if (realInto(it).length && !isBoots) continue;
        complete.push(n);
        if (isBoots) boots.push(n);
    }
    completedItemCache = { ver: currentVersion, data: { complete, boots } };
    console.log(`[Stat] 완성 아이템 목록 ${complete.length}개 · 장화 ${boots.length}개 (DD ${currentVersion})`);
    return completedItemCache.data;
}

// 타임라인 갈래 — buildOneBuildScope 의 facet 과 같은 모양(`_id: {c, pos, k}, games, wins`)으로 돌려준다.
//   ★ `opts.pick`({c,pos}) 을 주면 **참가자 한 명만** 남긴다 — vs 비교 페이지가 "그 상대와 만난 판의
//     나 한 명" 으로 좁혀 **같은 facet 을 그대로 태우려고** 뚫은 자리다 (2026-09-02).
async function buildTimelineFacet(matchCond, opts = {}) {
    const { complete, boots } = await loadCompletedItems();
    const at = (arr, i) => ({ $arrayElemAt: [arr, i] });
    // 스킬 L 의 포인트 수(n)와 5번째 포인트를 찍은 자리(at, 없으면 99)
    const maxAt = L => ({ $reduce: {
        input: { $range: [0, { $strLenCP: '$sk' }] }, initialValue: { n: 0, at: 99 },
        in: { $cond: [
            { $eq: [{ $substrCP: ['$sk', '$$this', 1] }, L] },
            { n: { $add: ['$$value.n', 1] }, at: { $cond: [{ $eq: ['$$value.n', 4] }, '$$this', '$$value.at'] } },
            '$$value'
        ] }
    } });
    const grp = k => ({ $group: { _id: { c: '$c', pos: '$pos', k }, games: { $sum: 1 }, wins: { $sum: '$w' } } });
    const min2 = { $match: { games: { $gte: 2 } } };
    // ★ N코어 = **신발을 뺀** 완성 아이템의 N번째 (2026-09-09). 신발은 자기 줄이 따로 있다
    const nth = i => [{ $match: { [`compnb.${i}`]: { $exists: true } } }, grp([at('$compnb', i)])];
    const firstN = n => [{ $match: { [`comp.${n - 1}`]: { $exists: true } } }, grp({ $slice: ['$comp', n] }), min2];
    const ordTo = n => [{ $match: { [`ord.${n - 1}`]: { $exists: true } } }, grp({ $slice: ['$ord', n] }), min2];
    const ids = arr => ({ $map: { input: arr, as: 'b', in: '$$b.id' } });
    const inWindow = (lo, hi) => ({ $filter: { input: '$buys', as: 'b', cond: { $and: [{ $gt: ['$$b.t', lo] }, { $lte: ['$$b.t', hi] }] } } });

    // ★★★ `$facet` 은 **결과 문서 하나가 16MB… 가 아니라 100MB** 를 넘으면 통째로 실패한다
    //   (2026-09-09 실제로 걸렸다: `document constructed by $facet is 104,858,026 bytes`).
    //   갈래 중 **아이템 조합을 묶는 것들**(시작템 세트·초반템 세트·코어 2/3/4/5개)이 판이 쌓일수록
    //   서로 다른 조합 수가 폭발해서, 어느 날 갑자기 한도를 넘는다. 한 번 넘으면 그 패치 집계가
    //   통째로 안 돌아 **champbuilds 가 비어 버린다.**
    //   ★ 그래서 **두 번에 나눠 돌린다** — 무거운 「조합」 갈래와 가벼운 「낱개」 갈래.
    //     앞 단계(참가자 펼치기)를 두 번 타는 대신 한도에 안 걸린다. 예전엔 다섯 번이었으니
    //     두 번은 그 절충안이다 (M0 무료 티어라 되도록 적게 돌린다).
    //   ★ 나중에 또 넘치면 **셋으로 쪼개면 된다** — `heavy` 를 반으로 가르는 게 제일 쉽다.
    const prefix = [
        { $match: { ...matchCond, sk: { $exists: true } } },
        { $project: { p: 1, sk: 1, it: { $ifNull: ['$it', []] } } },
        // 참가자 10명을 한 줄씩으로. `it` 는 [초, 참가자, 아이템] 이 평평하게 이어진 배열이라 3칸씩 끊는다.
        { $project: { rows: { $map: { input: { $range: [0, 10] }, as: 'i', in: {
            c: at(at('$p', '$$i'), 0), pos: at(at('$p', '$$i'), 1), w: at(at('$p', '$$i'), 2),
            sk: { $ifNull: [at('$sk', '$$i'), ''] },
            buys: { $map: {
                input: { $filter: { input: { $range: [0, { $size: '$it' }, 3] }, as: 'j', cond: { $eq: [at('$it', { $add: ['$$j', 1] }), '$$i'] } } },
                as: 'j', in: { t: at('$it', '$$j'), id: at('$it', { $add: ['$$j', 2] }) }
            } }
        } } } } },
        { $unwind: '$rows' }, { $replaceRoot: { newRoot: '$rows' } },
        ...(opts.pick ? [{ $match: { c: opts.pick.c, pos: opts.pick.pos } }] : []),
        { $project: {
            c: 1, pos: 1, w: 1,
            ord: { $slice: [
                { $map: { input: { $range: [0, { $strLenCP: '$sk' }] }, as: 'i', in: { $add: [{ $indexOfCP: ['QWER', { $substrCP: ['$sk', '$$i', 1] }] }, 1] } } },
                TL_SKILL_ORDER_LEVELS
            ] },
            pri: { $map: { input: { $sortArray: { input: [
                { $mergeObjects: [{ l: 1 }, maxAt('Q')] }, { $mergeObjects: [{ l: 2 }, maxAt('W')] }, { $mergeObjects: [{ l: 3 }, maxAt('E')] }
            ], sortBy: { at: 1, n: -1, l: 1 } } }, as: 's', in: '$$s.l' } },
            start: { $sortArray: { input: ids(inWindow(-1, TL_START_SEC)), sortBy: 1 } },
            early: ids(inWindow(TL_START_SEC, TL_EARLY_SEC)),
            comp: ids({ $filter: { input: '$buys', as: 'b', cond: { $in: ['$$b.id', complete] } } }),
            // ★★ 코어 순서(1~6코어)는 **신발을 빼고** 센다 (2026-09-09 사용자 요청).
            //   신발은 바로 위에 자기 줄(`boots`)이 따로 있는데 코어에도 끼면 "1코어 = 신발" 인
            //   챔피언이 생겨서 두 줄이 같은 말을 한다. 세트(`core`·`set2/4/5`)는 **그대로 둔다** —
            //   거긴 "그 판에 뭘 갖췄나" 라 신발도 장비의 하나다.
            compnb: ids({ $filter: { input: '$buys', as: 'b', cond: {
                $and: [{ $in: ['$$b.id', complete] }, { $not: [{ $in: ['$$b.id', boots] }] }]
            } } }),
            boots: { $slice: [ids({ $filter: { input: '$buys', as: 'b', cond: { $in: ['$$b.id', boots] } } }), 1] }
        } }
    ];

    // 무거운 쪽 — 조합(여러 아이템을 한 묶음으로 세는 것). 서로 다른 조합 수가 판수와 함께 는다
    const heavy = {
        start: [{ $match: { 'start.0': { $exists: true } } }, grp('$start'), min2],
        earlyset: [{ $match: { 'early.0': { $exists: true } } }, grp({ $sortArray: { input: '$early', sortBy: 1 } }), min2],
        core: firstN(3), set2: firstN(2), set4: firstN(4), set5: firstN(5)
    };
    // 가벼운 쪽 — 낱개(아이템 하나·스킬 순서). 가짓수가 아이템·스킬 수로 묶여 있다
    const light = {
        skillord: ordTo(TL_SKILL_ORDER_LEVELS), skillord11: ordTo(11),
        skillpri: [{ $match: { 'ord.8': { $exists: true } } }, grp('$pri')],
        // ★★ 레벨별 스킬 (2026-09-09 사용자 요청) — 「1레벨에 뭘 찍었나」를 레벨마다 따로 센다.
        //   key 는 `[레벨, 슬롯]` 이고 슬롯은 1=Q 2=W 3=E 4=R (ord 와 같은 번호).
        //   ★ 순서 조합(`skillord*`)에서 되짚으면 안 된다 — 그쪽은 칸마다 상위 N개로 잘려 있어서
        //     꼬리가 빠진 채로 합해진다 (아이템 채택률에서 겪은 `ITEM_TOP_N` 함정과 같은 부류).
        //   ★ `ord` 는 15레벨까지라 이 줄도 15레벨까지다 (TL_SKILL_ORDER_LEVELS).
        //   ★ 못 읽은 칸은 0 이라 버린다 (`QWER` 밖 글자면 indexOfCP 가 -1 → +1 = 0).
        skilllv: [
            { $unwind: { path: '$ord', includeArrayIndex: 'lv' } },
            { $match: { ord: { $gt: 0 } } },
            { $group: { _id: { c: '$c', pos: '$pos', k: [{ $add: ['$lv', 1] }, '$ord'] }, games: { $sum: 1 }, wins: { $sum: '$w' } } }
        ],
        early: [{ $unwind: '$early' }, grp(['$early'])],
        boots: [{ $match: { 'boots.0': { $exists: true } } }, grp('$boots')],
        item1: nth(0), item2: nth(1), item3: nth(2), item4: nth(3), item5: nth(4), item6: nth(5),
        // 타임라인이 있는 판의 참가자 수 — 위 type 들의 픽률 분모 (화면은 `tlall` 로 받는다)
        tlall: [grp([])]
    };

    const runFacet = async (facets) => {
        const r = await MatchStat.aggregate([...prefix, { $facet: facets }]).allowDiskUse(true);
        return r[0] || {};
    };
    const [a, b] = [await runFacet(light), await runFacet(heavy)];
    return { ...a, ...b };
}

// 챔피언별 룬·주문 빌드 집계. **패치 scope 에만 부른다** (champBuildSchema 주석 참고)
//   ★ `opts` 는 vs 비교 페이지가 쓴다 (2026-09-02) — `pick`({c,pos})으로 참가자 한 명만 남기고,
//     `returnDocs` 면 저장하지 않고 줄을 그대로 돌려준다. **안 넘기면 예전과 똑같이 돈다.**
async function buildOneBuildScope(scopeKey, matchCond, opts = {}) {
    const P = i => ({ $arrayElemAt: ['$p', i] });

    // ★ $unwind 를 한 번만 하고 $facet 으로 네 갈래를 낸다. 갈래마다 따로 aggregate 를
    //   돌리면 110만 행짜리 unwind 를 다섯 번 반복하게 된다 (M0 무료 티어라 뼈아프다).
    const rows = await MatchStat.aggregate([
        { $match: matchCond },
        { $project: { p: 1 } },
        { $unwind: '$p' },
        // ★ vs 비교는 여기서 한 명으로 좁힌다 (그 뒤 facet 은 통째로 같다)
        ...(opts.pick ? [{ $match: { $expr: { $and: [{ $eq: [P(0), opts.pick.c] }, { $eq: [P(1), opts.pick.pos] }] } } }] : []),
        {
            $project: {
                c: P(0), w: P(2),
                // ★ 라인은 슬림 문서 1번 칸에 **처음부터 들어 있었다** (2026-08-18).
                //   수집을 바꾼 게 아니라 세는 키에 넣기만 한 것이라 지난 원본도 소급된다.
                pos: P(1),
                // ★★ 보조 룬 2개(23·24번 칸)는 **반드시 정렬해야 한다** (2026-08-16).
                //   라이엇이 주는 순서가 일정하지 않아서 **같은 룬 페이지가 두 조합으로
                //   갈렸다** — 리 신의 "영감 · 우주적 통찰력 · 마법의 신발" 81판과
                //   "영감 · 마법의 신발 · 우주적 통찰력" 62판이 실제로는 143판 한 조합이다.
                //   전수로 재니 조합 가짓수가 3021 → 2559 로 **15% 가 중복**이었다.
                //   ★ 주 룬 3개(19~21)는 정렬하면 안 되는 게 아니라 **할 필요가 없다** —
                //     라이엇이 이미 슬롯 순서로 준다 (정렬 전후 가짓수가 3021 로 같았다).
                //     그대로 두면 화면에서 인게임과 같은 순서로 그려진다.
                //   ★ 정렬한 보조 2개는 **id 순서라 슬롯 순서와 다르다** (어긋나는 쌍 139개).
                //     화면이 perk_data.js 의 slots 로 되돌려 그린다.
                rune: {
                    $concatArrays: [
                        [P(17), P(18), P(19), P(20), P(21), P(22)],
                        { $sortArray: { input: [P(23), P(24)], sortBy: 1 } }
                    ]
                },
                keystone: [P(17), P(18)],
                shard: [P(25), P(26), P(27)],
                // ★ 룬 낱개 (2026-08-26 밤 신설) — 룬 6개 + 파편 3개를 하나씩 센다 (최종 아이템을 낱개로 세는 것과 같다).
                //   lolalytics Runes 표(룬마다 픽률·승률)의 자료. 조합(`rune`) 상위 12개에서 되짚으면 잘린 꼬리 때문에 틀린다.
                perk: [P(18), P(19), P(20), P(21), P(23), P(24)],
                // ★★ 파편은 **줄 번호와 같이** 센다 (2026-08-27, 사용자 지적 "적응형 픽률 뻥튀기"). 적응형(5008)은 1·2줄, 체력(5001)은
                //   2·3줄에 있어 id 로만 세면 한 사람이 두 번 더해져 픽률이 100% 를 넘었다 (카밀 139%). key 가 [id, 줄] 이다
                shardslot: [{ id: P(25), r: 0 }, { id: P(26), r: 1 }, { id: P(27), r: 2 }],
                // 최종 아이템 6칸 (9~14). 아래 facet 에서 한 번 더 펼쳐 낱개로 센다.
                item: [P(9), P(10), P(11), P(12), P(13), P(14)],
                // 같은 이유로 주문도 작은 id 를 앞으로. 점멸/점화와 점화/점멸이 갈리면
                // 표본이 반이 된다.
                spell: { $cond: [{ $lt: [P(15), P(16)] }, [P(15), P(16)], [P(16), P(15)]] }
            }
        },
        {
            $facet: {
                rune: [{ $group: { _id: { c: '$c', pos: '$pos', k: '$rune' }, games: { $sum: 1 }, wins: { $sum: '$w' } } }],
                keystone: [{ $group: { _id: { c: '$c', pos: '$pos', k: '$keystone' }, games: { $sum: 1 }, wins: { $sum: '$w' } } }],
                spell: [{ $group: { _id: { c: '$c', pos: '$pos', k: '$spell' }, games: { $sum: 1 }, wins: { $sum: '$w' } } }],
                shard: [{ $group: { _id: { c: '$c', pos: '$pos', k: '$shard' }, games: { $sum: 1 }, wins: { $sum: '$w' } } }],
                // ★ 아이템은 **낱개**로 센다 (조합이 아니다). 6칸을 펼쳐서 하나씩 세므로
                //   한 사람이 6줄에 기여하고, 그래서 픽률은 "이 챔피언 판의 몇 %에서 이 아이템이
                //   최종까지 남았나" 가 된다 — 합이 100%를 넘는 게 정상이다.
                item: [
                    { $unwind: '$item' },
                    { $match: { item: { $gt: 0, $nin: ITEM_CONSUMABLES } } },
                    { $group: { _id: { c: '$c', pos: '$pos', k: ['$item'] }, games: { $sum: 1 }, wins: { $sum: '$w' } } }
                ],
                perk: [
                    { $unwind: '$perk' },
                    { $match: { perk: { $gt: 0 } } },
                    { $group: { _id: { c: '$c', pos: '$pos', k: ['$perk'] }, games: { $sum: 1 }, wins: { $sum: '$w' } } }
                ],
                shardslot: [
                    { $unwind: '$shardslot' },
                    { $match: { 'shardslot.id': { $gt: 0 } } },
                    { $group: { _id: { c: '$c', pos: '$pos', k: ['$shardslot.id', '$shardslot.r'] }, games: { $sum: 1 }, wins: { $sum: '$w' } } }
                ],
                // ★ 챔피언 총 판수. top N 으로 자르고 나면 줄을 더해도 총합이 안 나오므로
                //   분모를 따로 담아야 한다. champstats 에서 가져오면 될 것 같지만
                //   거기는 kb 로 쪼개져 있고 화면의 밴드 필터에 따라 값이 달라진다.
                all: [{ $group: { _id: { c: '$c', pos: '$pos', k: [] }, games: { $sum: 1 }, wins: { $sum: '$w' } } }]
            }
        }
    ]).allowDiskUse(true);

    const f = rows[0];
    if (!f) return 0;
    // 파편(줄 번호 포함, key [id, 줄])도 같은 'perk' type 에 담는다 — 박제 TYPE_LIST 에 자리를 안 늘리려고
    f.perk = [...(f.perk || []), ...(f.shardslot || [])];

    // ★ 타임라인 갈래(스킬·시작템·코어)는 `sk` 가 있는 판만 세므로 따로 돈다 (위 buildTimelineFacet).
    //   실패해도 룬·아이템 집계는 살린다 — DD item.json 을 못 받는 날 빌드 전체가 비면 손해가 크다.
    //   ★★ 16.17 미만 패치는 아예 안 돈다 (`TL_MIN_PATCH`) — 16.16 은 아이템·스킬 로그 없이 간다 (사용자 지시)
    if (opts.timeline || (scopeKey.startsWith('p:') && patchAtLeast(scopeKey.slice(2), TL_MIN_PATCH))) {
        try {
            Object.assign(f, await buildTimelineFacet(matchCond, opts));
        } catch (e) {
            console.error(`[Stat] 타임라인 집계 실패 (${scopeKey}):`, e.message);
        }
    }

    const docs = [];
    for (const type of ['rune', 'keystone', 'spell', 'shard', 'item', 'perk', 'all', ...TL_TYPES, 'tlall']) {
        // ★ (챔피언 x 라인) 칸과 (챔피언 x 전체) 칸을 같이 만든다.
        //   top N 은 **칸마다 따로** 잘라야 한다 — 전체에서 자른 뒤 라인으로 나누면
        //   그 라인에서만 많이 쓰는 룬이 통째로 빠진다.
        const cells = new Map();          // `챔피언|라인` → Map(조합 → 줄)
        const put = (c, pos, key, games, wins) => {
            const ck = c + '|' + pos;
            if (!cells.has(ck)) cells.set(ck, new Map());
            const bucket = cells.get(ck);
            const kk = key.join(',');
            const cur = bucket.get(kk);
            if (cur) { cur.games += games; cur.wins += wins; }
            else bucket.set(kk, { scope: scopeKey, champ: c, pos, type, key, games, wins });
        };
        (f[type] || []).forEach(r => {
            const c = r._id.c;
            if (c == null) return;
            const pos = (r._id.pos == null || r._id.pos < 0) ? -1 : r._id.pos;
            const key = r._id.k || [];
            if (pos >= 0) put(c, pos, key, r.games, r.wins);   // 라인별 (판정 실패는 제외)
            put(c, -1, key, r.games, r.wins);                  // 라인 무관 전체 (전원)
        });
        // ★ perk 는 한 칸에 룬 60여 개 + 파편 9개가 전부 들어가야 표가 된다 — 안 자른다
        // ★★ 아이템도 안 자른다 (2026-09-01, `ITEM_TOP_N` 폐지). 챔피언당 상위 15개만 담았더니
        //   도감 채택률이 통째로 틀렸다 — 챔피언당 고유 아이템이 **중앙값 78개**라 15번째 줄의
        //   채택률이 9.5% 였고, 그 아래가 다 사라져서 합계 418.5%(실제 522.7%) · 챔피언 TOP5 는
        //   208개 중 108개만 맞았다. 상세 페이지의 "전체 아이템"(60칸)도 15개까지밖에 못 채웠다.
        //   ★ 대가는 item 줄 11,932 → 40,022 (+7.4MB). 낱개라 가짓수가 원래 적어서 감당된다.
        //   ★★ `skilllv` 도 안 자른다 (2026-09-09). 컷이 **칸(챔피언|라인) 단위**라 「레벨 × 스킬」을
        //     한 줄씩 세는 이 type 은 상위 12개만 남기면 **레벨마다 1등 하나씩 12레벨까지**만 남는다
        //     (실제로 그렇게 나왔다 — 리 신 1레벨에 E 만 있고 Q·W 가 사라졌다).
        //     레벨당 가짓수가 넷(QWER)뿐이라 안 잘라도 칸당 60줄이 상한이다.
        const topN = (type === 'all' || type === 'tlall' || type === 'perk' || type === 'item' || type === 'skilllv')
            ? Infinity : BUILD_TOP_N;
        cells.forEach(bucket => {
            const list = [...bucket.values()].sort((a, b) => b.games - a.games);
            docs.push(...list.slice(0, topN));
        });
    }

    // ★ vs 비교는 저장하지 않고 줄만 가져간다 (그 자리에서 한 번 쓰고 버리는 값이다)
    if (opts.returnDocs) return docs;

    // champstats 와 같은 세대 교체 (2026-08-31) — 넣고 → 딱지(genB) → 옛 세대 삭제.
    const gen = Date.now();
    docs.forEach(d => { d.g = gen; });
    if (docs.length) await ChampBuild.insertMany(docs, { ordered: false });
    await StatScope.updateMany({ scope: scopeKey }, { $set: { genB: gen } });
    await ChampBuild.deleteMany({ scope: scopeKey, g: { $ne: gen } });
    return docs.length;
}

// ★ 표본이 이보다 적은 칸은 **저장하지 않는다.** 실측(19,737판): 칸이 22,154개인데
//   5판 이상은 7,558개다. 1판짜리 칸이 컬렉션을 뒤덮는 걸 막는 장치이고,
//   원본(matchstats)이 살아 있는 동안은 이 값을 바꿔 다시 세울 수 있다.
const MATCHUP_MIN = 5;

// 라인 상성 집계. **패치 scope 에만 부른다** (하루치는 칸마다 한두 판이라 뜻이 없다)
async function buildOneMatchupScope(scopeKey, matchCond) {
    const at = (arr, i) => ({ $arrayElemAt: [arr, i] });
    const P = (i, j) => at(at('$p', i), j);

    // ★★ 한 판의 나 x 나머지 9명 (2026-08-26 밤). 예전엔 같은 라인 둘만 짝지었는데($group by {m, pos} → $size 2),
    //   lolalytics 처럼 적 5라인·아군 4라인을 다 보려면 9명 전부가 필요하다.
    //   ★ 라인 판정 실패(-1)한 사람은 짝을 지을 수 없어 뺀다 — 실측 197,370명 중 7명이라 손실이 없다.
    const rows = await MatchStat.aggregate([
        { $match: matchCond },
        { $project: { p: 1 } },
        { $project: { rows: { $map: { input: { $range: [0, 10] }, as: 'i', in: {
            c: P('$$i', 0), pos: P('$$i', 1), w: P('$$i', 2),
            o: { $map: {
                input: { $filter: { input: { $range: [0, 10] }, as: 'j', cond: { $ne: ['$$j', '$$i'] } } },
                as: 'j',
                in: { f: P('$$j', 0), fpos: P('$$j', 1), rel: { $cond: [{ $eq: [P('$$j', 3), P('$$i', 3)] }, 1, 0] } }
            } }
        } } } } },
        { $unwind: '$rows' }, { $unwind: '$rows.o' },
        { $match: { 'rows.pos': { $gte: 0 }, 'rows.o.fpos': { $gte: 0 } } },
        {
            $group: {
                _id: { pos: '$rows.pos', c: '$rows.c', f: '$rows.o.f', fpos: '$rows.o.fpos', rel: '$rows.o.rel' },
                games: { $sum: 1 },
                wins: { $sum: '$rows.w' }
            }
        },
        { $match: { games: { $gte: MATCHUP_MIN } } }
    ]).allowDiskUse(true);

    const docs = rows
        .filter(r => r._id.c > 0 && r._id.f > 0)
        .map(r => ({ scope: scopeKey, pos: r._id.pos, champ: r._id.c, foe: r._id.f, fpos: r._id.fpos, rel: r._id.rel, games: r.games, wins: r.wins }));

    // champstats·champbuilds 와 같은 세대 교체 (2026-08-31) — 넣고 → 딱지(genM) → 옛 세대 삭제.
    const gen = Date.now();
    docs.forEach(d => { d.g = gen; });
    if (docs.length) await ChampMatchup.insertMany(docs, { ordered: false });
    await StatScope.updateMany({ scope: scopeKey }, { $set: { genM: gen } });
    await ChampMatchup.deleteMany({ scope: scopeKey, g: { $ne: gen } });
    return docs.length;
}

// ★★★ 집계는 `deleteMany → insertMany` 라 **도는 동안 컬렉션이 반쯤 빈다.**
//   그 순간에 조회가 들어오면 부분 결과가 응답 캐시(10~30분)에 굳어서, 재집계가
//   몇십 초 만에 끝나도 **그 챔피언만 오래 "표본이 없습니다"** 가 된다.
//   2026-08-26 에 실제로 났다 — 서폿 카밀이 그랬고, DB 를 열어 보니 272줄 멀쩡한데
//   API 캐시만 36줄(rune 까지만 들어간 순간)을 들고 있었다.
//   ★ 그래서 사이클 끝에 통계 캐시를 통째로 비운다. 노출 창이 "재집계에 걸리는 시간" 으로 줄어든다.
//   ★ `/api/champion-stats` 는 캐시를 안 쓰므로 여기 없다 (부분 결과가 보여도 다음 요청에 낫는다).
//   ★ 통계 응답 캐시 접두사를 새로 만들면 여기에도 적을 것 — 'trend_' 가 빠져 있어서
//     재집계 뒤에도 챔피언 추이 그래프만 최대 10분 옛 값이었다 (2026-09-03 감사 M-8).
const STAT_CACHE_PREFIXES = ['builds_', 'matchups_', 'usage_', 'patchimpact_', 'duos_', 'lanetrend_', 'trend_', 'versusbuild_'];

function flushStatCaches() {
    const keys = myCache.keys().filter(k => STAT_CACHE_PREFIXES.some(p => k.startsWith(p)));
    if (keys.length) myCache.del(keys);
    return keys.length;
}

async function buildChampStats() {
    if (isBuildingStats) return;
    isBuildingStats = true;
    const started = Date.now();

    try {
        const scopes = [];

        // 패치별 — MatchStat 에 실제로 들어 있는 패치만
        // ★★ 닫힌 패치는 재집계하지 않는다 (2026-08-27). 원본(matchstats)이 TTL 로 **한 판씩**
        //   사라지는 동안 매시간 통째로 다시 계산하면 옛 패치 값이 조금씩 줄다가 마지막 몇 판짜리로
        //   얼어붙는다 ("916판" → "12판"). 예전엔 그 전에 사람이 박제(build_stats_archive.js)를
        //   돌리는 게 유일한 방어였다. 지금은 **최신 패치가 아니고 마지막 경기가 3일 넘게 지난
        //   패치**는 건너뛴다 — 그 시점엔 원본이 100% 살아 있어 값이 완전하고, 그 뒤 원본이
        //   사라져도 재계산이 안 도니 값이 안 변한다. 박제는 용량을 파일로 옮기는 선택 작업이 됐다.
        //   ★ 3일은 수집의 "그저께 잔량 따라잡기" 를 덮는 여유다.
        //   ★ 집계 규칙을 바꿔 옛 패치까지 다시 계산하고 싶으면 `STATS_UNFREEZE=1` — 단 그 패치
        //     원본이 TTL 안에 온전히 남아 있을 때만 (아니면 줄어든 값으로 덮어쓴다).
        const byPatch = await MatchStat.aggregate([
            { $match: { v: { $nin: [null, ''] } } },
            { $group: { _id: '$v', last: { $max: '$t' }, n: { $sum: 1 } } }
        ]);
        const verNum = v => v.split('.').map(Number);
        const newest = byPatch.map(p => p._id).sort((a, b) => {
            const [am, an] = verNum(a), [bm, bn] = verNum(b);
            return (bm - am) || (bn - an);
        })[0];
        const closedBefore = Math.floor(Date.now() / 1000) - PATCH_FREEZE_DAYS * 86400;
        const frozen = [];
        byPatch.forEach(p => {
            const v = p._id;
            if (v !== newest && p.last < closedBefore && process.env.STATS_UNFREEZE !== '1') { frozen.push(v); return; }
            scopes.push({ key: `p:${v}`, cond: { v } });
        });
        const frozenKey = frozen.sort().join(',');
        if (frozenKey && frozenKey !== frozenLoggedKey) {
            console.log(`[Stat] 닫힌 패치는 재집계하지 않는다: ${frozen.map(v => `p:${v}`).join(' · ')} (값이 그대로 얼어 있다)`);
            frozenLoggedKey = frozenKey;
        }
        // ★★ 얼어붙은 패치의 원본(matchstats)은 바로 지운다 (2026-08-27). 재집계를 안 하니 읽는 코드가
        //   없고(집계 말고는 matchstats 를 읽는 데가 없다), TTL 21일까지 들고 있으면 자리만 차지한다.
        //   창고에 남는 건 "현재 패치 + 3일" 뿐이 되어 원본 정착 380MB → 최고 310 · 평균 180MB.
        //   ★ 그 패치의 집계 행이 한 번은 만들어졌는지(statscopes 에 줄이 있는지) 보고 지운다 —
        //     집계 전에 지우면 그 패치가 통째로 빈다. STATS_UNFREEZE 로 다시 셀 길은 이때 사라진다.
        for (const v of frozen) {
            const hasRows = await StatScope.exists({ scope: `p:${v}` });
            if (!hasRows) { console.warn(`[Stat] p:${v} 는 집계 행이 없어 원본을 남긴다`); continue; }
            const r = await MatchStat.deleteMany({ v });
            if (r.deletedCount) console.log(`[Stat] 닫힌 패치 p:${v} 원본 ${r.deletedCount}판 삭제 (얼어붙은 집계는 그대로)`);
        }

        // 일별 — 최근 7일 (한국시간 기준)
        const now = Date.now();
        for (let i = 0; i < DAILY_SCOPE_DAYS; i++) {
            const day = kstDay(now - i * 86400000);
            const from = Math.floor(Date.parse(`${day}T00:00:00+09:00`) / 1000);
            scopes.push({ key: `d:${day}`, cond: { t: { $gte: from, $lt: from + 86400 } } });
        }

        let total = 0;
        let builds = 0;
        let matchups = 0;
        for (const s of scopes) {
            total += await buildOneScope(s.key, s.cond);
            // ★ 룬 빌드·상성은 패치 scope 에만 만든다. 하루치는 거의 전부 1판짜리다.
            if (s.key.startsWith('p:')) {
                builds += await buildOneBuildScope(s.key, s.cond);
                matchups += await buildOneMatchupScope(s.key, s.cond);
            }
        }

        // 원본이 사라진 패치의 빌드 집계는 그대로 얼려 둔다 (champstats 와 같은 규칙).
        // 여기서 지우는 건 일별 scope 뿐인데, 빌드는 애초에 일별을 안 만드니 할 일이 없다.

        // 기간이 지난 일별 집계는 지운다 (패치별은 남긴다).
        // ★ 한 객체에 같은 키를 두 번 쓰면 뒤엣것만 남으므로 연산자를 합쳐서 쓴다.
        // ★ 삭제 기준은 재계산 창(7일)이 아니라 보관 폭(DAILY_KEEP_DAYS)이다 (2026-09-01) —
        //   7~42일 사이의 일별 줄은 다시 계산하지 않고 그대로 남는다 (패치 영향 그래프 몫).
        const keep = [];
        for (let i = 0; i < DAILY_KEEP_DAYS; i++) keep.push(`d:${kstDay(now - i * 86400000)}`);
        await ChampStat.deleteMany({ scope: { $regex: '^d:', $nin: keep } });
        await StatScope.deleteMany({ scope: { $regex: '^d:', $nin: keep } });

        if (total > 0) {
            console.log(`[Stat] 집계 완료: scope ${scopes.length}개 / 연인원 ${total}판 / 빌드 ${builds}행 / 상성 ${matchups}행 / ${((Date.now() - started) / 1000).toFixed(1)}초`);
        }
    } catch (e) {
        console.error('[Stat] 집계 실패:', e.message);
    } finally {
        // ★ 실패해도 비운다 — 중간까지 갈아엎힌 상태로 끝났을 수 있다
        const dropped = flushStatCaches();
        if (dropped) console.log(`[Stat] 응답 캐시 ${dropped}개 비움`);
        isBuildingStats = false;
    }
}

// ==========================================
// 인덱스 보정 (2026-08-15 신설)
//
//   ★★ mongoose 가 스키마에 적은 인덱스를 실제로 만들어 주지 않고 있었다.
//     `.index()` 로 선언한 3개(429 폴백 조회용·자동완성용)가 DB 에 통째로 없었고,
//     새로 만든 TTL 두 개도 안 생겼다. **`unique: true` 로 붙은 것만 살아 있었다.**
//   ★★ 그리고 **이미 있는 TTL 은 `expires` 를 고쳐도 안 바뀐다.** 인덱스는 한번 만들어지면
//     정의가 고정되므로 `collMod` 로 값을 갈아야 한다. 스키마만 고치고 끝내면
//     "코드에는 7일이라고 적혀 있는데 실제로는 14일" 인 상태가 조용히 유지된다.
// ==========================================
async function ensureStatIndexes() {
    const want = [
        // TTL — 값이 다르면 collMod 로 갈아 끼운다
        // ★ 스키마의 `expires` 와 **같은 값이어야 한다** — 여기가 실제로 DB 에 반영하는 자리다
        { col: 'matchcaches', key: { createdAt: 1 }, ttl: 3 * 86400 },
        { col: 'matchstats', key: { createdAt: 1 }, ttl: 21 * 86400 },
        { col: 'matchseens', key: { createdAt: 1 }, ttl: 3 * 86400 },
        // 조회용 — 선언만 돼 있고 실제로 없던 것들
        { col: 'matchcaches', key: { 'detail.metadata.participants': 1, 'detail.info.gameEndTimestamp': -1 } },
        { col: 'summonercaches', key: { displayName: 1 } },
        { col: 'summonercaches', key: { namePartLower: 1, tierScore: -1 } },
        // 통계 수집·집계용
        { col: 'matchseens', key: { done: 1, cnt: -1 } },
        { col: 'champbuilds', key: { scope: 1, champ: 1 } },
        { col: 'champmatchups', key: { scope: 1, champ: 1 } },
        // 신화상점.
        //   ★★ `date` 의 unique 도 여기 적어야 한다. 스키마에 `unique: true` 를 써 놨지만
        //     **실제로 안 만들어졌다** (2026-08-16 실측: `_id_` 와 아래 복합 인덱스뿐이었다).
        //     이게 없으면 같은 날짜가 동시에 두 번 들어올 때 문서가 둘 생기고
        //     POST 의 11000 처리도 영영 안 탄다 — 하루 한 번짜리라 드물지만 막을 수 있는 건 막는다.
        //     ★ 2026-08-17에 `date` 단독에서 `date + section` 으로 바뀌었다 — 같은 날짜에
        //       일일과 주간이 따로 들어와야 하기 때문이다. 옛 인덱스는 아래 legacy 가 지운다.
        { col: 'mythicshops', key: { date: 1, section: 1 }, unique: true },
        { col: 'mythicshops', key: { 'items.catalogId': 1, date: -1 } },   // "마지막 등장일" 조회용
        { col: 'mythicshops', key: { section: 1, date: -1 } },             // 구획별 최신 조회용
        // 날짜별 명단 스냅샷 (2026-08-17). TTL 5일 — 필요한 건 어제 것뿐이고 넉넉히 남긴다.
        { col: 'ranksnapshots', key: { day: 1 }, unique: true },
        { col: 'ranksnapshots', key: { createdAt: 1 }, ttl: 5 * 86400 },
        // 상위 티어 어긋남 눈금 (2026-08-17). 한 줄 60B 라 7일이면 100KB 도 안 된다
        { col: 'apexdrifts', key: { t: -1 } },
        { col: 'apexdrifts', key: { createdAt: 1 }, ttl: 7 * 86400 },
        // 컷라인 그래프 (2026-08-18). **TTL 없음** — 하루 한 줄이라 1년에 36KB 다.
        //   unique 는 스키마 선언만으로는 안 만들어지므로 여기 적는다 (위 mythicshops 와 같은 함정).
        { col: 'rankcutoffs', key: { day: 1 }, unique: true },
        { col: 'matchstats', key: { v: 1, k: 1 } },
        { col: 'matchstats', key: { t: 1 } },
        { col: 'champstats', key: { scope: 1, kb: 1, pos: 1 } },
        { col: 'statscopes', key: { scope: 1, kb: 1 }, unique: true },
        // PBE 글 창고 (2026-08-27). **TTL 없음** — 쌓는 게 목적이다
        { col: 'pbenotes', key: { tid: 1 }, unique: true },
        { col: 'pbenotes', key: { date: -1 } },
        // LP 추이 (2026-09-01). **TTL 없음** — 잡이 lastDay 기준으로 지운다.
        //   puuid unique 가 곧 정합성 장치다 (saveLpHistory 가 E11000 을 "이미 했다" 로 삼킨다)
        { col: 'lphistories', key: { puuid: 1 }, unique: true }
    ];

    // ★★ 못 쓰게 된 옛 인덱스. **지우기 전에 새 걸 만들면 안 된다** — `date` 단독 unique 가
    //   살아 있는 동안은 같은 날짜의 두 번째 구획이 11000 으로 막힌다.
    const legacy = [
        { col: 'mythicshops', name: 'date_1' }   // 2026-08-17: date + section 으로 대체
    ];

    const db = mongoose.connection.db;
    let made = 0, changed = 0, dropped = 0;

    // ★ 새 인덱스보다 먼저 돈다. 순서가 뒤바뀌면 위 이유로 막힌다.
    for (const l of legacy) {
        try {
            const existing = await db.collection(l.col).indexes().catch(() => []);
            if (existing.some(i => i.name === l.name)) {
                await db.collection(l.col).dropIndex(l.name);
                console.log(`[Index] 옛 인덱스 삭제 ${l.col} ${l.name}`);
                dropped++;
            }
        } catch (e) {
            console.error(`[Index] ${l.col} ${l.name} 삭제 실패: ${e.message}`);
        }
    }

    // ★★ `section` 이 없는 옛 신화상점 문서를 메운다. **복합 unique 를 만들기 전에** 해야 한다 —
    //   빠진 필드는 인덱스에서 null 로 잡혀서, 같은 날짜에 section:'daily' 문서가 새로 들어오면
    //   막히지 않고 **문서가 둘 생긴다.** 구획이 생기기 전 것은 전부 일일이었다.
    try {
        const r = await MythicShop.updateMany({ section: { $exists: false } }, { $set: { section: 'daily' } });
        if (r.modifiedCount) console.log(`[Index] 신화상점 section 메움: ${r.modifiedCount}건 → daily`);
    } catch (e) {
        console.error(`[Index] 신화상점 section 메우기 실패: ${e.message}`);
    }

    for (const w of want) {
        try {
            const existing = await db.collection(w.col).indexes().catch(() => []);
            const hit = existing.find(i => JSON.stringify(i.key) === JSON.stringify(w.key));

            if (!hit) {
                const opts = {};
                if (w.ttl) opts.expireAfterSeconds = w.ttl;
                if (w.unique) opts.unique = true;
                await db.collection(w.col).createIndex(w.key, opts);
                console.log(`[Index] 생성 ${w.col} ${JSON.stringify(w.key)}${w.ttl ? ` (TTL ${w.ttl / 86400}일)` : ''}`);
                made++;
            } else if (w.ttl && hit.expireAfterSeconds !== w.ttl) {
                const from = (hit.expireAfterSeconds / 86400).toFixed(0);
                try {
                    // collMod 가 되면 이게 낫다 — 인덱스가 잠시도 사라지지 않는다.
                    await db.command({ collMod: w.col, index: { name: hit.name, expireAfterSeconds: w.ttl } });
                } catch (e) {
                    // ★ Atlas 무료 티어(M0)는 collMod 권한이 없다
                    //   ("user is not allowed to do action [collMod]").
                    //   그럴 땐 지우고 다시 만든다. TTL 청소는 60초 주기라 그 틈에 새는 건 없다.
                    await db.collection(w.col).dropIndex(hit.name);
                    await db.collection(w.col).createIndex(w.key, { expireAfterSeconds: w.ttl });
                }
                console.log(`[Index] TTL 변경 ${w.col} ${from}일 → ${w.ttl / 86400}일`);
                changed++;
            }
        } catch (e) {
            console.error(`[Index] ${w.col} ${JSON.stringify(w.key)} 실패: ${e.message}`);
        }
    }
    if (made || changed || dropped) console.log(`[Index] 보정 완료 (생성 ${made} / TTL 변경 ${changed} / 삭제 ${dropped})`);
}

// ★★ 명단 갱신 주기를 시간대로 나눈다 (2026-08-17).
//   **밤 22시~새벽 02시(KST)는 5분, 나머지는 10분.** 티어 재계산이 그 근처로 짐작돼서
//   그 창만 촘촘히 본다 (`ApexDrift` 가 0 으로 떨어지는 순간을 놓치지 않으려고).
//   ★ 호출은 거의 안 는다 — 한 번에 3회(챌/그마/마스터)이고 하루 24회가 더해질 뿐이다
//     (144 → 168회/일). 개발 키 한도가 분당 50회라 순간 최대도 3/5분 = 0.6회/분이다.
//   ★ setInterval 이 아니라 **끝난 뒤 다시 예약**한다 — 조회가 느릴 때 겹쳐 도는 걸 막고,
//     시간대가 바뀌면 다음 예약부터 새 주기가 자연히 적용된다.
const RANK_REFRESH_NIGHT = 5 * 60 * 1000;
const RANK_REFRESH_DAY = 10 * 60 * 1000;

// ==========================================
// ★★ 23:45~23:59(KST) 만 1분 주기 (2026-08-18 임시 계측 → 2026-08-19 상시로 승격)
//   처음엔 "티어 재계산 시각을 재는 임시 계측" 이었는데 실측이 끝난 뒤에도 남긴다 —
//   **컷라인(rankcutoffs)이 이 1분 표본에서 뽑히기 때문이다** (아래 saveRankCutoff).
//   ★ 실측(8/18 밤, 1분 해상도): 챌린저↔그마 경계가 **23:55**, 그마↔마스터가 **23:56** 에
//     재계산됐고 그 줄에서 어긋남이 0 이 됐다. 5분 해상도로는 이 순간을 못 집는다.
//   ★ 창이 자정을 안 넘는 게 중요하다 — 표본이 전부 같은 날짜라 컷을 어느 날로 적을지가
//     갈리지 않는다. (예전 창은 23:30~00:30 이라 자정을 넘었다)
//   ★ 호출: 사이클 180회/일 x 3 = **540회/일**. 순간 최대 3회/분이고, 같은 시간대에 도는
//     수집 잡(10회/분)을 더해도 13회/분이라 개발 키 한도(50회/분)의 26% 다.
// ==========================================
const RANK_REFRESH_PEAK = 60 * 1000;
const RANK_PEAK_FROM = 23 * 60 + 45;   // 23:45 (분으로 환산). 23:59 까지가 1분 주기다

function rankRefreshMs() {
    const k = new Date(Date.now() + 9 * 3600000);                 // 한국시간
    const min = k.getUTCHours() * 60 + k.getUTCMinutes();
    if (min >= RANK_PEAK_FROM) return RANK_REFRESH_PEAK;          // 23:45 ~ 23:59
    const h = k.getUTCHours();
    return (h >= 22 || h < 2) ? RANK_REFRESH_NIGHT : RANK_REFRESH_DAY;
}

// ★★ 다음 실행을 **정각 격자에 맞춘다** (2026-08-18).
//   예전엔 `끝난 시각 + 주기` 라 23:23 · 23:28 · 23:33 처럼 어중간한 분에 돌았다.
//   조회에 걸린 시간만큼 매번 밀려서 시각이 계속 떠내려간다.
//   지금은 **한국시간 자정부터 주기 간격으로 놓인 격자**의 다음 칸을 겨냥한다 —
//   1분이면 매분 00초, 5분이면 :00 :05 :10 …, 10분이면 :00 :10 :20 … 이다.
//   ★ 주기가 바뀌는 경계도 저절로 맞는다: 23:25 에 돌면 5분 격자로 23:30 을 잡고,
//     거기서 깨면 그때 rankRefreshMs 가 1분을 주므로 이후 23:31 · 23:32 … 로 이어진다.
//   ★ 조회가 느려 격자를 넘겨 버려도 `%` 계산이 **다음 칸**을 자연히 가리킨다.
//     남은 시간이 너무 짧으면(5초 미만) 한 칸 건너뛴다 — 끝나자마자 또 도는 걸 막는다.
function nextRankDelay() {
    const step = rankRefreshMs();
    const kstNow = Date.now() + 9 * 3600000;
    let wait = step - (kstNow % step);
    if (wait < 5000) wait += step;
    return wait;
}

function scheduleRankUpdate() {
    setTimeout(async () => {
        try { await updateChallengerList(); } catch (e) { console.error('[Task] 명단 갱신 실패:', e.message); }
        scheduleRankUpdate();
    }, nextRankDelay());
}

async function startJobs() {
    await ensureStatIndexes();

    // ★ `REBUILD_STATS=1 node server.js` — 집계만 한 번 돌리고 끝낸다 (2026-08-18).
    //   집계 규칙을 바꿨을 때 **다음 정시를 기다리지 않고 바로 반영**하려는 것이다.
    //   ★★ 반드시 배포 뒤에 돌릴 것. 먼저 돌리면 아직 옛 화면인 프로덕션이
    //     새 형식 데이터를 읽어 잠깐 이상하게 나온다 (matchseens 때와 같은 순서 규칙).
    //   라이엇 호출은 0 이다 — DB 안에서만 돈다.
    if (process.env.REBUILD_STATS === '1') {
        console.log('[System] REBUILD_STATS=1 — 집계만 한 번 돌리고 끝낸다');
        // ★★ **버전을 먼저 맞춰야 한다** (2026-09-09에 데어 봤다). 안 하면 `currentVersion` 이
        //   부팅 기본값 `16.1.1` 이라 `loadCompletedItems()` 가 **옛 패치의 완성 아이템 목록**
        //   (154개, 지금은 141개)을 받아 온다. 그 목록으로 코어 순서를 세면 **틀린 빌드 통계가
        //   조용히 DB 에 덮인다** — 화면의 ddragonVersion 함정과 같은 부류다.
        await updateVersion();
        await buildChampStats();
        process.exit(0);
    }
    await loadResolvedNames();
    await backfillSearchFields();
    await updateVersion();
    await updateArenaAugments();
    await updateChallengerList();

    // ★★ 로컬에서 화면만 확인할 때는 `READONLY_JOBS=1 node server.js` 로 띄운다.
    //   로컬 서버가 **프로덕션과 같은 DB · 같은 API 키**를 쓰기 때문이다. 그냥 띄우면
    //   순회·수집 잡이 Railway 쪽과 **같은 매치를 두 번 처리**하고 라이엇 호출도
    //   두 배가 되어 429 를 부른다 (2026-08-15에 matchseens 가 실제로 섞였다).
    //   여기서 멈추므로 조회 API 와 화면은 그대로 살아 있다.
    if (process.env.READONLY_JOBS === '1') {
        console.log('[System] READONLY_JOBS=1 — 백그라운드 잡을 띄우지 않는다 (조회만 가능)');
        return;
    }

    // 닉네임 변환은 오래 걸리므로 기다리지 않고 백그라운드로 던짐
    resolveNamesInBackground();

    scheduleRankUpdate();
    // ★ 컷라인은 명단 갱신과 별개로 하루 한 번(한국시간 자정) 혼자 돈다. 라이엇 호출 0.
    scheduleCutoffJob();
    // ★ 랭커 LP 일별 기록 — 자정 +2분, 라이엇 호출 0 (2026-09-01)
    scheduleLpHistoryJob();
    setInterval(resolveNamesInBackground, 60 * 1000);

    // ★ 숙련도 잡은 30초 어긋나게 띄운다. 닉네임 20회(24초) + 숙련도 10회(12초)를
    //   같이 출발시키면 순간 호출량이 겹쳐 개발 키 한도(2분 100회)에 훨씬 빨리 닿는다.
    setTimeout(() => {
        fillMasteryInBackground();
        setInterval(fillMasteryInBackground, 60 * 1000);
    }, 30 * 1000);
    setInterval(updateArenaAugments, 24 * 60 * 60 * 1000);

    // ★ 통계 수집 두 잡도 기존 잡들과 15초씩 어긋나게 띄운다.
    //   0초 닉네임 / 15초 matchlist / 30초 숙련도 / 45초 detail 순서다.
    //   ★ 둘은 시간대가 갈려서 절대 같이 안 돈다 (오전 순회 16 / 오후 수집 10).
    //     그래서 순간 최대가 17회/분이고 한도(50회/분)의 3분의 1이다.
    setTimeout(() => {
        scanMatchlists();
        setInterval(scanMatchlists, 60 * 1000);
    }, 15 * 1000);

    setTimeout(() => {
        fetchMatchStats();
        setInterval(fetchMatchStats, 60 * 1000);
    }, 45 * 1000);

    // 집계는 DB 안에서만 도니까 호출 예산과 무관하다. 1시간마다 다시 계산한다.
    setTimeout(() => {
        buildChampStats();
        setInterval(buildChampStats, 60 * 60 * 1000);
    }, 90 * 1000);

    setInterval(async () => {
        if (resolvedCountIn10Mins > 0) {
            console.log(`[Task] 백그라운드 닉네임 변환 진행 (최근 10분간 ${resolvedCountIn10Mins}건 갱신 완료)`);
            resolvedCountIn10Mins = 0;
        }
        const c = statCounters;
        // ★ 남은 판(k>=5 인데 아직 detail 을 못 받은 것)을 같이 센다 (2026-08-27). 라이엇 호출 0.
        //   예전엔 "한 것" 만 찍어서 429 로 아무것도 못 하는 10분은 로그 자체가 없었다 —
        //   **밀리고 있다는 사실이 제일 안 보이던 순간**이다. 남은 게 있으면 활동이 0 이어도 찍는다.
        const day = scanTargetDay();
        const prev = kstDay(Date.now() - 2 * 86400000);
        const leftCond = { done: { $ne: true }, cnt: { $gte: STAT_MIN_K } };
        const [leftDay, leftPrev] = await Promise.all([
            MatchSeen.countDocuments({ ...leftCond, day }), MatchSeen.countDocuments({ ...leftCond, day: prev })
        ]).catch(() => [0, 0]);
        if (c.scan || c.fetch || leftDay || leftPrev) {
            const left = scanPending();
            const phase = left > 0 ? `순회 ${left}명 남음` : '수집';
            // ★ 타임라인은 곁가지라 받은 수·실패 수를 따로 적는다 — 실패가 쌓이면 여기서 드러난다
            const tl = (c.tl || c.tlFail) ? ` / 타임라인 ${c.tl || 0}건${c.tlFail ? ` (실패 ${c.tlFail})` : ''}` : '';
            const rest = ` / 남은 판 ${leftDay}` + (leftPrev ? ` (+전날 ${leftPrev})` : '');
            console.log(`[Stat] 최근 10분(${phase}): 명단 ${c.scan}명 훑음 / 매치 ${c.seen}건 관측 / detail ${c.fetch}건 (저장 ${c.save} · 제외 ${c.skip})${tl}${rest}`);
            statCounters = { scan: 0, seen: 0, fetch: 0, save: 0, skip: 0 };
        }
        await reportClosedStatDay();
    }, 600 * 1000);
}

// ==========================================
// [4] 공통 헬퍼
// ==========================================
const ARENA_QUEUES = new Set([1700, 1710, 1750]);

// 칼바람: 라인/포지션 개념이 없어서 요약 통계를 협곡과 같은 통에 넣으면 안 된다.
const ARAM_QUEUES = new Set([450, 720]);   // 450 칼바람, 720 칼바람 클래시

// 화면에 찍는 라벨 (세분화). 여기 없는 큐는 "기타"로 떨어진다.
const QUEUE_MAP = {
    420: "솔로랭크",
    440: "자유랭크",

    400: "일반(교차)",     // 교차 선택 = 드래프트 픽
    480: "일반(신속)",     // 신속대전 = 스위프트플레이
    430: "일반",          // 대전 선택 — 현재 클라에서 사라진 큐
    490: "빠른대전",      // 퀵플레이 — 현재 클라에서 사라진 큐

    450: "칼바람",
    720: "칼바람",        // 칼바람 클래시
    2400: "아수라장",     // 무작위 총력전: 아수라장 (실측 확인)
    2450: "아수라장(클래식)",  // 아수라장 클래식 스타일 — 관전 API 실측 (mapId 12)

    830: "봇전(입문)", 840: "봇전(초보)", 850: "봇전(중급)",   // 구버전 봇전
    870: "봇전(입문)", 880: "봇전(초보)", 890: "봇전(중급)",   // 현재 봇전

    700: "클래시",
    4310: "클래식",       // LoL 클래식 — 관전 API에서 실측 (mapId 453)
    900: "우르프",
    1020: "단일 챔피언",
    1300: "돌격! 넥서스",
    1400: "궁극기 주문서",
    1900: "우르프",

    1700: "아레나",       // 구버전
    1710: "아레나",       // 구버전
    1750: "아레나"        // 현재 (3인 6팀)
};

// 필터 버튼용 그룹. 라벨과 분리한 이유:
//   프론트 필터가 라벨 부분일치로 동작하면 "빠른대전"이 "일반" 버튼에 안 잡히고,
//   나중에 라벨을 늘릴 때 서로 부분문자열이 되어 잡아먹는 사고가 난다.
//   표시용 라벨과 분류용 그룹을 따로 두고, 필터는 그룹 완전일치로 판정한다.
const QUEUE_GROUP = {
    420: "솔로랭크",
    440: "자유랭크",

    400: "일반", 430: "일반", 480: "일반", 490: "일반",

    450: "칼바람", 720: "칼바람",
    2400: "아수라장",
    2450: "아수라장",
    4310: "클래식",

    830: "봇", 840: "봇", 850: "봇",
    870: "봇", 880: "봇", 890: "봇",

    1700: "아레나", 1710: "아레나", 1750: "아레나"
};

// 티어 정렬용 점수 계산
const TIER_BASE = {
    IRON: 1, BRONZE: 2, SILVER: 3, GOLD: 4, PLATINUM: 5,
    EMERALD: 6, DIAMOND: 7, MASTER: 8, GRANDMASTER: 9, CHALLENGER: 10
};
const DIV_BASE = { IV: 1, III: 2, II: 3, I: 4 };

function calcTierScore(tier, rank, lp) {
    const base = TIER_BASE[String(tier || '').toUpperCase()] || 0;
    if (base === 0) return 0;
    const div = DIV_BASE[String(rank || '').toUpperCase()] || 1;
    return base * 100000 + div * 10000 + Math.min(Number(lp) || 0, 9999);
}

// 입력 가중치 (한글 2점, 그 외 1점)
function inputWeight(str) {
    let w = 0;
    for (const ch of String(str)) w += /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch) ? 2 : 1;
    return w;
}

// 닉네임을 검색용 소문자 필드로 분해
function toSearchFields(displayName) {
    const lower = String(displayName).toLowerCase();
    return { nameLower: lower, namePartLower: lower.split('#')[0] };
}

// 정규식 특수문자 이스케이프
function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 매치 상세(detail) 하나를 화면용 데이터로 변환
// 미등록 큐 발견 로그
//   로테이션 이벤트 모드는 큐ID가 수시로 생기고 바뀌어서 미리 다 넣어둘 수 없다.
//   누가 그 모드를 검색하면 콘솔에 한 번 찍히고, 그걸 보고 QUEUE_MAP에 추가하면 된다.
//   같은 큐가 반복해서 찍히지 않도록 프로세스당 한 번만 기록한다.
const seenUnknownQueues = new Set();

function logUnknownQueue(detail) {
    const qid = detail.info.queueId;
    if (QUEUE_MAP[qid] || seenUnknownQueues.has(qid)) return;
    seenUnknownQueues.add(qid);
    console.log(
        `[미등록 큐] queueId=${qid} gameMode=${detail.info.gameMode} ` +
        `mapId=${detail.info.mapId} matchId=${detail.metadata.matchId}`
    );
}

function buildHistoryEntry(detail, targetPuuid, isPast = false) {
    logUnknownQueue(detail);

    const p = detail.info.participants.find(part => part.puuid === targetPuuid);
    if (!p) return null;

    const isArena = ARENA_QUEUES.has(detail.info.queueId);
    const isAram = ARAM_QUEUES.has(detail.info.queueId);
    const augmentsOf = (x) => [x.playerAugment1, x.playerAugment2, x.playerAugment3, x.playerAugment4, x.playerAugment5, x.playerAugment6].filter(Boolean);

    // ============================================================
    // 아레나 팀 해석
    //   playerSubteamId   = 몇 번 조냐 (1~6, 경기 내내 고정)
    //   subteamPlacement  = 몇 등으로 끝났냐 (1~6)
    //   둘 다 1~6짜리 숫자라 눈으로는 구분이 안 되지만 의미가 다르다. 섞으면 안 됨.
    //
    //   - 팀을 묶는 기준  : 조 번호
    //   - 화면에 찍는 값  : 등수
    //   도중 이탈 등으로 subteamPlacement가 0인 참가자가 섞여도 팀이 쪼개지지 않도록,
    //   조원 중 유효한 등수 하나를 그 조 전체의 등수로 사용한다.
    // ============================================================
    const hasSubteamId = isArena && detail.info.participants.some(x => x.playerSubteamId);
    const subteamIdOf = (x) => hasSubteamId
        ? (Number(x.playerSubteamId) || 0)
        : (Number(x.subteamPlacement) || 0);   // playerSubteamId가 없던 구버전 매치 폴백

    const placementByTeam = {};
    if (isArena) {
        for (const part of detail.info.participants) {
            const tid = subteamIdOf(part);
            const pl = Number(part.subteamPlacement) || 0;
            if (tid && pl && !placementByTeam[tid]) placementByTeam[tid] = pl;
        }
    }

    // 장로용 처치 수. challenges는 팀 전체 값을 참가자마다 실어주므로 한 명만 보면 된다.
    const elderKillsOf = (teamId) => {
        const p = detail.info.participants.find(x => x.teamId === teamId && x.challenges);
        return p?.challenges?.teamElderDragonKills || 0;
    };

    const placementOf = (x) => {
        const tid = subteamIdOf(x);
        return placementByTeam[tid] || Number(x.subteamPlacement) || 0;
    };

    const durationMin = Math.floor(detail.info.gameDuration / 60);
    const durationSec = detail.info.gameDuration % 60;
    const daysAgo = Math.floor((Date.now() - detail.info.gameEndTimestamp) / 86400000);

    // 30일이 넘으면 6개월 전이든 2년 전이든 전부 "1개월 전"으로 찍히던 것을 단계화
    const relativeDay = (d) => {
        if (d === 0) return "오늘";
        if (d < 30) return `${d}일 전`;
        if (d < 365) return `${Math.max(1, Math.round(d / 30.44))}개월 전`;
        return `${Math.floor(d / 365)}년 전`;
    };
    // 킬관여 분모: 일반 게임은 같은 teamId(5명), 아레나는 같은 조(3명).
    //   아레나의 teamId는 100/200 두 개뿐이라 그대로 쓰면 9명 킬 총합으로 나눠버린다.
    const alliesOf = (x) => isArena
        ? detail.info.participants.filter(y => subteamIdOf(y) === subteamIdOf(x))
        : detail.info.participants.filter(y => y.teamId === x.teamId);

    const kpOf = (x) => {
        const tk = alliesOf(x).reduce((sum, y) => sum + y.kills, 0);
        return tk === 0 ? 0 : Math.round(((x.kills + x.assists) / tk) * 100);
    };

    const teamKills = alliesOf(p).reduce((sum, x) => sum + x.kills, 0);

    return {
        matchId: detail.metadata.matchId,
        queueType: QUEUE_MAP[detail.info.queueId] || "기타",
        queueGroup: QUEUE_GROUP[detail.info.queueId] || "기타",
        win: p.win,
        championName: p.championName === "FiddleSticks" ? "Fiddlesticks" : p.championName,
        champLevel: p.champLevel,
        kills: p.kills, deaths: p.deaths, assists: p.assists,
        kda: p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(2),
        kp: teamKills === 0 ? 0 : Math.round(((p.kills + p.assists) / teamKills) * 100),
        spell1: p.summoner1Id, spell2: p.summoner2Id,
        mainRune: p.perks?.styles?.[0]?.style || null, subRune: p.perks?.styles?.[1]?.style || null,
        item0: p.item0, item1: p.item1, item2: p.item2, item3: p.item3, item4: p.item4, item5: p.item5, item6: p.item6,
        item7: (p.roleBoundItem || p.item7 || 0),
        isArena,
        isAram,
        teamPosition: p.teamPosition || '',
        // 다시하기: 라이엇이 조기 항복 플래그를 주고, 없으면 4분 미만으로 판정.
        // 실제로 플레이한 게임이 아니라 승률·포지션·챔피언 통계에서 전부 제외한다.
        isRemake: !isArena && (p.gameEndedInEarlySurrender === true || durationMin < 4),
        // (헬퍼는 아래 elderKillsOf 참고)
        // 팀 단위 정보 (밴 / 오브젝트). 칼바람은 밴이 없어 빈 배열로 온다.
        //   ★ 아레나는 밴이 있다. 참가자 1명당 1개(18인 = 18개)가 전부 teams[0] 한 곳에 몰려 오고
        //     teams[1]은 teamId 0 에 빈 배열이다. 어느 조가 밴했는지는 라이엇이 안 알려준다.
        //   objectives.dragon.kills는 장로까지 합산된 값이라 그것만으론 구분이 안 된다.
        //   challenges.teamElderDragonKills(팀 전체 값이 참가자마다 실려 온다)를 빼서 나눈다.
        teamStats: (detail.info.teams || []).map(t => ({
            teamId: t.teamId,
            win: t.win === true,
            // championId -1 은 "시간 초과로 밴 못 함". 자리를 유지해야 빈 밴 표시가 되므로 그대로 보낸다.
            // ★ pickTurn 순서를 못 박아 보낸다. 아레나에서 이 순서가 조 순서일 가능성이 크다(조당 3개씩).
            bans: [...(t.bans || [])].sort((a, b) => a.pickTurn - b.pickTurn).map(b => b.championId),
            objectives: {
                baron: t.objectives?.baron?.kills || 0,
                elderDragon: elderKillsOf(t.teamId),
                dragon: Math.max(0, (t.objectives?.dragon?.kills || 0) - elderKillsOf(t.teamId)),
                riftHerald: t.objectives?.riftHerald?.kills || 0,
                horde: t.objectives?.horde?.kills || 0,
                atakhan: t.objectives?.atakhan?.kills || 0,
                tower: t.objectives?.tower?.kills || 0,
                inhibitor: t.objectives?.inhibitor?.kills || 0
            }
        })),

        subteam: isArena ? subteamIdOf(p) : null,
        placement: isArena ? (placementOf(p) || null) : null,
        augments: isArena ? augmentsOf(p) : [],
        totalCs: p.totalMinionsKilled + p.neutralMinionsKilled,
        csPerMin: durationMin > 0 ? ((p.totalMinionsKilled + p.neutralMinionsKilled) / durationMin).toFixed(1) : "0.0",
        goldEarned: p.goldEarned, visionScore: p.visionScore, controlWards: p.visionWardsBoughtInGame,
        multiKill: p.pentaKills ? "펜타킬" : (p.quadraKills ? "쿼드라킬" : (p.tripleKills ? "트리플킬" : (p.doubleKills ? "더블킬" : ""))),
        firstBlood: p.firstBloodKill, durationMin, durationSec,
        dateStr: isPast ? "과거 전적" : relativeDay(daysAgo),
        timestamp: detail.info.gameEndTimestamp,
        participants: detail.info.participants.map(part => ({
            // ★ 마스터+ 명단에 있으면 [티어 한 글자, LP] — 상세 표의 티어 배지 몫 (2026-09-01).
            //   응답을 만드는 순간의 명단 기준이라 캐시된 응답은 몇 분 낡을 수 있다 (문제 없다)
            rankTier: rankTierByPuuid.get(part.puuid) || null,
            puuid: part.puuid, isSearchedUser: part.puuid === targetPuuid, teamId: part.teamId, win: part.win, champLevel: part.champLevel,
            championName: part.championName === "FiddleSticks" ? "Fiddlesticks" : part.championName, visionScore: part.visionScore,
            summonerName: part.riotIdGameName ? `${part.riotIdGameName}#${part.riotIdTagline}` : (part.summonerName || "알 수 없음"),
            kills: part.kills, deaths: part.deaths, assists: part.assists, damage: part.totalDamageDealtToChampions, damageTaken: part.totalDamageTaken,
            kp: kpOf(part),

            // 라이엇이 판정한 라인. TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY.
            // 칼바람·아레나는 빈 문자열로 온다.
            teamPosition: part.teamPosition || '',

            // --- 뱃지용 (challenges는 옛 매치나 일부 모드에 없을 수 있어 ?. 로 접근) ---
            multiKill: part.pentaKills ? "펜타킬" : (part.quadraKills ? "쿼드라킬" : (part.tripleKills ? "트리플킬" : (part.doubleKills ? "더블킬" : ""))),
            firstBlood: part.firstBloodKill === true,
            firstBloodAssist: part.firstBloodAssist === true,
            soloKills: part.challenges?.soloKills || 0,
            steals: part.challenges?.epicMonsterSteals || 0,
            // 처형·포탑·몬스터 사망을 뺀, 적 챔피언에게 죽은 횟수
            champDeaths: part.challenges?.deathsByEnemyChamps ?? part.deaths,
            gold: part.goldEarned, cs: part.totalMinionsKilled + part.neutralMinionsKilled,
            wardsPlaced: part.wardsPlaced || 0, wardsKilled: part.wardsKilled || 0, visionWards: part.visionWardsBoughtInGame || 0,
            item0: part.item0, item1: part.item1, item2: part.item2, item3: part.item3, item4: part.item4, item5: part.item5, item6: part.item6, item7: (part.roleBoundItem || part.item7 || 0),
            subteam: isArena ? subteamIdOf(part) : 0,
            placement: isArena ? placementOf(part) : 0,
            augments: isArena ? augmentsOf(part) : [],
            spell1: part.summoner1Id, spell2: part.summoner2Id, mainRune: part.perks?.styles?.[0]?.style || null, subRune: part.perks?.styles?.[1]?.style || null
        })),
        myRunes: p.perks?.styles ? { primaryStyle: p.perks.styles[0].style, primarySelections: p.perks.styles[0].selections.map(s => s.perk), subStyle: p.perks.styles[1].style, subSelections: p.perks.styles[1].selections.map(s => s.perk), statPerks: p.perks.statPerks ? [p.perks.statPerks.offense, p.perks.statPerks.flex, p.perks.statPerks.defense] : [] } : null
    };
}

// 매치 참가자들의 닉네임을 캐시에 축적 (티어 정보는 건드리지 않음)
function saveParticipantNames(matchDetails, excludePuuid) {
    const seen = new Map();

    for (const { detail } of matchDetails) {
        for (const part of detail?.info?.participants || []) {
            if (!part.puuid || part.puuid === excludePuuid) continue;
            if (!part.riotIdGameName || !part.riotIdTagline) continue;
            if (/\sbot$/i.test(part.riotIdGameName)) continue;   // 봇 제외
            seen.set(part.puuid, `${part.riotIdGameName}#${part.riotIdTagline}`);
        }
    }
    if (seen.size === 0) return;

    const now = Date.now();
    const ops = [...seen].map(([puuid, name]) => ({
        updateOne: {
            filter: { puuid },
            update: { $set: { displayName: name, updatedAt: now, ...toSearchFields(name) } },
            upsert: true
        }
    }));

    SummonerCache.bulkWrite(ops, { ordered: false }).catch(() => { });
}

// 기존 데이터에 검색용 소문자 필드를 채워 넣음 (서버 시작 시 1회)
async function backfillSearchFields() {
    try {
        const targets = await SummonerCache.find({ namePartLower: { $exists: false } })
            .select('puuid displayName')
            .limit(50000);
        if (targets.length === 0) return;

        const ops = targets.map(d => ({
            updateOne: {
                filter: { _id: d._id },
                update: { $set: toSearchFields(d.displayName) }
            }
        }));

        for (let i = 0; i < ops.length; i += 1000) {
            await SummonerCache.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
        }
        console.log(`[System] 검색 색인 보강 완료: ${targets.length}건`);
    } catch (err) {
        console.error("[System] 검색 색인 보강 실패:", err.message);
    }
}

// 닉네임으로 puuid 찾기 (SummonerCache 우선)
async function findPuuidByName(fullName) {
    // 1순위: 정확히 일치 (인덱스 사용)
    let hit = await SummonerCache.findOne({ displayName: fullName });
    if (hit) return hit.puuid;

    // 2순위: 대소문자 무시 (SummonerCache는 문서가 작아 스캔해도 부담 적음)
    hit = await SummonerCache.findOne({
        displayName: new RegExp(`^${escapeRegex(fullName)}$`, 'i')
    });
    return hit ? hit.puuid : null;
}

// 429 발생 시 DB에 쌓인 과거 전적으로 응답 구성
async function buildFallbackResponse(fullName) {
    const targetPuuid = await findPuuidByName(fullName);
    if (!targetPuuid) return null;

    const fallbackMatches = await MatchCache
        .find({ 'detail.metadata.participants': targetPuuid })
        .select('-timeline')
        .sort({ 'detail.info.gameEndTimestamp': -1 })
        .limit(20)
        .maxTimeMS(3000);

    if (!fallbackMatches?.length) return null;

    const history = fallbackMatches
        .map(m => buildHistoryEntry(m.detail, targetPuuid, true))
        .filter(Boolean);

    if (history.length === 0) return null;

    return {
        puuid: targetPuuid,
        version: currentVersion,
        profile: {
            name: fullName,
            level: "정보없음",
            icon: `https://ddragon.leagueoflegends.com/cdn/${currentVersion}/img/profileicon/1.png`,
            tier: "서버 지연", rank: "", leaguePoints: 0, wins: 0, losses: 0
        },
        history,
        isCachedFallback: true
    };
}

// ==========================================
// [5] API 라우터
// ==========================================

// 소환사 전적 검색 (폴백 로직 포함)
app.get('/api/summoner/:name', async (req, res) => {
    const summonerName = req.params.name;
    // ★ 캐시 키에 접두사를 준다 (2026-09-03 감사 M-9). 예전엔 닉네임 원문이 그대로 키라서
    //   `/api/summoner/challenger_ranking_data` 가 랭킹 payload 를 돌려줬다 (통계·랭킹·신화상점과
    //   같은 myCache 를 쓰는데 조회가 `#` 검증보다 먼저다). `mythic_x#KR1` 같은 닉네임이
    //   clearMythicCache 의 `mythic_` 일괄 삭제에 걸리던 것도 같이 사라진다
    const cacheKey = `summoner_${summonerName}`;
    const cachedData = myCache.get(cacheKey);

    if (cachedData) {
        console.log(`[API] 전적 검색 캐시 적중: ${summonerName}`);
        // ★ 캐시 객체를 고치지 않는다 — useClones:false 라 고치면 캐시 본체가 바뀐다 (감사 M-6 짝)
        return res.json({ ...cachedData, expireAt: myCache.getTtl(cacheKey) });
    }

    try {
        const [gameName, tagLine] = summonerName.split('#');
        if (!gameName || !tagLine) return res.status(400).json({ error: "닉네임#태그 형식으로 입력해주세요." });

        const { data: accountData } = await riotApi.get(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
        const targetPuuid = accountData.puuid;

        const [summonerRes, leagueRes, matchIdsRes] = await Promise.all([
            riotApi.get(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${targetPuuid}`),
            riotApi.get(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${targetPuuid}`),
            riotApi.get(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${targetPuuid}/ids?start=0&count=20`)
        ]);

        const rankData = leagueRes.data.find(entry => entry.queueType === 'RANKED_SOLO_5x5') || null;
        const rankIndex = challengerList.findIndex(p => p.puuid === targetPuuid);
        const serverRank = rankIndex !== -1 ? rankIndex + 1 : null;

        const matchIds = matchIdsRes.data;

        // DB 캐시 확인 및 매치 상세 조회
        const cachedMatches = await MatchCache.find({ matchId: { $in: matchIds } });
        const cachedMatchIds = cachedMatches.map(m => m.matchId);
        const matchesToFetch = matchIds.filter(id => !cachedMatchIds.includes(id));

        console.log(`[DB Cache] ${summonerName}: DB ${cachedMatchIds.length}개 / 신규 ${matchesToFetch.length}개 로드`);

        const newMatchesData = await Promise.all(matchesToFetch.map(async (matchId, index) => {
            try {
                await new Promise(r => setTimeout(r, index * 150));
                const detailRes = await riotApi.get(`https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}`);
                MatchCache.create({ matchId, detail: detailRes.data }).catch(() => { });
                return { detail: detailRes.data, timeline: null };
            } catch (err) { return null; }
        }));

        let allMatchDetails = [...cachedMatches.map(m => ({ detail: m.detail, timeline: m.timeline })), ...newMatchesData].filter(m => m?.detail);
        allMatchDetails.sort((a, b) => b.detail.info.gameEndTimestamp - a.detail.info.gameEndTimestamp);

        const history = allMatchDetails
            .map(({ detail }) => buildHistoryEntry(detail, targetPuuid))
            .filter(Boolean);

        const finalData = {
            puuid: targetPuuid,
            version: currentVersion,
            profile: {
                // ★ 화면에 나가는 이름은 라이엇이 준 정본이다 (2026-09-03 감사 L-17). 검색어 원문을 쓰면
                //   `HIDE on bush#kr1` 로 친 대소문자가 프로필에 그대로 떴다. 아래 canonicalName 과 같은 값
                name: `${accountData.gameName}#${accountData.tagLine}`, level: summonerRes.data.summonerLevel, icon: `https://ddragon.leagueoflegends.com/cdn/${currentVersion}/img/profileicon/${summonerRes.data.profileIconId}.png`,
                tier: rankData?.tier || 'UNRANKED', rank: rankData?.rank || '', leaguePoints: rankData?.leaguePoints || 0,
                wins: rankData?.wins || 0, losses: rankData?.losses || 0,
                serverRank: serverRank
            },
            history
        };

        // ★ 검색된 소환사를 캐시에 저장 (자동완성 / 429 폴백 / 랭킹 닉네임에 재사용)
        const canonicalName = `${accountData.gameName}#${accountData.tagLine}`;
        const now = Date.now();
        SummonerCache.findOneAndUpdate(
            { puuid: targetPuuid },
            {
                displayName: canonicalName,
                updatedAt: now,
                ...toSearchFields(canonicalName),
                tier: rankData?.tier || 'UNRANKED',
                rank: rankData?.rank || '',
                lp: rankData?.leaguePoints || 0,
                tierScore: calcTierScore(rankData?.tier, rankData?.rank, rankData?.leaguePoints),
                iconId: summonerRes.data.profileIconId,
                level: summonerRes.data.summonerLevel
            },
            { upsert: true }
        ).catch(() => { });
        resolvedNames[targetPuuid] = { displayName: canonicalName, updatedAt: now };

        // ★ 같은 게임에 있던 참가자들도 닉네임만 저장 (자동완성 후보 축적)
        saveParticipantNames(allMatchDetails, targetPuuid);

        myCache.set(cacheKey, finalData);
        console.log(`[API] 전적 데이터 처리 완료: ${summonerName}`);
        res.json({ ...finalData, expireAt: myCache.getTtl(cacheKey) });

    } catch (error) {
        if (error.response?.status === 429) {
            console.log(`[API] 429 한도 초과. ${req.params.name} DB 폴백 시도...`);
            try {
                const fallback = await buildFallbackResponse(req.params.name);
                if (fallback) {
                    console.log(`[API] 429 폴백 성공. DB에서 ${fallback.history.length}게임 반환`);
                    return res.json(fallback);
                }
                console.log(`[API] 429 폴백 실패. 저장된 전적 없음`);
            } catch (err) { console.error("[Fallback Error]", err.message); }
            return res.status(429).json({ error: "조회 한도를 초과했습니다. 잠시 후 다시 시도해주세요." });
        }

        console.error(`[Error] API 통신 오류: ${error.message}`);
        if (error.response?.status === 404) return res.status(404).json({ error: "소환사를 찾을 수 없습니다. 닉네임을 다시 확인해주세요." });
        res.status(500).json({ error: "데이터 처리 중 문제가 발생했습니다." });
    }
});

// 마스터리 조회
// ★ 랭커 LP 일별 이력 (2026-09-01) — 전적 페이지 LP 추이 카드 몫. 마스터+ 만 기록이 있다
app.get('/api/lp-history/:puuid', async (req, res) => {
    try {
        const doc = await LpHistory.findOne({ puuid: req.params.puuid }).select('-_id hist').lean();
        res.json({ rows: doc?.hist || [] });
    } catch (e) {
        console.error('[API] LP 이력 조회 실패:', e.message);
        res.status(500).json({ error: 'LP 이력을 불러오지 못했습니다.' });
    }
});

app.get('/api/mastery/:puuid', async (req, res) => {
    // /api/live · /api/matches 와 같은 검증 — 이 라우트만 빠져 있었다 (2026-09-03 감사 M-5)
    const puuid = req.params.puuid;
    if (!/^[\w-]{40,120}$/.test(puuid)) {
        return res.status(400).json({ error: "잘못된 요청입니다." });
    }
    try {
        const response = await riotApi.get(`https://kr.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/top?count=7`);
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: '마스터리 데이터를 불러오지 못했습니다.' }); }
});

// 타임라인 원본에서 화면에 필요한 것만 추출
function extractTimeline(timeline, detail, targetPuuid = null) {
    if (!timeline?.info?.frames) return { goldFrames: null, myTimeline: null };

    // players: 챔피언별 골드 그래프용. participantId(1~10) 순서 그대로.
    const goldFrames = { labels: [], blue: [], red: [], players: [] };
    let myTimeline = { skills: [], items: [] };

    // 골드 격차 그래프에 표시할 오브젝트 처치 기록
    const objectiveEvents = [];

    if (detail?.info?.participants) {
        detail.info.participants.forEach(p => {
            goldFrames.players.push({
                id: p.participantId,
                champ: p.championName,
                name: p.riotIdGameName || p.summonerName || '',
                teamId: p.teamId,
                gold: [],
                xp: []
            });
        });
    }

    // 대상 플레이어의 participantId 찾기
    let myParticipantId = null;
    if (targetPuuid && detail?.info?.participants) {
        const me = detail.info.participants.find(p => p.puuid === targetPuuid);
        if (me) myParticipantId = me.participantId;
    }

    timeline.info.frames.forEach((frame, idx) => {
        goldFrames.labels.push(`${idx}분`);
        let blueGold = 0, redGold = 0;
        if (frame.participantFrames) {
            for (let i = 1; i <= 10; i++) {
                const g = frame.participantFrames[i]?.totalGold || 0;
                if (i <= 5) blueGold += g; else redGold += g;

                const slot = goldFrames.players.find(pl => pl.id === i);
                if (slot) {
                    slot.gold.push(g);
                    slot.xp.push(frame.participantFrames[i]?.xp || 0);
                }
            }
        }
        goldFrames.blue.push(blueGold);
        goldFrames.red.push(redGold);

        // 오브젝트 처치 (프레임 안의 events 전체를 훑는다)
        frame.events?.forEach(event => {
            if (event.type !== 'ELITE_MONSTER_KILL') return;

            // killerTeamId가 없는 옛 타임라인은 killerId(1~5 블루, 6~10 레드)로 판정
            let teamId = event.killerTeamId || 0;
            if (!teamId && event.killerId) teamId = event.killerId <= 5 ? 100 : 200;
            if (!teamId) return;   // 몬스터끼리 죽인 경우 등

            objectiveEvents.push({
                t: event.timestamp,                       // ms
                teamId,
                type: event.monsterType || '',            // BARON_NASHOR / DRAGON / RIFTHERALD / HORDE
                subType: event.monsterSubType || ''       // ELDER_DRAGON, FIRE_DRAGON ...
            });
        });

        if (myParticipantId) {
            frame.events?.forEach(event => {
                if (event.participantId === myParticipantId) {
                    if (event.type === 'SKILL_LEVEL_UP') myTimeline.skills.push(event.skillSlot);
                    else if (event.type === 'ITEM_PURCHASED') myTimeline.items.push({ id: event.itemId, ts: event.timestamp });
                    else if (event.type === 'ITEM_UNDO') {
                        const undoIdx = myTimeline.items.map(i => i.id).lastIndexOf(event.beforeId);
                        if (undoIdx > -1) myTimeline.items.splice(undoIdx, 1);
                    }
                }
            });
        }
    });

    goldFrames.objectives = objectiveEvents;
    return { goldFrames, myTimeline: myParticipantId ? myTimeline : null };
}

// ==========================================
// 챔피언별 라인 분포
//   관전 API는 포지션을 주지 않는다. 게임이 막 시작돼서 라이엇도 아직 판정 전이다.
//   그래서 우리 DB에 쌓인 전적의 teamPosition으로 "이 챔피언은 주로 어느 라인"을 계산해
//   인게임 화면의 라인을 추정한다. 표본이 늘수록 저절로 정확해지고 메타 변화도 따라간다.
// ==========================================
const LANES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const LANE_STAT_QUEUES = [420, 440, 400, 430, 480, 490];   // 라인 개념이 있는 큐만

let champLaneStats = {};        // { championId: { TOP: 0.9, JUNGLE: 0.02, ... } }
let champLaneSampleSize = 0;

async function refreshChampLaneStats() {
    try {
        const rows = await MatchCache.aggregate([
            { $match: { 'detail.info.queueId': { $in: LANE_STAT_QUEUES } } },
            { $unwind: '$detail.info.participants' },
            { $match: { 'detail.info.participants.teamPosition': { $in: LANES } } },
            {
                $group: {
                    _id: {
                        c: '$detail.info.participants.championId',
                        p: '$detail.info.participants.teamPosition'
                    },
                    n: { $sum: 1 }
                }
            }
        ]);

        const counts = {};
        let total = 0;
        rows.forEach(r => {
            const c = r._id.c;
            counts[c] = counts[c] || { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0, _sum: 0 };
            counts[c][r._id.p] += r.n;
            counts[c]._sum += r.n;
            total += r.n;
        });

        const next = {};
        for (const c in counts) {
            const row = counts[c];
            next[c] = {};
            // 표본이 적을 때 한 판짜리 챔피언이 100%가 되는 걸 막으려고 라플라스 보정을 넣는다
            LANES.forEach(l => { next[c][l] = (row[l] + 0.5) / (row._sum + 2.5); });
        }

        champLaneStats = next;
        champLaneSampleSize = total;
        console.log(`[Task] 챔피언 라인 분포 갱신 완료 (${Object.keys(next).length}종 / 표본 ${total})`);
    } catch (e) {
        console.error('[Task] 챔피언 라인 분포 갱신 실패:', e.message);
    }
}

// 모르는 챔피언은 균등 분포로 둔다 (사실상 순서가 무작위가 됨)
const laneProb = (championId, lane) => champLaneStats[championId]?.[lane] ?? 0.2;

function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    arr.forEach((v, i) => {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        permutations(rest).forEach(p => out.push([v, ...p]));
    });
    return out;
}

// 5명에게 라인을 하나씩 배정한다.
//   강타(11)를 든 사람은 정글로 확정하고, 남은 4명만 24가지 조합을 따져 확률 합이 가장 큰 배치를 고른다.
function assignLanes(players) {
    if (players.length !== 5) return players.map(() => '');

    const smiteIdx = players.findIndex(p => p.spell1 === 11 || p.spell2 === 11);
    const result = new Array(5).fill('');

    let targets = players.map((_, i) => i);
    let lanes = LANES.slice();

    if (smiteIdx > -1) {
        result[smiteIdx] = 'JUNGLE';
        targets = targets.filter(i => i !== smiteIdx);
        lanes = lanes.filter(l => l !== 'JUNGLE');
    }

    let best = null, bestScore = -1;
    permutations(lanes).forEach(perm => {
        let score = 0;
        perm.forEach((lane, k) => { score += laneProb(players[targets[k]].championId, lane); });
        if (score > bestScore) { bestScore = score; best = perm; }
    });

    if (best) best.forEach((lane, k) => { result[targets[k]] = lane; });
    return result;
}

// ==========================================
// 진행 중인 게임 (Spectator v5)
//   match-v5와 달리 플랫폼 라우팅(kr)을 쓴다. asia로 부르면 404가 뜬다.
//   게임 중이 아니면 라이엇이 404를 주는데, 이건 에러가 아니라 정상 응답이다.
// ==========================================
const liveGameCache = new Map();       // puuid -> { at, payload }
const LIVE_CACHE_MS = 30 * 1000;       // 실시간성이 중요해서 짧게만 캐싱

function extractLiveGame(raw) {
    // 미등록 큐 발견 로그 (인게임판).
    //   buildHistoryEntry의 로그는 전적 목록을 만들 때만 돈다. 그래서 클래식·아수라장처럼
    //   match-v5로 전적이 안 내려오는 모드는 영영 발견되지 않는다.
    //   관전 정보는 내려오므로 여기서 잡으면 그 모드들의 큐ID도 알 수 있다.
    const qid = raw.gameQueueConfigId;
    if (!QUEUE_MAP[qid] && !seenUnknownQueues.has(`live-${qid}`)) {
        seenUnknownQueues.add(`live-${qid}`);
        console.log(`[미등록 큐/인게임] queueId=${qid} mapId=${raw.mapId} gameId=${raw.gameId}`);
    }

    // championId -1(시간 초과로 밴 못 함)도 자리를 유지해야 인게임처럼 빈 초상화가 뜬다.
    // 밴이 아예 없는 모드(칼바람 등)는 배열이 비어 있고, 프론트에서 그 줄을 통째로 생략한다.
    const bans = { blue: [], red: [] };
    (raw.bannedChampions || []).forEach(b => {
        (b.teamId === 100 ? bans.blue : bans.red).push(b.championId);
    });

    const toPlayer = (p) => {
        const perkIds = p.perks?.perkIds || [];
        return {
            puuid: p.puuid,
            championId: p.championId,
            riotId: p.riotId || '',
            // ★ 마스터+ 티어 배지 (2026-09-03, 기능 감사 F1 1단계). 상세 전적(buildHistoryEntry)과 같은
            //   `[티어 한 글자, LP]` 꼴이고 같은 표(rankTierByPuuid)를 읽는다 — 라이엇 호출 0.
            //   전 티어(마스터 미만)는 league-v4 ×10회/조회라 프로덕션 키 이후 (2단계)
            rankTier: rankTierByPuuid.get(p.puuid) || null,
            spell1: p.spell1Id,
            spell2: p.spell2Id,
            mainRune: perkIds[0] || null,
            subStyle: p.perks?.perkSubStyle || null
        };
    };

    const participants = raw.participants || [];

    // 아레나는 teamId가 100/200뿐이라 그대로 나누면 9명씩 두 덩어리가 된다.
    // 3인 6팀으로 다시 묶는다. playerSubteamId가 오면 그걸 쓰고,
    // 없으면 참가자 배열이 팀 순서대로 온다는 점을 이용해 3명씩 끊는다.
    const isArenaLive = ARENA_QUEUES.has(raw.gameQueueConfigId);
    let subteams = null;

    if (isArenaLive && participants.length > 0) {
        const hasSubId = participants.some(p => p.playerSubteamId);
        const groups = {};
        participants.forEach((p, i) => {
            const key = hasSubId ? (p.playerSubteamId || 0) : Math.floor(i / 3) + 1;
            (groups[key] = groups[key] || []).push(toPlayer(p));
        });
        subteams = Object.keys(groups)
            .sort((a, b) => a - b)
            .map(k => ({ id: Number(k), players: groups[k] }));
    }

    // 아레나·칼바람은 라인 개념이 없어 배정하지 않는다
    const blue = participants.filter(p => p.teamId === 100).map(toPlayer);
    const red = participants.filter(p => p.teamId === 200).map(toPlayer);
    const laneMode = !isArenaLive && raw.mapId === 11;

    if (laneMode) {
        [blue, red].forEach(team => {
            const lanes = assignLanes(team);
            team.forEach((p, i) => { p.position = lanes[i] || ''; });
        });
    }

    return {
        gameId: raw.gameId,
        isArena: isArenaLive,
        subteams,
        queueId: raw.gameQueueConfigId,
        queueName: QUEUE_MAP[raw.gameQueueConfigId] || '기타',
        mapId: raw.mapId,
        // gameLength는 로딩 화면 시간을 빼고 세기 때문에 음수로 시작할 수 있다
        gameLength: Math.max(0, raw.gameLength || 0),
        gameStartTime: raw.gameStartTime || 0,
        bans,
        teams: { blue, red }
    };
}

app.get('/api/live/:puuid', async (req, res) => {
    const puuid = req.params.puuid;
    if (!/^[\w-]{40,120}$/.test(puuid)) {
        return res.status(400).json({ error: "잘못된 요청입니다." });
    }

    const cached = liveGameCache.get(puuid);
    if (cached && Date.now() - cached.at < LIVE_CACHE_MS) {
        return res.json(cached.payload);
    }

    try {
        const { data } = await riotApi.get(
            `https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}`
        );
        const payload = { inGame: true, game: extractLiveGame(data) };
        liveGameCache.set(puuid, { at: Date.now(), payload });
        res.json(payload);

    } catch (error) {
        const status = error.response?.status;

        // 404 = 게임 중이 아님. 정상 상황이므로 캐싱해서 반복 호출을 줄인다.
        if (status === 404) {
            const payload = { inGame: false };
            liveGameCache.set(puuid, { at: Date.now(), payload });
            return res.json(payload);
        }
        if (status === 429) return res.status(429).json({ error: "조회 한도를 초과했습니다." });

        console.error(`[Live] 조회 실패 ${puuid}: ${error.message}`);
        res.status(500).json({ error: "진행 중인 게임을 불러오지 못했습니다." });
    }
});

// 캐시가 무한히 커지지 않게 주기적으로 정리
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of liveGameCache) {
        if (now - v.at > LIVE_CACHE_MS) liveGameCache.delete(k);
    }
}, 60 * 1000);

// 매치 타임라인 조회 (상세 탭 클릭 시 호출)
app.get('/api/timeline/:matchId', async (req, res) => {
    const { matchId } = req.params;
    const puuid = req.query.puuid || null;    // ★ 추가

    if (!/^[A-Z0-9]+_\d+$/i.test(matchId)) {
        return res.status(400).json({ error: "잘못된 매치 ID입니다." });
    }

    try {
        // 1. DB에 detail(+ 옛 배포가 저장해 둔 timeline)이 있으면 확인
        const cached = await MatchCache.findOne({ matchId });
        if (cached?.timeline) {
            return res.json(extractTimeline(cached.timeline, cached.detail, puuid));
        }

        // 1-b. ★ 원본은 DB 대신 서버 메모리(myCache, 5분)에 둔다 — 새로고침 직후 재조회를 여기서 받는다
        const memTl = myCache.get(`timeline_${matchId}`);
        if (memTl) {
            return res.json(extractTimeline(memTl, cached?.detail || null, puuid));
        }

        // 2. 없으면 라이엇에서 받아옴
        const { data: timeline } = await riotApi.get(
            `https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`
        );

        // 3. ★★ DB 에 원본을 저장하지 않는다 (2026-09-04). 한 개 617KB 라 2026-08-15 에 287판이 173MB(용량 절반)를
        //    먹었던 필드다. 프론트 matchTimelineCache 가 세션 내 재조회를 막고, 새로고침 직후는 위 5분 메모리 캐시가 받는다.
        //    ★ 통계 수집(MatchStat 의 sk/it)은 완전히 다른 경로라 무관하다 — 거긴 toSlimTimeline 으로 슬림만 저장한다.
        myCache.set(`timeline_${matchId}`, timeline);

        const detail = cached?.detail || null;
        res.json(extractTimeline(timeline, detail, puuid));

    } catch (error) {
        const status = error.response?.status;
        if (status === 429) return res.status(429).json({ error: "조회 한도를 초과했습니다." });
        if (status === 404) return res.status(404).json({ error: "타임라인 데이터가 없습니다." });
        console.error(`[Timeline] 조회 실패 ${matchId}: ${error.message}`);
        res.status(500).json({ error: "타임라인을 불러오지 못했습니다." });
    }
});

// 전적 더 보기 (start부터 count개 추가 조회)
app.get('/api/matches/:puuid', async (req, res) => {
    const targetPuuid = req.params.puuid;
    const start = Math.max(0, parseInt(req.query.start) || 0);
    const count = Math.min(Math.max(1, parseInt(req.query.count) || 10), 10);

    if (!/^[\w-]{40,120}$/.test(targetPuuid)) {
        return res.status(400).json({ error: "잘못된 요청입니다." });
    }

    try {
        const { data: matchIds } = await riotApi.get(
            `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${targetPuuid}/ids?start=${start}&count=${count}`
        );

        if (!matchIds || matchIds.length === 0) {
            return res.json({ history: [], hasMore: false });
        }

        const cachedMatches = await MatchCache.find({ matchId: { $in: matchIds } });
        const cachedMatchIds = cachedMatches.map(m => m.matchId);
        const matchesToFetch = matchIds.filter(id => !cachedMatchIds.includes(id));

        console.log(`[More] ${start}~${start + count}: DB ${cachedMatchIds.length}개 / 신규 ${matchesToFetch.length}개`);

        const newMatchesData = await Promise.all(matchesToFetch.map(async (matchId, index) => {
            try {
                await new Promise(r => setTimeout(r, index * 150));
                const detailRes = await riotApi.get(`https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}`);
                MatchCache.create({ matchId, detail: detailRes.data }).catch(() => { });
                return { detail: detailRes.data };
            } catch (err) { return null; }
        }));

        const allDetails = [...cachedMatches.map(m => ({ detail: m.detail })), ...newMatchesData]
            .filter(m => m?.detail);
        allDetails.sort((a, b) => b.detail.info.gameEndTimestamp - a.detail.info.gameEndTimestamp);

        const history = allDetails
            .map(({ detail }) => buildHistoryEntry(detail, targetPuuid))
            .filter(Boolean);

        saveParticipantNames(allDetails, targetPuuid);

        res.json({ history, hasMore: matchIds.length === count });

    } catch (error) {
        const status = error.response?.status;
        if (status === 429) return res.status(429).json({ error: "조회 한도를 초과했습니다. 잠시 후 다시 시도해주세요." });
        console.error(`[More] 조회 실패: ${error.message}`);
        res.status(500).json({ error: "전적을 더 불러오지 못했습니다." });
    }
});

// 닉네임 자동완성 / 태그 후보 목록 (전부 자체 DB 조회 — 라이엇 API 미사용)
app.get('/api/suggest', async (req, res) => {
    const raw = String(req.query.q || '').trim();
    const exact = req.query.exact === '1';

    if (!raw) return res.json([]);

    const namePart = raw.split('#')[0].trim();
    const lower = namePart.toLowerCase();

    // 접두사 검색은 최소 4포인트(한글 2점 / 그 외 1점)부터
    if (!exact && inputWeight(namePart) < 4) return res.json([]);
    if (exact && namePart.length === 0) return res.json([]);

    try {
        const filter = exact
            ? { namePartLower: lower }
            : { namePartLower: new RegExp('^' + escapeRegex(lower)) };

        const limit = exact ? 100 : 30;

        const rows = await SummonerCache
            .find(filter)
            .sort({ tierScore: -1 })
            .limit(limit)
            .select('displayName tier rank lp iconId level -_id')
            .maxTimeMS(2000);

        let list = rows.map(r => ({
            displayName: r.displayName,
            tier: r.tier || null,
            rank: r.rank || '',
            lp: r.lp ?? null,
            iconId: r.iconId ?? null,
            level: r.level ?? null
        }));

        if (exact) {
            // 티어 높은 순 > 태그 가나다순
            list.sort((a, b) => {
                const aScore = calcTierScore(a.tier, a.rank, a.lp);
                const bScore = calcTierScore(b.tier, b.rank, b.lp);
                if (aScore !== bScore) return bScore - aScore;

                const aTag = a.displayName.split('#')[1] || '';
                const bTag = b.displayName.split('#')[1] || '';
                return aTag.localeCompare(bTag, 'ko', { sensitivity: 'base' });
            });
        } else {
            // 완전 일치 > 닉네임 짧은 순 > 가나다순
            list.sort((a, b) => {
                const aName = a.displayName.split('#')[0];
                const bName = b.displayName.split('#')[0];

                const aExact = aName.toLowerCase() === lower ? 0 : 1;
                const bExact = bName.toLowerCase() === lower ? 0 : 1;
                if (aExact !== bExact) return aExact - bExact;

                if (aName.length !== bName.length) return aName.length - bName.length;

                return a.displayName.localeCompare(b.displayName, 'ko', { sensitivity: 'base' });
            });
            list = list.slice(0, 6);
        }

        res.json(list);
    } catch (err) {
        console.error("[Suggest] 조회 실패:", err.message);
        res.json([]);
    }
});

// 랭킹
// ==========================================
// 챔피언 통계 (티어리스트)
//   집계는 buildChampStats() 가 1시간마다 미리 해 두므로 여기서는 읽기만 한다.
//   ★ 라인별까지 통째로 내려보낸다 (최대 1,000행쯤). 라인 필터를 누를 때마다
//     다시 부르면 느리고, 어차피 한 번에 받아도 100KB 안쪽이다.
// ==========================================
// ★★ scope 목록·기본값 고르기. **`/api/champion-stats` 와 `/api/spell-usage` 가 같이 쓴다**
//   (2026-08-26에 함수로 뺐다 — 표를 두 벌 두면 어긋난다).
//   ★ 기본값이 "그냥 최신 패치" 가 아닌 이유: 수요일에 패치가 나오면 그 패치 표본이
//     몇 판뿐이라 **패치 당일마다 화면이 텅 빈다.** 그래서 `MIN_SCOPE_GAMES` 를 넘긴
//     가장 최신 패치를 고르고, 그것도 없으면(수집 초기) 표본이 가장 많은 패치로 물러난다.
const MIN_SCOPE_GAMES = 300;
function pickStatScope(scopes, requested) {
    // ★ 패치는 **숫자로** 정렬해야 한다. 문자열로 하면 "16.9" > "16.16" 이 된다.
    const patchKeys = [...new Set(scopes.filter(s => s.scope.startsWith('p:')).map(s => s.scope))]
        .sort((a, b) => {
            const pa = a.slice(2).split('.').map(Number), pb = b.slice(2).split('.').map(Number);
            return (pb[0] - pa[0]) || (pb[1] - pa[1]);
        });
    const dayKeys = [...new Set(scopes.filter(s => s.scope.startsWith('d:')).map(s => s.scope))]
        .sort().reverse();
    const scopeKeys = [...patchKeys, ...dayKeys];

    // scope 별 총 경기 수 (밴드 합산)
    const gamesOf = {};
    scopes.forEach(s => { gamesOf[s.scope] = (gamesOf[s.scope] || 0) + s.games; });

    const scope = scopeKeys.includes(requested)
        ? requested
        : (patchKeys.find(k => gamesOf[k] >= MIN_SCOPE_GAMES)
            || [...patchKeys].sort((a, b) => gamesOf[b] - gamesOf[a])[0]
            || scopeKeys[0]);

    return { scope, scopeKeys, gamesOf };
}

app.get('/api/champion-stats', async (req, res) => {
    try {
        const scopes = await StatScope.find({}).lean();
        if (!scopes.length) {
            return res.json({ ready: false, scopes: [], rows: [], totals: {} });
        }

        const { scope, scopeKeys } = pickStatScope(scopes, req.query.scope);

        // ★ 세대 딱지(gen)를 먼저 읽고 그 세대만 조회한다 (2026-08-31) — 재집계 중에도 완성된 한 벌.
        //   딱지가 없으면(얼어붙은 옛 패치 등 이 코드 이전에 마지막으로 집계된 scope) 필터 없이 읽는다.
        const totalRows = await StatScope.find({ scope }).lean();
        const gen = totalRows.reduce((m, t) => Math.max(m, t.gen || 0), 0) || null;
        const rows = await ChampStat.find(gen ? { scope, g: gen } : { scope }).select('-_id -__v -g').lean();

        // kb 별 총 경기 수. 화면에서 5-7 과 8-10 을 합쳐 볼 수 있게 둘 다 준다.
        const totals = {};
        totalRows.forEach(t => { totals[t.kb] = t.games; });
        const updatedAt = Math.max(...totalRows.map(t => +t.updatedAt || 0));

        // ★★ 박제된 패치 판별 — "scope 목록에는 있는데 집계 행이 없다" 가 그 표식이다.
        //   은퇴한 패치의 집계는 `public/stats_archive/<scope>.js` 로 옮기고 DB 행을
        //   지우는데, `statscopes` 행만은 남긴다(패치당 1~2행). 그래서 드롭다운과
        //   픽률·밴률 분모는 여기서 그대로 나오고, 행만 화면이 파일에서 가져간다.
        //   ★ 파일 크기가 DB 의 10분의 1이라(3.32MB -> 345KB, brotli 25KB)
        //     1년 26패치면 Atlas 84MB 를 통째로 아낀다. 자세한 건 CLAUDE.md 참고.
        if (!rows.length && totalRows.length) {
            return res.json({ ready: true, archived: true, scope, scopes: scopeKeys, totals, rows: [], updatedAt });
        }

        res.json({
            ready: true,
            scope,
            scopes: scopeKeys,
            totals,
            rows,
            updatedAt
        });
    } catch (e) {
        console.error('[API] 챔피언 통계 실패:', e.message);
        res.status(500).json({ error: '통계를 불러오지 못했습니다.' });
    }
});

// ==========================================
// 챔피언 룬·소환사 주문 빌드
//   통계 탭에서 챔피언 줄을 펼칠 때 그 챔피언 것만 부른다.
//   ★ 통계 응답에 미리 실어 보내지 않는 이유: 164챔피언 x 조합 40여 개면 응답이
//     통째로 몇 배가 되는데, 실제로 펼쳐 보는 건 한두 챔피언이다.
//   집계는 1시간마다 갱신되므로 캐시를 넉넉히 잡아도 안전하다.
// ==========================================
// ==========================================
//  라인 상성 — GET /api/champion-matchups?scope=p:16.16&champ=112
//    빌드와 같은 이유로 표에 미리 안 싣는다 (줄을 펼칠 때만 부른다).
//    한 챔피언의 **모든 라인** 줄을 그대로 내려주고 화면이 라인을 고른다.
// ==========================================
app.get('/api/champion-matchups', async (req, res) => {
    try {
        const champ = Number(req.query.champ);
        const scope = String(req.query.scope || '');
        if (!Number.isFinite(champ) || !scope) {
            return res.status(400).json({ error: '잘못된 요청입니다.' });
        }

        const cacheKey = `matchups_${scope}_${champ}`;
        const hit = myCache.get(cacheKey);
        if (hit) return res.json(hit);

        // ★ 세대 딱지(genM) 세대만 읽는다 (2026-08-31, champion-stats 와 같은 장치)
        const scRowM = await StatScope.findOne({ scope, genM: { $exists: true } }).select('genM').lean();
        const genM = scRowM?.genM || null;
        const rows = await ChampMatchup.find(genM ? { scope, champ, g: genM } : { scope, champ })
            .select('-_id -__v -scope -champ -g').lean();

        // 박제된 패치면 행이 파일에 있다 (champion-builds 와 같은 판별).
        if (!rows.length && !(await ChampMatchup.exists({ scope })) && await StatScope.exists({ scope })) {
            return res.json({ archived: true, scope, champ, rows: [] });
        }

        const payload = { scope, champ, min: MATCHUP_MIN, rows };
        myCache.set(cacheKey, payload, 600);
        res.json(payload);
    } catch (e) {
        console.error('[API] 상성 조회 실패:', e.message);
        res.status(500).json({ error: '상성 통계를 불러오지 못했습니다.' });
    }
});

// ★ 챔피언 x 라인의 일별 추이 (2026-08-26 밤 신설) — lolalytics 의 Win Rate / Pick Rate / Game Count / Ban Rate 그래프.
//   이미 있는 일별 scope(`d:YYYY-MM-DD`, 최근 7일)의 champstats 를 날짜순으로 돌려줄 뿐이라 집계 추가 0.
//   밴은 라인 개념이 없어 pos -1 줄에서, 분모는 statscopes 의 그날 판수.
app.get('/api/champion-trend', async (req, res) => {
    try {
        const champ = Number(req.query.champ);
        const pos = Number(req.query.pos);
        if (!Number.isFinite(champ) || !Number.isFinite(pos)) return res.status(400).json({ error: '잘못된 요청입니다.' });
        const cacheKey = `trend_${champ}_${pos}`;
        const hit = myCache.get(cacheKey);
        if (hit) return res.json(hit);

        const [rowsAll, scopes] = await Promise.all([
            ChampStat.find({ scope: /^d:/, champ, pos: { $in: [pos, -1] } }).select('-_id scope pos games wins bans g').lean(),
            StatScope.find({ scope: /^d:/ }).select('-_id scope games gen').lean()
        ]);
        // ★ 세대 딱지 (2026-08-31): 재집계 중인 날짜 scope 는 두 세대가 겹쳐 있다 — 딱지 세대만 남긴다
        //   (안 거르면 그날 판수가 그래프에서 순간 두 배로 뛴다). 딱지 없는 scope 는 그대로 쓴다.
        const genMap = {};
        scopes.forEach(s => { if (s.gen) genMap[s.scope] = Math.max(genMap[s.scope] || 0, s.gen); });
        const rows = rowsAll.filter(r => !genMap[r.scope] || r.g === genMap[r.scope]);
        const total = {};
        scopes.forEach(s => { total[s.scope] = (total[s.scope] || 0) + s.games; });
        const byDay = {};
        rows.forEach(r => {
            const d = byDay[r.scope] || (byDay[r.scope] = { day: r.scope.slice(2), games: 0, wins: 0, bans: 0, total: total[r.scope] || 0 });
            if (r.pos === pos) { d.games += r.games; d.wins += r.wins; }
            if (r.pos === -1) d.bans += r.bans || 0;
        });
        const days = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
        const payload = { champ, pos, days };
        myCache.set(cacheKey, payload, 600);
        res.json(payload);
    } catch (e) {
        console.error('[API] 추이 조회 실패:', e.message);
        res.status(500).json({ error: '추이를 불러오지 못했습니다.' });
    }
});

// ★ 패치 영향 (2026-09-01, 로드맵 A-3) — 챔피언 하나의 "이번 패치 vs 직전 패치" 합계와 일별 추이.
//   집계 추가 0 — champstats 의 패치 scope 두 개(pos -1 = 챔피언 전체 줄)와 일별 scope 를 읽기만 한다.
//   ★ 일별은 DAILY_KEEP_DAYS(42일)치가 남는다. 직전 패치의 일별이 이미 지워진 구간(16.16 이
//     그렇다)은 days 에 안 나오고, 화면이 그 구간을 패치 평균 점선으로 대신 그린다.
//   ★ 밴은 bans(밴 슬롯 수)를 쓴다 — 통계 탭 화면 기본값과 같은 정의라 숫자가 서로 맞는다.
app.get('/api/patch-impact', async (req, res) => {
    try {
        const champ = Number(req.query.champ);
        if (!Number.isFinite(champ)) return res.status(400).json({ error: '잘못된 요청입니다.' });
        const reqScope = String(req.query.scope || '');

        const cacheKey = `patchimpact_${reqScope}_${champ}`;
        const hit = myCache.get(cacheKey);
        if (hit) return res.json(hit);

        const allScopes = await StatScope.find({}).select('-_id scope games gen').lean();
        // 패치 scope 를 숫자로 내림차순 — 문자열 정렬은 16.9 > 16.16 이 된다 (pickStatScope 와 같은 규칙)
        const patchKeys = [...new Set(allScopes.filter(s => s.scope.startsWith('p:')).map(s => s.scope))]
            .sort((a, b) => {
                const pa = a.slice(2).split('.').map(Number), pb = b.slice(2).split('.').map(Number);
                return (pb[0] - pa[0]) || (pb[1] - pa[1]);
            });
        if (!patchKeys.length) return res.json({ ready: false });
        const scope = patchKeys.includes(reqScope) ? reqScope : patchKeys[0];
        const prevScope = patchKeys[patchKeys.indexOf(scope) + 1] || null;

        // 패치 합계 — pos -1 줄이 챔피언 전체(라인 합 + 라인 판정 실패분)이고 밴도 여기에만 있다
        const aggOf = async (sc) => {
            if (!sc) return null;
            const rows = allScopes.filter(s => s.scope === sc);
            const total = rows.reduce((a, s) => a + s.games, 0);
            const gen = rows.reduce((m, s) => Math.max(m, s.gen || 0), 0) || null;
            const r = await ChampStat.findOne(gen ? { scope: sc, champ, pos: -1, g: gen } : { scope: sc, champ, pos: -1 })
                .select('-_id games wins bans banGames').lean();
            return { scope: sc, total, games: r?.games || 0, wins: r?.wins || 0, bans: r?.bans || 0, banGames: r?.banGames || 0 };
        };
        const [cur, prev] = await Promise.all([aggOf(scope), aggOf(prevScope)]);

        // 일별 — champion-trend 와 같은 골격인데 라인 구분 없이 pos -1 만 본다.
        //   ★ 챔피언 줄이 없는 날도 0 으로 내보낸다 (픽률 0 은 "빈 날" 이 아니라 값이다)
        const [dayRows, dayScopes] = await Promise.all([
            ChampStat.find({ scope: /^d:/, champ, pos: -1 }).select('-_id scope games wins bans g').lean(),
            StatScope.find({ scope: /^d:/ }).select('-_id scope games gen').lean()
        ]);
        // ★ 세대 딱지 — 재집계 중인 날짜 scope 는 두 세대가 겹쳐 있다 (champion-trend 와 같은 장치)
        const genMap = {};
        dayScopes.forEach(s => { if (s.gen) genMap[s.scope] = Math.max(genMap[s.scope] || 0, s.gen); });
        const byDay = {};
        dayScopes.forEach(s => {
            const d = byDay[s.scope] || (byDay[s.scope] = { day: s.scope.slice(2), games: 0, wins: 0, bans: 0, total: 0 });
            d.total += s.games;
        });
        dayRows.filter(r => !genMap[r.scope] || r.g === genMap[r.scope]).forEach(r => {
            const d = byDay[r.scope];
            if (!d) return;
            d.games += r.games; d.wins += r.wins; d.bans += r.bans || 0;
        });
        const days = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));

        const payload = { ready: true, champ, scope, prevScope, patchKeys, cur, prev, days };
        myCache.set(cacheKey, payload, 600);
        res.json(payload);
    } catch (e) {
        console.error('[API] 패치 영향 조회 실패:', e.message);
        res.status(500).json({ error: '패치 영향을 불러오지 못했습니다.' });
    }
});

// ★ 조합 (2026-09-01, 로드맵 A-1) — 아군 두 라인 짝의 승률 (원딜+서폿 · 탑+정글 · 미드+정글).
//   집계 추가 0 — champmatchups 가 2026-08-26 부터 아군 짝(rel 1)도 담는다. 로드맵의
//   "집계 한 종(champduos) 추가" 는 그 확장 전에 적힌 낡은 줄이다.
//   ★ 쌍은 양쪽 관점으로 두 번 저장돼 있다 (원딜→서폿 · 서폿→원딜). **첫 라인 관점(pos=a)만**
//     읽어야 한 쌍이 한 번씩 나온다. 표본 컷은 화면 몫(DUO_SHOW_MIN) — 여기서는 다 내려준다
//     (저장 자체가 MATCHUP_MIN=5판 이상이라 1천 행 안팎이다).
const DUO_COMBOS = { bot: [3, 4], topjg: [0, 1], midjg: [2, 1] };   // [내 라인, 짝 라인]
app.get('/api/champion-duos', async (req, res) => {
    try {
        const comboKey = String(req.query.combo || 'bot');
        const combo = DUO_COMBOS[comboKey];
        if (!combo) return res.status(400).json({ error: '잘못된 요청입니다.' });
        const reqScope = String(req.query.scope || '');

        const cacheKey = `duos_${comboKey}_${reqScope}`;
        const hit = myCache.get(cacheKey);
        if (hit) return res.json(hit);

        const allScopes = await StatScope.find({}).select('-_id scope games genM').lean();
        const patchKeys = [...new Set(allScopes.filter(s => s.scope.startsWith('p:')).map(s => s.scope))]
            .sort((a, b) => {
                const pa = a.slice(2).split('.').map(Number), pb = b.slice(2).split('.').map(Number);
                return (pb[0] - pa[0]) || (pb[1] - pa[1]);
            });
        if (!patchKeys.length) return res.json({ ready: false });
        const scope = patchKeys.includes(reqScope) ? reqScope : patchKeys[0];
        const total = allScopes.filter(s => s.scope === scope).reduce((a, s) => a + s.games, 0);

        // 세대 딱지(genM) — champion-matchups 와 같은 장치
        const genM = allScopes.filter(s => s.scope === scope).reduce((m, s) => Math.max(m, s.genM || 0), 0) || null;
        const cond = { scope, pos: combo[0], fpos: combo[1], rel: 1 };
        if (genM) cond.g = genM;
        const rows = await ChampMatchup.find(cond).select('-_id champ foe games wins').lean();

        const payload = { ready: true, combo: comboKey, scope, scopes: patchKeys, total, rows };
        myCache.set(cacheKey, payload, 600);
        res.json(payload);
    } catch (e) {
        console.error('[API] 조합 조회 실패:', e.message);
        res.status(500).json({ error: '조합 통계를 불러오지 못했습니다.' });
    }
});

// ★ 라인별 일자별 픽률 (2026-09-01) — 한 라인의 모든 챔피언 x 일별 판수.
//   일별 champstats(보관 42일)를 라인 하나로 읽기만 한다. 픽률 계산(games/total)은 화면이 한다.
app.get('/api/lane-trend', async (req, res) => {
    try {
        const pos = Number(req.query.pos);
        if (!Number.isInteger(pos) || pos < 0 || pos > 4) return res.status(400).json({ error: '잘못된 요청입니다.' });

        const cacheKey = `lanetrend_${pos}`;
        const hit = myCache.get(cacheKey);
        if (hit) return res.json(hit);

        const [rowsAll, dayScopes] = await Promise.all([
            ChampStat.find({ scope: /^d:/, pos }).select('-_id scope champ games g').lean(),
            StatScope.find({ scope: /^d:/ }).select('-_id scope games gen').lean()
        ]);
        // 세대 딱지 — 재집계 중인 날짜 scope 는 두 세대가 겹쳐 있다 (champion-trend 와 같은 장치)
        const genMap = {};
        dayScopes.forEach(s => { if (s.gen) genMap[s.scope] = Math.max(genMap[s.scope] || 0, s.gen); });

        const dayTotals = {};
        dayScopes.forEach(s => { dayTotals[s.scope] = (dayTotals[s.scope] || 0) + s.games; });
        const days = Object.keys(dayTotals).sort().map(sc => ({ day: sc.slice(2), total: dayTotals[sc] }));
        const dayIdx = {};
        days.forEach((d, i) => { dayIdx['d:' + d.day] = i; });

        // 챔피언별로 날짜 축에 맞춘 판수 배열 (빈 날은 0 — 픽률 0 은 값이지 빈칸이 아니다)
        const byChamp = {};
        rowsAll.filter(r => !genMap[r.scope] || r.g === genMap[r.scope]).forEach(r => {
            const i = dayIdx[r.scope];
            if (i === undefined) return;
            (byChamp[r.champ] || (byChamp[r.champ] = new Array(days.length).fill(0)))[i] += r.games;
        });
        const rows = Object.entries(byChamp).map(([c, g]) => ({ c: Number(c), g }));

        const payload = { ready: true, pos, days, rows };
        myCache.set(cacheKey, payload, 600);
        res.json(payload);
    } catch (e) {
        console.error('[API] 라인 추이 조회 실패:', e.message);
        res.status(500).json({ error: '라인 추이를 불러오지 못했습니다.' });
    }
});

app.get('/api/champion-builds', async (req, res) => {
    try {
        const champ = Number(req.query.champ);
        const scope = String(req.query.scope || '');
        if (!Number.isFinite(champ) || !scope) {
            return res.status(400).json({ error: '잘못된 요청입니다.' });
        }

        const cacheKey = `builds_${scope}_${champ}`;
        const hit = myCache.get(cacheKey);
        if (hit) return res.json(hit);

        // ★ 세대 딱지(genB) 세대만 읽는다 (2026-08-31, champion-stats 와 같은 장치)
        const scRowB = await StatScope.findOne({ scope, genB: { $exists: true } }).select('genB').lean();
        const genB = scRowB?.genB || null;
        const rows = await ChampBuild.find(genB ? { scope, champ, g: genB } : { scope, champ }).select('-_id -__v -scope -champ -g').lean();

        // ★ 박제된 패치면 행이 파일에 있다. 화면은 표를 그릴 때 이미 그 파일을 받아 뒀으므로
        //   원래 여기까지 오지도 않는데, 옛 화면이 부를 수 있으니 표식을 돌려준다.
        if (!rows.length && !(await ChampBuild.exists({ scope })) && await StatScope.exists({ scope })) {
            return res.json({ archived: true, scope, champ, total: 0, wins: 0, rows: [] });
        }

        // "all" 줄이 픽률의 분모다. 없으면 아직 집계 전이다.
        //   ★ 라인마다 따로 있다 (`-1` 이 라인 무관 전체). 화면이 켜 둔 라인에 맞춰 고른다.
        //   ★ `total`/`wins` 는 전체(-1) 값을 그대로 둔다 — 옛 화면이 그 이름을 읽는다.
        const totals = {}, totalWins = {};
        rows.filter(r => r.type === 'all').forEach(r => {
            const pos = r.pos == null ? -1 : r.pos;
            totals[pos] = r.games;
            totalWins[pos] = r.wins;
        });
        // ★★ 줄은 있는데 `all` 이 하나도 없으면 **재집계 중에 읽은 것**이다 (위 flushStatCaches 주석).
        //   그 부분 결과를 캐시에 넣으면 10분 동안 그 챔피언만 "표본이 없습니다" 가 된다.
        //   ★ 표본이 진짜 0 인 챔피언과는 갈린다 — 그쪽은 `rows` 자체가 비어 있다.
        const rebuilding = rows.length > 0 && !rows.some(r => r.type === 'all');

        const payload = {
            scope,
            champ,
            total: totals[-1] || 0,
            wins: totalWins[-1] || 0,
            totals,
            totalWins,
            rebuilding: rebuilding || undefined,
            rows: rows.filter(r => r.type !== 'all')
        };
        if (!rebuilding) myCache.set(cacheKey, payload, 600);
        res.json(payload);
    } catch (e) {
        console.error('[API] 룬 빌드 실패:', e.message);
        res.status(500).json({ error: '룬 통계를 불러오지 못했습니다.' });
    }
});

// ==========================================
//  vs 맞대결 빌드 — GET /api/versus-build?a=64&b=104&pos=1&fpos=1&rel=0&scope=p:16.17
//    (2026-09-02 신설, 로드맵 A-2 확장 — 사용자 요청 "정글 리신이 정글 그레이브즈를 만났을 때
//     아이템·스킬빌드·룬 통계가 어떻게 바뀌나")
//
//   ★★ 이건 **집계에 없는 자료다.** `champbuilds` 는 (챔피언 × 라인 × 빌드)로만 뭉쳐 있어서
//     "상대가 누구였는지" 가 아예 안 담긴다. 미리 집계하려면 (챔피언 × 상대 × 라인쌍 × 빌드) 라
//     행이 폭발한다 — 16.17 기준 관계만 72,646개다. 그래서 **원본(matchstats)에서 그때그때 센다.**
//
//   ★★★ **집계 함수를 그대로 쓴다** (`buildOneBuildScope` 에 `pick`·`returnDocs`·`timeline` 을 넘긴다).
//     응답이 `/api/champion-builds` 와 **완전히 같은 모양**(rows/totals)이라, 화면은 통계 상세와
//     **같은 컴포넌트**(lxLowerRows·lxSkillBox·lxRuneBox)를 그대로 그린다 — 룬 페이지·시작 아이템·
//     초반 아이템·세트·신발·1~5번째 아이템·스킬 순서까지 **한 칸도 빠지지 않는다.**
//     예전에 vs 전용 표를 따로 만들었다가 "양식이 다르고 데이터가 잘린다" 는 지적을 받았다.
//
//   ★ 판 고르기는 `$expr` 한 덩어리다 — 나(a,pos)와 상대(b,fpos)가 같은 판에 있고 팀 관계가 `rel`
//     인 판. **미러전 가드**로 상대 자리에서 내 자리를 뺀다(`$ne`), 안 그러면 같은 사람을 둘로 센다.
//   ★ 실측 1.1초 안팎 (16.17 · 21,770판, 타임라인 facet 포함). 30분 캐시라 다시 열면 즉시 나온다.
// ★★ 이 라우트만 요청 시점에 원본(matchstats)을 전수 스캔한다 (2026-09-03 감사 H-1).
//   `$expr`+`$filter` 는 인덱스를 못 타서 실측 1.3초고, /api/champion-* 은 전부 집계본을 읽기만 한다.
//   그래서 세 겹으로 막는다 — ① 입력을 정수·범위·실제 챔피언(그 scope 의 champstats 에 있는 id)으로
//   거른다 (`a=1.5`·`a=99999` 가 전부 다른 캐시 키가 되어 매번 스캔하던 것) ② 전용 리미터
//   ③ 같은 키가 동시에 오면 계산을 한 번만 하고 결과를 나눠 준다 (in-flight 맵)
const versusLimiter = rateLimit({
    windowMs: 60 * 1000,
    // ★ 캐시 적중도 한 회로 센다 (리미터가 핸들러보다 앞이다). 관계 칩·⇄ 를 몇 번 누르는 게 정상 사용이라
    //   계획의 "5회쯤" 보다 넉넉히 잡았다. 미스 한 번이 1.3초짜리라 12회여도 DB 에는 충분한 상한이다
    max: Number(process.env.VERSUS_RATE_MAX) || 12,
    keyGenerator: (req) => ipKeyGenerator(req.headers['cf-connecting-ip'] || req.ip),
    message: { error: '맞대결 빌드 조회가 너무 잦습니다. 잠시 후 다시 시도해주세요.' }
});
const versusInflight = new Map();   // cacheKey -> Promise<payload>

// 그 scope 에 집계 줄이 있는 챔피언 id 집합 (10분 캐시). 없는 id 는 어차피 결과가 0건이라 스캔할 이유가 없다
async function champIdSetOf(scope) {
    const k = `champids_${scope}`;
    let s = myCache.get(k);
    if (s) return s;
    const ids = await ChampStat.distinct('champ', { scope });
    s = new Set(ids);
    if (s.size) myCache.set(k, s, 600);
    return s;
}

app.get('/api/versus-build', versusLimiter, async (req, res) => {
    try {
        const a = Number(req.query.a), b = Number(req.query.b);
        const pos = Number(req.query.pos), fpos = Number(req.query.fpos);
        const rel = Number(req.query.rel) === 1 ? 1 : 0;
        const okInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
        if (!okInt(a, 1, 4000) || !okInt(b, 1, 4000) || !okInt(pos, 0, 4) || !okInt(fpos, 0, 4)) {
            return res.status(400).json({ error: '잘못된 요청입니다.' });
        }

        const scopes = await StatScope.find({}).lean();
        if (!scopes.length) return res.json({ ready: false, total: 0, rows: [] });
        const { scope } = pickStatScope(scopes, req.query.scope);
        if (!scope.startsWith('p:')) return res.json({ ready: false, total: 0, rows: [], scope });

        const cacheKey = `versusbuild_${scope}_${a}_${b}_${pos}_${fpos}_${rel}`;
        const hit = myCache.get(cacheKey);
        if (hit) return res.json(hit);

        const known = await champIdSetOf(scope);
        if (known.size && (!known.has(a) || !known.has(b))) {
            return res.status(400).json({ error: '없는 챔피언입니다.' });
        }

        if (versusInflight.has(cacheKey)) return res.json(await versusInflight.get(cacheKey));
        const job = computeVersusBuild({ scope, a, b, pos, fpos, rel, cacheKey });
        versusInflight.set(cacheKey, job);
        try { res.json(await job); }
        finally { versusInflight.delete(cacheKey); }
    } catch (e) {
        console.error('[API] vs 빌드 실패:', e.message);
        res.status(500).json({ error: '맞대결 빌드를 불러오지 못했습니다.' });
    }
});

async function computeVersusBuild({ scope, a, b, pos, fpos, rel, cacheKey }) {
    {

        const at = (arr, i) => ({ $arrayElemAt: [arr, i] });
        const P = (i, j) => at(at('$p', i), j);
        // 두 챔피언이 그 라인 짝으로 같은 판에 있었나 (rel 0 적 · 1 아군)
        const cond = {
            v: scope.slice(2),
            $expr: { $let: {
                vars: { mi: { $filter: { input: { $range: [0, 10] }, as: 'i',
                    cond: { $and: [{ $eq: [P('$$i', 0), a] }, { $eq: [P('$$i', 1), pos] }] } } } },
                in: { $let: {
                    vars: { i: at('$$mi', 0) },
                    in: { $and: [
                        { $gt: [{ $size: '$$mi' }, 0] },
                        { $gt: [{ $size: { $filter: { input: { $range: [0, 10] }, as: 'k',
                            cond: { $and: [
                                { $ne: ['$$k', '$$i'] },                       // ★ 미러전 가드
                                { $eq: [P('$$k', 0), b] }, { $eq: [P('$$k', 1), fpos] },
                                rel === 1 ? { $eq: [P('$$k', 3), P('$$i', 3)] } : { $ne: [P('$$k', 3), P('$$i', 3)] }
                            ] } } } }, 0] }
                    ] }
                } }
            } }
        };

        // ★ 집계 함수를 그대로 태운다 — 나온 줄이 champbuilds 와 같은 모양이다
        const docs = await buildOneBuildScope('vs', cond, {
            pick: { c: a, pos }, returnDocs: true, timeline: patchAtLeast(scope.slice(2), TL_MIN_PATCH)
        });

        // `/api/champion-builds` 와 같은 응답 모양으로 (화면이 같은 코드로 읽는다)
        const totals = {}, totalWins = {};
        docs.filter(d => d.type === 'all').forEach(d => { totals[d.pos] = d.games; totalWins[d.pos] = d.wins; });
        const payload = {
            ready: true, scope, a, b, pos, fpos, rel,
            champ: a,
            total: totals[pos] || 0,
            wins: totalWins[pos] || 0,
            totals, totalWins,
            rows: docs.filter(d => d.type !== 'all')
                .map(d => ({ pos: d.pos, type: d.type, key: d.key, games: d.games, wins: d.wins }))
        };
        myCache.set(cacheKey, payload, 1800);
        return payload;
    }
}

// ==========================================
// 도감 채택률 — 주문(2026-08-26) · 아이템·룬(2026-09-01)
//
//   ★★ `champbuilds` 를 **"이걸 누가 드나" 로 뒤집기만 한다.** 통계 탭은 "이 챔피언이 뭘 드나"
//     (챔피언 → 항목)인데 도감은 반대다. **수집·집계에 더한 게 없고** 이미 있는 줄을 다르게
//     세는 것이라 지난 원본도 그대로 소급된다.
//
//   ★ 분모는 `type:'all'` 의 합, 즉 **"챔피언 픽 합계(명)"** 다. 경기 수가 아니다 —
//     한 사람이 주문 2개·룬 6개·파편 3개를 드니 **채택률 합이 200% · 600% · 300%** 가 된다.
//     실측(16.17): 주문 점멸 97.4% · 강타 20.0%(팀당 정글러 1명) / **룬 합계가 정확히 600.0%** /
//     파편은 줄마다 100%. 값이 맞다는 방증으로 쓸 수 있는 숫자들이다.
//
//   ★★ 아이템만 뜻이 다르다 — `type:'item'` 은 **경기가 끝났을 때 6칸에 남아 있던** 아이템이라
//     "최종 아이템에 남은 비율" 이다. 그래서 롱소드가 12.3% 다 (미완성으로 끝난 판).
//     합계는 522.7% (사람당 5개꼴). **화면이 그 뜻을 한 줄로 적는다** — 안 적으면 기본 재료에
//     값이 있는 게 오류처럼 보인다.
//
//   ★★ 아이템은 2026-09-01 에 `ITEM_TOP_N`(챔피언당 상위 15개) 컷을 폐지하고서야 정확해졌다.
//     그전에 뒤집으면 **채택률 합계 418.5%(실제 522.7%)** 였고 챔피언 TOP5 는 208개 중 108개만
//     맞았다 (27개는 목록이 통째로 비었다). 챔피언당 고유 아이템이 중앙값 78개인데 15개만
//     저장돼서, **채택률 9.5% 아래가 통째로 없었다.** 룬(perk)은 원래 안 잘려서 정확했다.
//
//   ★ `champs` 는 **그 챔피언 판수 대비 채택률** 순이다 (판수 순이 아니다).
//     판수 순으로 하면 인기 챔피언만 나와서 "강타 = 리 신·그레이브즈" 처럼 뻔해진다.
//     비율 순이면 "헤카림 100% · 릴리아 100%" 처럼 **그걸 반드시 드는 챔피언**이 나온다.
//   ★ 표본이 적으면 비율이 튄다 — `USAGE_CHAMP_MIN` 판 미만은 뺀다.
const USAGE_CHAMP_MIN = 30;   // 챔피언 top 목록에 들 최소 표본
const USAGE_CHAMP_TOP = 5;    // ★ 화면 문구가 "채택률 TOP5" 라 다섯이다 — 문구와 짝이라 한쪽만 고치면 어긋난다

// type 하나를 뒤집어 응답을 만든다. `keyOf` 가 **한 줄이 기여하는 항목 키**를 준다 —
// 주문은 조합 2개를 펼치고, 아이템·룬은 낱개 하나, 파편만 `id:줄` 이다.
async function usagePayload(reqScope, type, field, keyOf) {
    const scopes = await StatScope.find({}).lean();
    if (!scopes.length) return { ready: false, [field]: {} };

    const { scope } = pickStatScope(scopes, reqScope);
    const cacheKey = `usage_${type}_${scope}`;
    const hit = myCache.get(cacheKey);
    if (hit) return hit;

    // ★ pos 를 조건에서 빼고 통째로 받는다 — `-1`(라인 무관 전체)과 `0~4`(라인별)를
    //   한 번에 세려는 것이다. 행 수가 얼마 안 돼서 두 번 조회할 이유가 없다.
    // ★ 세대 딱지(genB) 세대만 읽는다 (2026-08-31) — scopes 를 이미 통째로 받아 둬서 추가 조회 0
    const genB = scopes.filter(s => s.scope === scope).reduce((m, s) => Math.max(m, s.genB || 0), 0) || null;
    const gq = genB ? { g: genB } : {};
    const [rows, allRows] = await Promise.all([
        ChampBuild.find({ scope, type, ...gq }).select('-_id champ pos key games wins').lean(),
        ChampBuild.find({ scope, type: 'all', ...gq }).select('-_id champ pos games').lean()
    ]);

    // 박제된 패치는 champbuilds 행이 없다 (champion-builds 와 같은 판별)
    if (!rows.length) return { ready: false, scope, [field]: {}, picks: 0 };

    // ★ 분모는 두 벌이다 — 전체(-1)와 라인별(0~4).
    //   **라인별 분모를 전체로 쓰면 안 된다** — 탑 픽은 전체의 5분의 1쯤이라
    //   "탑에서 순간이동 89%" 가 18% 로 찌그러진다.
    const totalByChamp = {};      // 전체(-1) 기준 챔피언별 판수 — champs top 의 분모
    const picksByPos = {};        // 라인별 픽 합계 — 라인 채택률의 분모
    allRows.forEach(r => {
        const pos = r.pos == null ? -1 : r.pos;
        if (pos === -1) totalByChamp[r.champ] = r.games;
        picksByPos[pos] = (picksByPos[pos] || 0) + r.games;
    });
    const picks = picksByPos[-1] || 0;

    const agg = {};
    rows.forEach(r => {
        const pos = r.pos == null ? -1 : r.pos;
        keyOf(r).forEach(k => {
            const s = agg[k] || (agg[k] = { games: 0, wins: 0, byChamp: {}, byPos: {} });
            s.byPos[pos] = (s.byPos[pos] || 0) + r.games;
            if (pos !== -1) return;          // 아래 합계·챔피언 top 은 전체 기준이다
            s.games += r.games;
            s.wins += r.wins;
            s.byChamp[r.champ] = (s.byChamp[r.champ] || 0) + r.games;
        });
    });

    const entries = {};
    Object.entries(agg).forEach(([k, s]) => {
        // 라인별 채택률. 그 라인 픽이 없으면 칸을 안 만든다
        const pos = {};
        for (let p = 0; p <= 4; p++) {
            if (!picksByPos[p]) continue;
            pos[p] = Math.round((s.byPos[p] || 0) / picksByPos[p] * 1000) / 1000;
        }
        entries[k] = {
            games: s.games,
            wins: s.wins,
            pos,
            champs: Object.entries(s.byChamp)
                .filter(([c]) => (totalByChamp[c] || 0) >= USAGE_CHAMP_MIN)
                .map(([c, g]) => ({ c: Number(c), g, r: g / totalByChamp[c] }))
                .sort((a, b) => b.r - a.r || b.g - a.g)
                .slice(0, USAGE_CHAMP_TOP)
                .map(x => ({ c: x.c, r: Math.round(x.r * 1000) / 1000 }))
        };
    });

    const payload = { ready: true, scope, picks, picksByPos, [field]: entries };
    myCache.set(cacheKey, payload, 1800);   // 집계가 매시간이라 30분
    return payload;
}

// 세 라우트가 같은 함수를 탄다. **응답 필드 이름만 다르다** — 옛 화면이 `spells` 를 읽는다.
const usageRoute = (path, type, field, keyOf) => app.get(path, async (req, res) => {
    try {
        res.json(await usagePayload(req.query.scope, type, field, keyOf));
    } catch (e) {
        console.error(`[API] ${type} 채택률 실패:`, e.message);
        res.status(500).json({ error: '채택률을 불러오지 못했습니다.' });
    }
});

usageRoute('/api/spell-usage', 'spell', 'spells', r => (r.key || []).map(String));
usageRoute('/api/item-usage', 'item', 'items', r => [String(r.key[0])]);
// ★★ 파편만 `id:줄` 이다 (2026-09-01) — 적응형 능력치(5008)가 1·2줄 두 자리에 있어서 id 로만
//   세면 한 사람이 두 번 더해져 **115.6%** 가 나온다. 줄을 붙이면 줄마다 합이 딱 100% 다
//   (집계가 이미 `[id, 줄]` 로 담고 있다 — 2026-08-27 의 그 수정).
usageRoute('/api/rune-usage', 'perk', 'runes', r => [r.key.length > 1 ? `${r.key[0]}:${r.key[1]}` : String(r.key[0])]);

// ==========================================
// 신화급 상점 (2026-08-16 신설)
//   POST 는 로컬 수집기가 보내는 곳이고, GET 셋은 화면이 읽는 곳이다.
//   명세: mythic-collector/SERVER_SPEC.md
// ==========================================

// UTC 기준 날짜. 로테이션이 00:00 UTC 갱신이라 이게 곧 로테이션 ID 다.
//   ★ 한국시간 날짜(kstDay)와 헷갈리지 말 것 — 오전 9시 전에는 하루 차이가 난다.
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// ★ 토큰 비교는 길이가 새지 않게 한다. 양쪽을 sha256 으로 눌러 길이를 맞춘 뒤
//   timingSafeEqual 을 쓴다 (길이가 다르면 그 함수가 예외를 던진다).
//   ★★ 실패 이유를 셋으로 갈라서 돌려준다 (2026-08-16). 전부 401 로 뭉뚱그렸더니
//     프로덕션에서 401 이 났을 때 **"서버에 토큰이 없다 / 헤더가 안 왔다 / 값이 다르다"**
//     를 구분할 수가 없었다. 셋 다 원인도 고칠 곳도 다르다.
//     값 자체는 안 흘린다 — 맞았는지 여부는 어차피 201/401 로 이미 드러난다.
function checkCollectorToken(req) {
    const expected = process.env.COLLECTOR_TOKEN || '';
    const got = req.get('X-Collector-Token') || '';

    if (!expected) return 'server_token_missing';   // 서버(Railway) 환경변수가 비었다
    if (!got) return 'header_missing';              // 헤더가 안 왔다 (프록시가 지웠을 수도)

    const a = crypto.createHash('sha256').update(expected).digest();
    const b = crypto.createHash('sha256').update(got).digest();
    return crypto.timingSafeEqual(a, b) ? null : 'token_mismatch';
}

// ★★ 수집기를 믿지 않는다. 화면을 잘못 읽을 수도 있고 토큰이 새면 아무나 보낼 수 있다.
//   틀린 값이 조용히 들어가는 게 이 기능에서 가장 나쁜 결과라 서버에서 다시 본다.
// ★ 일일 구획의 타입↔가격 짝. **2026-08-27 에 와드(50)가 실제로 떴다** (전투사관학교 책상 와드) — 8/16 "일일은 아이콘·감정표현뿐"
//   이 반만 맞았다. 스킨·크로마는 여전히 안 뜬다. 수집기(`mythic-collector/신화상점_일일와드_20260827.md`) 요청으로 열었다.
const MYTHIC_PRICE = { icon: 5, emote: 25, ward: 50 };
const MYTHIC_IMAGE_PREFIX = 'https://raw.communitydragon.org/';

// ★★ 구획 4개 (2026-08-17). 인게임 상점 탭 그대로다.
//   `daily` 만 규칙이 다르다 — 아래 검증과 SECTION_PERIOD 참고.
const MYTHIC_SECTIONS = ['featured', 'biweekly', 'weekly', 'daily'];

// 그 구획이 몇 일마다 갈리나. **"마지막 수집이 오래됐다" 를 판정하는 데만 쓴다** —
//   일일은 오늘 것이 아니면 곧바로 낡은 것이고, 주간은 7일까지는 그대로다.
const MYTHIC_SECTION_PERIOD = { featured: 14, biweekly: 14, weekly: 7, daily: 0 };

// 일일 밖에서 파는 것들. **일일 구획에는 icon/emote/ward(MYTHIC_PRICE 의 키)만 받는다** —
//   그 규칙이 지금까지 오독을 잡아 왔다. 일일에 스킨·크로마가 뜨는 일은 없고, **와드는 2026-08-27 에 실제로 떴다.**
const MYTHIC_TYPES = ['icon', 'emote', 'skin', 'chroma', 'ward', 'border', 'bundle', 'other'];

// 신화 정수 가격 상한. 프레스티지 125 · 신화 스킨 150 · 크로마 40 근처라 넉넉하다.
//   ★ 이 상한은 **RP 가격을 잘못 읽어 오는 것**을 잡으려고 둔 것이다 (1350 같은 값).
//     정상인데 막히는 게 나오면 여기부터 올릴 것.
const MYTHIC_PRICE_MAX = 1000;

function validateMythicBody(body) {
    if (!body || typeof body !== 'object') return '본문이 없습니다.';

    const date = body.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return 'date 는 YYYY-MM-DD 여야 합니다.';
    }
    // 미래 날짜 금지. 수집기 시계가 틀어졌거나 장난이다.
    if (date > utcDay()) return `date 가 미래입니다 (오늘 UTC ${utcDay()}).`;

    // ★ 안 보내면 daily 다. 구획이 생기기 전 수집기가 그대로 동작해야 한다.
    const section = body.section == null || body.section === '' ? 'daily' : body.section;
    if (!MYTHIC_SECTIONS.includes(section)) {
        return `section 은 ${MYTHIC_SECTIONS.join(' / ')} 중 하나여야 합니다 (받은 값: ${String(section).slice(0, 40)}).`;
    }
    const isDaily = section === 'daily';

    // 일일은 예전대로 12개까지. 나머지 구획은 스킨·크로마가 섞여 더 길 수 있다.
    const maxItems = isDaily ? 12 : 30;
    const items = body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > maxItems) {
        return `items 는 1개 이상 ${maxItems}개 이하의 배열이어야 합니다 (${section}).`;
    }

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const at = `items[${i}]`;
        if (!it || typeof it !== 'object') return `${at} 가 객체가 아닙니다.`;

        if (typeof it.name !== 'string' || !it.name.trim() || it.name.length > 200) {
            return `${at}.name 은 1~200자 문자열이어야 합니다.`;
        }

        if (isDaily) {
            // ── 일일: 예전 규칙 그대로. 타입 2종 + 가격 고정 + 둘의 짝까지 본다.
            // ★ 타입·가격 목록은 MYTHIC_PRICE 한 표에서 온다 (2026-08-27 와드 50 추가) — 셋을 따로 적으면 어긋난다
            if (!Object.prototype.hasOwnProperty.call(MYTHIC_PRICE, it.type)) {
                return `${at}.type 은 ${Object.keys(MYTHIC_PRICE).join(' / ')} 중 하나여야 합니다 (일일 구획).`;
            }
            if (!Object.values(MYTHIC_PRICE).includes(it.price)) {
                return `${at}.price 는 ${Object.values(MYTHIC_PRICE).join(' / ')} 중 하나여야 합니다 (일일 구획).`;
            }
            // 타입과 가격이 어긋나면 화면을 잘못 읽은 것이다 (아이콘 5 / 감정표현 25 고정)
            if (MYTHIC_PRICE[it.type] !== it.price) {
                return `${at} 는 ${it.type} 인데 가격이 ${it.price} 입니다 (${MYTHIC_PRICE[it.type]} 이어야 함).`;
            }
        } else {
            // ── 나머지 구획: 값이 제각각이라 짝은 못 본다. 대신 범위와 정수 여부를 본다.
            //   ★ 타입을 모르겠으면 'other' 로 보내면 통과한다. **막아서 그날 데이터를
            //     통째로 잃는 것보다 받아 두고 나중에 고치는 게 낫다** — 수집이 반자동이라
            //     한 번 거절당하면 사람이 다시 상점을 열어야 한다. 서버가 경고를 찍는다.
            if (typeof it.type !== 'string' || !MYTHIC_TYPES.includes(it.type)) {
                return `${at}.type 은 ${MYTHIC_TYPES.join(' / ')} 중 하나여야 합니다 (받은 값: ${String(it.type).slice(0, 40)}).`;
            }
            if (!Number.isInteger(it.price) || it.price < 1 || it.price > MYTHIC_PRICE_MAX) {
                return `${at}.price 는 1~${MYTHIC_PRICE_MAX} 사이 정수여야 합니다 (신화 정수 가격, 받은 값: ${it.price}).`;
            }
        }
        // ★ 이미지 출처를 고정한다. 토큰이 샜을 때 임의의 URL 을 프론트에 심는 걸 막는다 —
        //   이 값은 그대로 <img src> 로 들어간다.
        if (it.image != null && it.image !== '') {
            if (typeof it.image !== 'string' || !it.image.startsWith(MYTHIC_IMAGE_PREFIX)) {
                return `${at}.image 는 ${MYTHIC_IMAGE_PREFIX} 로 시작해야 합니다.`;
            }
        }
        if (it.catalog_id != null && typeof it.catalog_id !== 'string' && typeof it.catalog_id !== 'number') {
            return `${at}.catalog_id 가 문자열이 아닙니다.`;
        }
    }
    return null;
}

// 수집기 본문(snake_case) → 저장 형태(camelCase)
const toMythicItems = (items) => items.map(it => ({
    name: it.name.trim(),
    type: it.type,
    price: it.price,
    catalogId: it.catalog_id != null ? String(it.catalog_id) : undefined,
    image: it.image || undefined,
    score: typeof it.score === 'number' ? it.score : undefined
}));

// ★ 같은 날짜인지 비교할 때는 name/type/price 만 본다.
//   score 와 collected_at 은 같은 화면을 두 번 읽어도 달라질 수 있어서 뺀다.
const mythicFingerprint = (items) =>
    JSON.stringify(items.map(i => [i.name, i.type, i.price]));

// 화면이 읽는 캐시를 지운다. 갱신 직후에 옛 값이 남으면 안 된다.
const clearMythicCache = (date) => {
    myCache.del('mythic_today');
    myCache.del(`mythic_day_${date}`);
    myCache.keys().filter(k => k.startsWith('mythic_')).forEach(k => myCache.del(k));
};

// 수집기 전용 제한. 하루 몇 번이면 충분하다 (/api/ 의 30회/분보다 좁게).
//   ★ 로컬에서 검증 규칙을 한 줄씩 눌러 보려면 30번 넘게 쏴야 해서 막힌다.
//     `COLLECTOR_RATE_MAX=1000` 으로 띄우면 풀린다. **프로덕션에는 넣지 말 것.**
const collectorLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.COLLECTOR_RATE_MAX) || 10,
    keyGenerator: (req) => ipKeyGenerator(req.headers['cf-connecting-ip'] || req.ip),
    message: { ok: false, reason: 'rate_limited' }
});

// ── 수집기가 보내는 곳
//   ★ express.json 을 전역이 아니라 이 경로에만 건다. 서버에 쓰기 엔드포인트가 여기
//     하나뿐이라 다른 경로에서 본문을 파싱할 이유가 없다.
app.post('/api/mythic-shop', collectorLimiter, express.json({ limit: '64kb' }), async (req, res) => {
    const authFail = checkCollectorToken(req);
    if (authFail) {
        console.warn(`[Mythic] 인증 실패: ${authFail}`);
        return res.status(401).json({ ok: false, reason: 'unauthorized', detail: authFail });
    }

    const bad = validateMythicBody(req.body);
    if (bad) {
        console.warn('[Mythic] 검증 실패:', bad);
        return res.status(400).json({ ok: false, reason: 'invalid', message: bad });
    }

    const date = req.body.date;
    // ★ 안 보내면 daily 다 (구획이 생기기 전 수집기와 그대로 호환된다)
    const section = req.body.section == null || req.body.section === '' ? 'daily' : req.body.section;
    const items = toMythicItems(req.body.items);
    const collectedAt = req.body.collected_at ? new Date(req.body.collected_at) : new Date();
    const force = req.query.force === '1';

    // 'other' 로 온 건 통과시키되 흔적을 남긴다. 쌓이면 MYTHIC_TYPES 에 진짜 이름을 더한다.
    const unknown = items.filter(i => i.type === 'other');
    if (unknown.length) {
        console.warn(`[Mythic] ${date}/${section} type=other ${unknown.length}건: ${unknown.map(i => i.name).join(', ')}`);
    }

    try {
        const existing = await MythicShop.findOne({ date, section }).lean();

        if (!existing) {
            await MythicShop.create({
                date, section, collectedAt: isNaN(+collectedAt) ? new Date() : collectedAt,
                items, collectorVersion: req.body.collector_version
            });
            clearMythicCache(date);
            console.log(`[Mythic] ${date}/${section} 저장 (${items.length}개)`);
            return res.status(201).json({ ok: true, created: true, date, section, count: items.length });
        }

        // ★★ 조용히 덮어쓰지 않는다. 같은 날짜·같은 구획에 다른 내용이 온다는 건 둘 중 하나가
        //   틀렸다는 뜻이라 사람이 봐야 한다. 수집기는 409 를 받으면 재시도하지 않는다.
        //   ★ 주간·격주는 며칠 동안 내용이 같으므로 **날짜가 다르면 충돌이 아니다** —
        //     같은 내용이 날짜별로 하나씩 쌓인다 (한 건 200B 라 그대로 둔다).
        if (mythicFingerprint(existing.items) === mythicFingerprint(items)) {
            return res.json({ ok: true, created: false, date, section, count: items.length });
        }

        if (!force) {
            console.warn(`[Mythic] ${date}/${section} 충돌 — 기존 ${existing.items.length}개 vs 새 ${items.length}개`);
            return res.status(409).json({
                ok: false, reason: 'conflict', date, section,
                existing: existing.items, incoming: items
            });
        }

        await MythicShop.updateOne({ date, section }, {
            $set: {
                collectedAt: isNaN(+collectedAt) ? new Date() : collectedAt,
                items, collectorVersion: req.body.collector_version
            }
        });
        clearMythicCache(date);
        console.log(`[Mythic] ${date}/${section} 강제 덮어쓰기 (${items.length}개)`);
        return res.json({ ok: true, created: false, overwritten: true, date, section, count: items.length });

    } catch (e) {
        // unique 인덱스 충돌 — 같은 순간에 두 번 들어온 경우다
        if (e.code === 11000) {
            return res.status(409).json({ ok: false, reason: 'conflict', date, section });
        }
        console.error('[Mythic] 저장 실패:', e.message);
        return res.status(500).json({ ok: false, reason: 'server_error' });
    }
});

// ── 오늘(UTC) 로테이션
//   ★ 없을 때 404 가 아니라 200 + items: null 로 준다. 404 로 주면 화면에서
//     "아직 수집 전" 과 "서버 오류" 를 구분할 수 없다.
app.get('/api/mythic-shop/today', async (req, res) => {
    try {
        const hit = myCache.get('mythic_today');
        if (hit) return res.json(hit);

        const date = utcDay();
        // ★ 일일 구획만 본다. 2026-08-17에 구획이 넷으로 늘어서, 안 걸면 같은 날짜의
        //   주간 문서가 걸려 **첫 화면 위젯에 스킨이 뜬다.**
        const doc = await MythicShop.findOne({ date, section: 'daily' }).select('-_id -__v -createdAt').lean();
        const payload = doc
            ? { ok: true, date, section: 'daily', collectedAt: doc.collectedAt, items: doc.items }
            : { ok: true, date, section: 'daily', collectedAt: null, items: null };

        // 하루 한 번 바뀌는 데이터지만 갱신 직후 옛 값이 남으면 안 되니 짧게 둔다.
        // (POST 가 성공하면 clearMythicCache 가 어차피 지운다)
        myCache.set('mythic_today', payload, 60);
        res.json(payload);
    } catch (e) {
        console.error('[Mythic] today 실패:', e.message);
        res.status(500).json({ ok: false, reason: 'server_error' });
    }
});

// ── 구획 하나의 **가장 최근** 로테이션 (2026-08-17 신설)
//   ★★ "오늘 것" 이 아니라 "마지막으로 수집한 것" 이다. 주간·격주·추천은 며칠씩 그대로라
//     오늘 날짜로 찾으면 수집한 날이 아닌 이상 늘 빈손이 된다.
//   ★ 대신 **얼마나 묵었는지(ageDays)와 낡았는지(stale)를 같이 준다.** 화면이 "어제 것을
//     오늘 것처럼" 보여주지 않으려면 이 값이 있어야 한다 — 일일은 오늘이 아니면 곧바로
//     stale 이고, 주간은 7일, 격주·추천은 14일이 지나면 stale 이다.
//   ★ /api/mythic-shop 보다 **먼저** 선언해야 한다 (아래 history 와 같은 이유).
app.get('/api/mythic-shop/section/:section', async (req, res) => {
    try {
        const section = String(req.params.section || '');
        if (!MYTHIC_SECTIONS.includes(section)) {
            return res.status(400).json({ ok: false, reason: 'invalid_section' });
        }

        const key = `mythic_sec_${section}`;
        const hit = myCache.get(key);
        if (hit) return res.json(hit);

        const today = utcDay();
        // 미래 날짜는 검증에서 막히지만, 혹시 들어와도 오늘 것으로 보이지 않게 잘라 둔다.
        const doc = await MythicShop.findOne({ section, date: { $lte: today } })
            .select('-_id -__v -createdAt').sort({ date: -1 }).lean();

        let payload;
        if (!doc) {
            payload = { ok: true, section, date: null, collectedAt: null, ageDays: null, stale: false, items: null };
        } else {
            const ageDays = Math.round((Date.parse(today) - Date.parse(doc.date)) / 86400000);
            payload = {
                ok: true, section, date: doc.date, collectedAt: doc.collectedAt,
                ageDays, stale: ageDays > MYTHIC_SECTION_PERIOD[section], items: doc.items
            };
        }

        myCache.set(key, payload, 60);
        res.json(payload);
    } catch (e) {
        console.error('[Mythic] section 실패:', e.message);
        res.status(500).json({ ok: false, reason: 'server_error' });
    }
});

// ── 그 아이템이 나온 날짜들 (최신순). "마지막 등장일" 용
//   ★ /api/mythic-shop 보다 **먼저** 선언해야 한다. 뒤에 두면 그쪽이 먼저 잡는다.
app.get('/api/mythic-shop/history/:catalogId', async (req, res) => {
    try {
        const catalogId = String(req.params.catalogId || '').slice(0, 40);
        if (!catalogId) return res.status(400).json({ ok: false, reason: 'invalid' });

        const key = `mythic_hist_${catalogId}`;
        const hit = myCache.get(key);
        if (hit) return res.json(hit);

        const docs = await MythicShop.find({ 'items.catalogId': catalogId })
            .select('date section items').sort({ date: -1 }).limit(400).lean();

        const dates = docs.map(d => d.date);
        // ★ 어느 구획에서 나왔는지도 같이 준다 (2026-08-17). 같은 아이템이 일일에도
        //   주간에도 나올 수 있어서, 날짜만으로는 "어디서 봤나" 를 못 밝힌다.
        //   `dates` 는 그대로 둔다 — 이미 쓰는 쪽이 있으면 깨지면 안 된다.
        const entries = docs.map(d => ({ date: d.date, section: d.section || 'daily' }));
        // 이름은 가장 최근 것으로 (이름이 바뀌었어도 최신 표기를 보여 준다)
        const name = docs.length
            ? (docs[0].items.find(i => i.catalogId === catalogId)?.name || null)
            : null;

        const payload = { ok: true, catalogId, name, dates, entries };
        myCache.set(key, payload, 300);
        res.json(payload);
    } catch (e) {
        console.error('[Mythic] history 실패:', e.message);
        res.status(500).json({ ok: false, reason: 'server_error' });
    }
});

// ── 기간 조회. 기본 최근 30일
app.get('/api/mythic-shop', async (req, res) => {
    try {
        const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 400);
        const q = {};
        if (isDate(req.query.from) || isDate(req.query.to)) {
            q.date = {};
            if (isDate(req.query.from)) q.date.$gte = req.query.from;
            if (isDate(req.query.to)) q.date.$lte = req.query.to;
        }
        // ★ 구획 필터 (2026-08-17). 안 주면 전 구획이 섞여 나온다 —
        //   일일만 보려던 화면이 주간 문서를 같이 받으면 날짜가 겹쳐 보인다.
        if (req.query.section) {
            if (!MYTHIC_SECTIONS.includes(req.query.section)) {
                return res.status(400).json({ ok: false, reason: 'invalid_section' });
            }
            q.section = req.query.section;
        }

        // ★ 키는 **검증을 통과한 값**으로만 만든다 (2026-09-03 감사 M-11). 원문을 넣으면 `from=aaa`·`aab`… 가
        //   결과는 전부 같은데 키만 달라 캐시가 무한히 쌓이고 그때마다 DB 를 다시 쳤다
        const key = `mythic_range_${isDate(req.query.from) ? req.query.from : ''}_${isDate(req.query.to) ? req.query.to : ''}_${req.query.section || ''}_${limit}`;
        const hit = myCache.get(key);
        if (hit) return res.json(hit);

        const docs = await MythicShop.find(q)
            .select('-_id -__v -createdAt').sort({ date: -1 }).limit(limit).lean();

        const payload = { ok: true, count: docs.length, days: docs };
        myCache.set(key, payload, 60);
        res.json(payload);
    } catch (e) {
        console.error('[Mythic] 기간 조회 실패:', e.message);
        res.status(500).json({ ok: false, reason: 'server_error' });
    }
});

// ★ 컷라인 그래프 데이터 (2026-08-18). 하루 한 줄이라 통째로 내려보내도 가볍다.
//   `days` 로 최근 며칠만 자를 수 있다 (기본 90일, 최대 365).
app.get('/api/rank-cutoffs', async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
    const key = `rank_cutoffs_${days}`;
    const hit = myCache.get(key);
    if (hit) return res.json(hit);
    try {
        const rows = await RankCutoff.find({}, { _id: 0, day: 1, lpChal: 1, lpGm: 1 })
            .sort({ day: -1 }).limit(days).lean();
        rows.reverse();   // 화면은 옛날 → 최근 순으로 그린다
        const payload = { ok: true, count: rows.length, days: rows };
        myCache.set(key, payload, 300);
        res.json(payload);
    } catch (e) {
        console.error('[Cutoff] 조회 실패:', e.message);
        res.status(500).json({ ok: false, reason: 'server_error' });
    }
});

// ==========================================
// 패치노트 목록 (2026-08-19 신설) — 홈 화면 패치노트 영역이 읽는다
//   한국 롤 공식 홈페이지의 패치노트 태그 페이지를 긁는다. Next.js 라
//   __NEXT_DATA__ JSON 안에 기사 목록(articleCardGrid.items)이 통째로 들어 있어서
//   HTML 파싱 없이 JSON 만 뽑으면 된다 (2026-08-19 실측: 171건 · 최신순).
//   ★ 30분 캐시 + 마지막 성공값 폴백 — 공식 페이지가 잠깐 죽거나 구조가 바뀌어도
//     홈 화면이 통째로 비지 않게 한다. 구조가 바뀌면 콘솔 경고가 남는다.
//   ★ UA 는 브라우저 꼴로 보낸다. 밋밋한 axios 기본 UA 는 그쪽 CDN 이 자를 수 있다
//     (우리 Cloudflare 가 Python-urllib 를 잘랐던 것과 같은 이유다).
//
// ★★ 오른쪽(PBE) 칸도 여기서 같이 나간다 (2026-08-19 2차).
//   X 는 로그인 장벽이라 직접 못 긁고 syndication 우회로는 2025-11 에 얼어붙은
//   스냅샷만 줬는데, **nitter.net RSS 가 살아 있고 최신이다** (실측: 당일 글까지 옴).
//   `Patch NN.NN [Full] Preview` 로 시작하는 글만 골라 x.com 주소로 바꿔 내보낸다.
//   ★ 니터 인스턴스는 언제든 죽을 수 있다 — 죽으면 lastGood 폴백, 그마저 없으면
//     pbe 가 빈 배열이고 화면은 index.html 의 정적 안내(프로필 바로가기)로 남는다.
//   ★ 두 소스는 따로 try/catch 다. 한쪽이 죽어도 다른 쪽은 나가야 한다.
// 목록으로 들고 있을 최대 건수 (패치노트 탭이 이만큼까지 보여준다. 홈은 limit=5).
// ★ 공식 태그 페이지가 한 번에 주는 게 172건(9.1 / 2019-01 부터)이라 200이면 전부 담긴다 —
//   그 페이지의 「더 보기」 버튼은 url 이 "#" 이라 서버에 더 물어볼 곳이 없다 (2026-08-27 실측)
const PATCH_LIST_MAX = 200;
let lastGoodOfficialNotes = null;
let lastGoodPbeNotes = null;

async function fetchOfficialPatchNotes() {
    const r = await axios.get('https://www.leagueoflegends.com/ko-kr/news/tags/patch-notes/', {
        timeout: 10000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Accept-Language': 'ko'
        }
    });
    const m = String(r.data).match(/__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('__NEXT_DATA__ 없음');
    const blades = JSON.parse(m[1])?.props?.pageProps?.page?.blades || [];
    const grid = blades.find(b => b.type === 'articleCardGrid');
    if (!grid || !Array.isArray(grid.items)) throw new Error('articleCardGrid 없음');

    // ★ 5건 → 100건 (2026-08-27). 패치노트 탭이 목록을 통째로 보여준다 —
    //   홈 위젯은 예전처럼 앞 5개만 쓴다 (엔드포인트가 limit 으로 잘라 준다).
    //   실측 172건이 오는데 100이면 2년치가 넘는다.
    const official = grid.items.slice(0, PATCH_LIST_MAX).map(it => {
        const rel = it?.action?.payload?.url || '';
        const raw = it?.media?.url || it?.imageMedia?.url || '';
        const title = String(it.title || '').slice(0, 200);
        return {
            title,
            url: /^https?:/.test(rel) ? rel : `https://www.leagueoflegends.com${rel}`,
            date: it?.analytics?.publishDate || it?.publishedAt || null,
            // ★ sanity CDN 은 &w= 로 줄여 준다 — 원본이 1920x1080(313KB)이라 그대로 걸면
            //   목록 한 장에 30MB 다. 320px 이면 14KB (2026-08-27 실측)
            thumb: raw ? raw + (raw.includes('?') ? '&' : '?') + 'w=320' : null,
            desc: String(it?.description?.body || '').replace(/<[^>]*>/g, '').trim().slice(0, 300) || null,
            // "26.17 패치 노트" 처럼 제목 앞에 번호가 있는 글만 배지를 단다 (핫픽스 글엔 없다)
            version: (title.match(/(\d+\.\d+)/) || [])[1] || null
        };
    }).filter(n => n.title && n.url);
    if (!official.length) throw new Error('기사 0건');
    return official;
}

// ★★ 니터 미러는 데이터센터 IP 를 자주 막는다 (2026-08-19 실측).
//   로컬(가정용 회선)에서는 nitter.net 이 브라우저 UA 로 뚫리는데 **Railway 에서는 빈손**이었다.
//   그래서 소스를 사슬로 두고 위에서부터 시도한다 — 하나라도 되면 그걸로 간다:
//     · nitter.net (브라우저 UA / RSS 리더 UA 두 벌)
//     · xcancel.com — "RSS 클라이언트에서만 동작" 하는 곳이라 **RSS 리더 UA 가 필수**고,
//       rss.xcancel.com 으로 302 를 태운다 (axios 가 따라간다)
//   어느 소스가 됐는지 로그에 남는다. 전부 실패하면 lastGood → 정적 안내 순서다.
const PBE_RSS_SOURCES = [
    { name: 'nitter', url: 'https://nitter.net/RiotPhroxzon/rss', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
    { name: 'nitter-rssua', url: 'https://nitter.net/RiotPhroxzon/rss', ua: 'FreshRSS/1.24.0 (Linux; https://freshrss.org)' },
    { name: 'xcancel-rss', url: 'https://rss.xcancel.com/RiotPhroxzon/rss', ua: 'FreshRSS/1.24.0 (Linux; https://freshrss.org)' },
    { name: 'xcancel', url: 'https://xcancel.com/RiotPhroxzon/rss', ua: 'FreshRSS/1.24.0 (Linux; https://freshrss.org)' }
];

function parsePbeRss(xml) {
    const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(x => x[1]);
    const pbe = [];
    for (const it of items) {
        const title = ((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
        const link = ((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim();
        const pub = ((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim();
        // 리트윗은 제목이 "RT by …" 로 시작해 어차피 아래 정규식에 안 걸린다
        const pm = title.match(/^Patch\s+(\d+\.\d+)\b(.{0,30}?)Preview/i);
        if (!pm) continue;
        const idm = link.match(/\/status\/(\d+)/);
        if (!idm) continue;
        pbe.push({
            patch: pm[1],
            // 첫 줄에 Full 이 있으면 상세, 없으면 간단 (사용자 규칙 그대로)
            detail: /full/i.test(pm[2]),
            url: `https://x.com/RiotPhroxzon/status/${idm[1]}`,
            date: pub ? new Date(pub).toISOString() : null
        });
        if (pbe.length >= PATCH_LIST_MAX) break;   // RSS 가 최신순이라 앞에서부터 담는다
    }
    return pbe;
}

async function fetchPbePreviewNotes() {
    const fails = [];
    for (const src of PBE_RSS_SOURCES) {
        try {
            const r = await axios.get(src.url, {
                timeout: 10000,
                headers: { 'User-Agent': src.ua, 'Accept': 'application/rss+xml, application/xml, text/xml' }
            });
            if (!String(r.data).includes('<rss')) throw new Error('RSS 아님');
            const pbe = parsePbeRss(r.data);
            if (!pbe.length) throw new Error('Preview 글 0건');
            console.log(`[PatchNotes] PBE 소스: ${src.name} (${pbe.length}건)`);
            return pbe;
        } catch (e) {
            fails.push(`${src.name}: ${e.response ? e.response.status : e.message}`);
        }
    }
    throw new Error('전 소스 실패 — ' + fails.join(' / '));
}

// ★ limit 으로 잘라 준다 (2026-08-27) — 홈 위젯은 5, 패치노트 탭은 100.
//   **캐시에는 항상 통째로** 담고 응답에서만 자른다. 그래야 홈이 먼저 열려도
//   탭이 5건짜리 캐시를 물려받지 않는다
// 본 김에 적어 둔다. 트윗 id 가 열쇠라 몇 번을 다시 봐도 한 줄이다
async function savePbeNotes(list) {
    const ops = (list || []).map(n => {
        const tid = (String(n.url || '').match(/status\/(\d+)/) || [])[1];
        if (!tid) return null;
        return { updateOne: {
            filter: { tid },
            update: { $set: { tid, patch: n.patch, detail: !!n.detail, url: n.url, date: n.date ? new Date(n.date) : null } },
            upsert: true
        } };
    }).filter(Boolean);
    if (!ops.length) return;
    try { await PbeNote.bulkWrite(ops, { ordered: false }); }
    catch (e) { console.warn('[PatchNotes] PBE 저장 실패:', e.message); }
}

// 창고에서 최신순으로. 실패하면 빈 배열을 주고 호출부가 RSS 값을 그대로 쓴다
async function loadPbeNotes(limit) {
    try {
        const rows = await PbeNote.find({}, { _id: 0, patch: 1, detail: 1, url: 1, date: 1 })
            .sort({ date: -1 }).limit(limit).lean();
        return rows.map(r => ({ patch: r.patch, detail: !!r.detail, url: r.url, date: r.date ? new Date(r.date).toISOString() : null }));
    } catch (e) { console.warn('[PatchNotes] PBE 창고 조회 실패:', e.message); return []; }
}

app.get('/api/patch-notes', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), PATCH_LIST_MAX);
    const cut = (p) => Object.assign({}, p, { official: p.official.slice(0, limit), pbe: p.pbe.slice(0, limit) });
    const hit = myCache.get('patch_notes');
    if (hit) return res.json(cut(hit));

    const [offR, pbeR] = await Promise.allSettled([fetchOfficialPatchNotes(), fetchPbePreviewNotes()]);

    let official;
    if (offR.status === 'fulfilled') { official = offR.value; lastGoodOfficialNotes = official; }
    else { console.warn('[PatchNotes] 공식 수집 실패:', offR.reason?.message); official = lastGoodOfficialNotes || []; }

    let pbe;
    if (pbeR.status === 'fulfilled') { pbe = pbeR.value; lastGoodPbeNotes = pbe; }
    else { console.warn('[PatchNotes] PBE(nitter) 수집 실패:', pbeR.reason?.message); pbe = lastGoodPbeNotes || []; }

    // ★★ 본 것을 창고에 적고, 화면에는 **창고**를 준다 (2026-08-27).
    //   RSS 는 최근 20글만 줘서 그것만 쓰면 두 달치가 한계다. 창고에는 과거분
    //   백필까지 들어 있으므로 훨씬 길다. 창고가 비었거나 조회가 실패하면 RSS 값 그대로.
    await savePbeNotes(pbe);
    const stored = await loadPbeNotes(PATCH_LIST_MAX);
    if (stored.length) pbe = stored;

    const payload = { ok: official.length > 0 || pbe.length > 0, official, pbe, fetchedAt: Date.now() };
    // ★ 한쪽이라도 비었으면 5분만 캐시한다 (2026-08-19). 30분으로 두면 니터가 잠깐
    //   막혔을 때 빈 pbe 가 30분 동안 눌러앉는다. 둘 다 실패면 아예 캐시하지 않는다.
    if (payload.ok) {
        const full = official.length > 0 && pbe.length > 0;
        myCache.set('patch_notes', payload, full ? 1800 : 300);
    }
    res.json(cut(payload));
});

app.get('/api/ranking', async (req, res) => {
    // ★ 문자열로 캐시한다 (2026-09-03 감사 M-6) — 11,000 객체를 요청마다 JSON.stringify 하던 것이 사라진다.
    //   명단 갱신 때 myCache.del('challenger_ranking_data') 로 버리는 건 그대로다
    const cachedRanking = myCache.get('challenger_ranking_data');
    if (cachedRanking) return res.type('json').send(cachedRanking);
    if (challengerList.length === 0) return res.status(503).json({ error: "랭킹 데이터를 수집 중입니다. 잠시 후 다시 시도해주세요." });

    // 티어는 한 글자로 줄여 보낸다. 1만 명 x 매 항목이라 글자 수가 곧 응답 크기다.
    const TIER_CODE = { challengerleagues: 'C', grandmasterleagues: 'G', masterleagues: 'M' };

    const processedPlayers = challengerList.map(p => ({
        displayName: resolvedNames[p.puuid]?.displayName || `User-${String(p.puuid).substring(0, 8)}`,
        leaguePoints: p.leaguePoints || 0,
        wins: p.wins || 0,
        losses: p.losses || 0,
        tier: TIER_CODE[p.tier] || 'M',
        // 숙련도 상위 5개 championId. 아직 못 받은 사람은 빈 배열이라 글자를 거의 안 먹는다
        mastery: resolvedMastery[p.puuid]?.top || []
    }));

    // ★ 갱신 주기를 같이 실어 보낸다 (2026-08-18). 시간대마다 10분/5분/1분이라
    //   화면에 "10분마다" 로 박아 두면 밤에 틀린 말이 된다.
    //   ★★ 규칙을 화면 쪽에 복제하지 않는 게 핵심이다 — 두 벌이 되면 주기를 바꿀 때
    //     한쪽만 고쳐 어긋난다. 여기 한 곳(rankRefreshMs)만이 정본이다.
    //   ★ 이 응답은 10분 캐시지만 명단이 갱신될 때마다 캐시를 버리므로(myCache.del)
    //     시간대가 바뀌면 다음 갱신에서 곧바로 새 값이 나간다.
    const finalRankingData = {
        tier: "CHALLENGER",
        updatedAt: rankUpdatedAt,
        refreshMs: rankRefreshMs(),
        players: processedPlayers
    };
    const body = JSON.stringify(finalRankingData);
    myCache.set('challenger_ranking_data', body, 600);
    res.type('json').send(body);
});

// 아레나 증강체 데이터
app.get('/api/arena/augments', (req, res) => {
    res.json(arenaAugments);
});

// ==========================================
// [6] 프론트엔드 라우팅 및 서버 구동
// ==========================================
app.get(/.*/, sendIndexHtml);

const PORT = process.env.PORT || 3000;

async function bootstrap() {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 15000
        });
        console.log("[System] MongoDB 연결 성공");
    } catch (err) {
        console.error("[System] MongoDB 연결 실패. 서버를 종료합니다.");
        console.error(`  → ${err.message}`);
        process.exit(1);
    }

    // ★ 포트를 먼저 연다 (2026-09-03 감사 H-3). 예전엔 startJobs() 를 다 기다린 뒤에 listen 해서
    //   배포마다 최악 90초(명단 조회 3티어 × 3회 재시도 × 10초) 동안 TCP 연결 자체가 안 받아졌다.
    //   조회 라우트는 DB 만 읽으므로 잡이 덜 끝나도 대부분 정상이고, 명단이 아직 없는 자리는
    //   /api/ranking 이 이미 503 안내를 준다 — 그 처리가 있다는 게 곧 "먼저 열어도 된다" 는 뜻이다
    app.listen(PORT, () => console.log(`[System] 서버 실행 중: 포트 ${PORT}`));

    startJobs().catch(e => console.error('[System] startJobs 실패:', e.message));
    refreshChampLaneStats();
    setInterval(refreshChampLaneStats, 60 * 60 * 1000);   // 1시간마다 갱신
}

bootstrap();