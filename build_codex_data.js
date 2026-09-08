// ==========================================
// 도감 데이터 생성  →  public/codex_data.js
//   아이템 · 룬 · 소환사 주문의 한국어 이름/설명/수치/조합식을 한 파일로 묶는다.
//
// ★★ 세 소스 모두 "지금 협곡에 없는 것" 이 잔뜩 섞여 있다. 거르는 규칙이 각각 다르다:
//
//   아이템  DD item.json 868개 → **maps['11'] && gold.purchasable !== false** → 254개
//     ★ CD items.json 의 `inStore` 를 쓰면 안 된다. 696개가 나오는데 흑요석 검(아레나)·
//       수호자의 부적(칼바람)·"퀘스트: 상단" 같은 **다른 모드 아이템이 442개** 섞인다.
//       DD 필터 결과가 CD inStore 의 정확한 부분집합인 것까지 확인했다 (DD 만 있는 것 0개).
//
//   룬      CD perks.json 103개 → **perkstyles.json 슬롯에 등장하는 것만** → 69개
//     ★ 나머지 34개는 삭제된 옛 룬이다. perks.json 은 그것들을 그대로 들고 있다.
//
//   주문    DD summoner.json 34개 → **modes 에 CLASSIC** → 9개
//     ★ 나머지는 칼바람 표식·아레나·우르프용이다.
//
//   (stringtable 에 구버전이 섞여 있던 것과 같은 종류의 함정이다 — CLAUDE.md 참고)
//
// ★ 설명 안의 <passive>·<magicDamage> 같은 태그는 **챔피언 스킬 툴팁과 같은 계열**이라
//   app.js 의 TOOLTIP_STYLE_CSS 를 그대로 쓴다. 36종 중 31종이 이미 실측 색을 갖고 있었다.
//
// ★★ 아이템 등급은 DD `depth` 가 아니라 **게임 bin 의 `epicness`** 다 (2026-08-16 정정).
//   `depth` 는 "재료를 몇 겹 쌓았나" 라서 등급과 다르다 — **무한의 대검(3500G, 전설급)이
//   depth 2 라 거인의 허리띠(900G, 서사급)와 같은 칸에 들어간다.** 실제로 도감에서
//   무한의 대검·라바돈의 죽음모자가 "중급" 으로 찍히고 있었다.
//   등급 이름도 우리가 지어낸 것(기본/중급/완성)이었다. 라이엇 공식 한국어는
//   stringtable 의 `shop_group_*` 에 있다 — 기본 / 시작 / 서사급 / 전설급 / 신화급(아레나).
//
// 패치가 오면 다시 돌린다. 런타임 의존은 없다.
// ==========================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadStringTable } = require('./stringtable');

// ★ DD 버전은 dd_version.js 가 정한다 (versions.json 최신 · DD_VER 환경변수가 이긴다).
//   상수가 아니라 아래 IIFE 첫머리에서 채운다 — 받아오는 데 await 가 필요해서다.
const { ddVersion } = require('./dd_version');
let DD_VER, DD;
const CD = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/ko_kr/v1';
// 아이템 등급(`epicness`) 이 여기에만 있다. 15MB 라 빌드 때만 받는다 (런타임 의존 0).
const CD_ITEM_BIN = 'https://raw.communitydragon.org/latest/game/items.cdtb.bin.json';
// ★★ 소환사 주문의 **실제 수치**가 여기 있다 (2026-08-26). 8.6MB, 빌드 때만 받는다.
//   DD `summoner.json` 은 `tooltip` 에 `{{ smitebasedamage }}` 같은 **변수 자리만** 주고
//   `datavalues` 가 9개 전부 비어 있어서 채울 수가 없다. 게임 bin 에는 값이 그대로 있다.
const CD_SHARED_BIN = 'https://raw.communitydragon.org/latest/game/shared.cdtb.bin.json';
const WRITE = process.argv.includes('--write');

async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
}

(async () => {
    // ★ withCD — DD 아이템(이름·가격·조합식)과 CD 등급·룬을 같이 쓰므로 짝짝이를 막는다
    DD_VER = await ddVersion({ withCD: true });
    DD = `https://ddragon.leagueoflegends.com/cdn/${DD_VER}/data/ko_KR`;

    const [ddItem, ddSumm, ddChamp, perks, perkStyles, itemBin, sharedBin, strings] = await Promise.all([
        getJson(`${DD}/item.json`),
        getJson(`${DD}/summoner.json`),
        // 챔피언 전용 아이템의 `requiredChampion` 을 한글 이름으로 바꾸는 데만 쓴다 (아래 korRc)
        getJson(`${DD}/champion.json`),
        getJson(`${CD}/perks.json`),
        getJson(`${CD}/perkstyles.json`),
        getJson(CD_ITEM_BIN),
        // 소환사 주문 수치 + 그 툴팁 문장 (아래 spellTooltip)
        getJson(CD_SHARED_BIN),
        loadStringTable({ quiet: true })
    ]);

    // ── 아이템
    const all = ddItem.data;

    // ★★ maps['11'] 만으로는 부족하다 — **다른 모드용 사본이 39개 딸려온다** (2026-08-16).
    //   `322065 슈렐리아의 군가`(2600G)처럼 **협곡 원본(2065, 2200G)과 이름이 같은 6자리 id** 가
    //   섞여서 도감에 같은 아이템이 두 번 나왔다. 이름이 겹치는 게 27종이었다.
    //
    //   ★ 가르는 규칙: **사본은 `maps` 에서 11만 true 이고 나머지가 전부 false 다.**
    //     진짜 협곡 아이템은 12·21·35·453 도 함께 true 다. 39개가 정확히 걸리고
    //     정상 아이템은 하나도 안 걸린다 (대표 20종 전수 확인).
    //
    //   ★ "CD 아이콘 파일명 앞 숫자가 자기 id 와 다르면 사본" 이라는 규칙도 써 봤는데
    //     **정상 아이템 7개를 같이 잡아서 버렸다** (폭풍갈퀴 3097 · 수호자의 망치 3184 ·
    //     추적자의 팔목 보호대 2420 · 지배자의 피갑옷 2501 등은 아이콘을 남의 번호로 쓴다).
    //
    //   ★ 짝이 없는 13개(아트마의 심판·가고일 돌갑옷·도박꾼의 칼날 등)도 지우는 게 맞다.
    //     원본 id 를 찾아보면 `3193 가고일 돌갑옷` 은 `maps11=false, purchasable=false` 고
    //     `7101 도박꾼의 칼날` 은 DD 에 아예 없다 — **협곡에서 빠졌고 아레나에만 있는 것들**이다.
    const isOtherModeClone = (i) => {
        const m = all[i].maps || {};
        return m['11'] && !Object.entries(m).some(([k, v]) => k !== '11' && v);
    };

    // ★★ 칼바람 나락 전용 "수호자" 아이템 4종이 딸려 온다 (2026-08-25, 사용자 지적).
    //   **`maps` 로는 못 거른다** — 수호자의 뿔피리도 `maps['11'] = true` 다.
    //   가르는 건 게임 bin 의 `mItemGroups` 에 있는 **`Items/ItemGroups/GuardianItems`** 다.
    //   협곡 215개 중 넷이 걸린다: 수호자의 뿔피리 · 보주 · 검 · 망치 (전부 950G · 상위 아이템 없음).
    //   ★ `MythicItems` 그룹은 **빼면 안 된다** — 옛 이름일 뿐이고 `사라진 양피지`(3802)가
    //     거기 속하는데 대천사의 지팡이·루덴의 메아리·악의로 조합되는 **협곡 아이템**이다.
    const isAramGuardian = (i) =>
        (itemBin['Items/' + i]?.mItemGroups || []).includes('Items/ItemGroups/GuardianItems');

    // ★★ `maps['453']` 도 같이 본다 (2026-09-08, 사용자 지적: 「카파 주스」는 협곡 아이템이 아니다).
    //   카파 주스(2141)는 `maps['11']`·`['12']` 가 true 라 위 규칙 셋을 전부 빠져나온다.
    //   실측: 위 셋을 통과한 것 중 **`453` 이 false 인 건 정확히 5개**이고 그중 넷은 이미 빼는
    //   칼바람 수호자 4종이다 — 즉 이 조건이 더 걸러내는 건 카파 주스 하나뿐이다.
    //   ★ 그래서 `isAramGuardian`(bin 근거)을 지우지 않고 **둘 다 남긴다** — 근거가 서로 다르고,
    //     라이엇이 453 딱지를 손대도 수호자 4종은 계속 걸린다.
    //   ★ 다음 패치에서 이 조건이 갑자기 여러 개를 지우면(로그의 아이템 수가 뚝 떨어지면)
    //     453 의 뜻이 바뀐 것이니 여기부터 볼 것.
    const liveIds = Object.keys(all).filter(i =>
        all[i].maps?.['11'] && all[i].maps?.['453'] && all[i].gold?.purchasable !== false
        && !isOtherModeClone(i) && !isAramGuardian(i));

    // ★★ 등급은 게임 bin 의 `epicness` 다 (위 머리주석 참고). 값을 합치거나 다시 매기지 않고
    //   **그대로 담는다** — 화면(app.js 의 CODEX_EPICNESS)이 이름만 붙인다.
    //   협곡 215개 실측: 없음·0 = 20(기본) / 1 = 23(시작·소모품) / 4 = 50(서사급) /
    //   5 = 112(전설급) / 7 = 10(영약 3 + 신발 업그레이드 7). 합이 정확히 215다.
    //   ★ 필드가 없으면 0(기본)이다 — 장화·롱소드 같은 재료 아이템 19개가 그렇다.
    const noBin = [];
    const epicnessOf = (id) => {
        const e = itemBin['Items/' + id];
        if (!e) { noBin.push(id); return 0; }
        return e.epicness || 0;
    };

    // ★★ 역할군은 게임 bin 의 `mItemAttributes` 다 — **비트 플래그 6개**이고
    //   라이엇 인게임 상점의 "유형:" 필터 6칸과 정확히 대응한다 (2026-08-25 신설).
    //   DD 에도 CD `items.json` 에도 없어서 등급(`epicness`)과 마찬가지로 bin 에서 온다.
    //
    //   ★ 어느 비트가 무엇인지는 **전설급만 걸러 보면 한눈에 갈린다** (기본 재료는
    //     여러 비트에 겹쳐 있어서 안 갈린다):
    //       1  전사      삼위일체 · 스테락의 도전 · 굶주린 히드라 · 몰락한 왕의 검
    //       2  원거리 딜러 무한의 대검 · 유령 무희 · 루난의 허리케인 · 고속 연사포
    //       4  암살자     요우무의 유령검 · 그림자 검 · 밤의 끝자락 · 독사의 송곳니
    //       8  탱커      태양불꽃 방패 · 워모그의 갑옷 · 란두인의 예언 · 강철심장
    //      16  마법사     라바돈의 죽음모자 · 리치베인 · 공허의 지팡이 · 존야의 모래시계
    //      32  서포터     구원 · 미카엘의 축복 · 불타는 향로 · 제국의 명령 · 헬리아의 메아리
    //
    //   ★ 비트를 **합쳐서 하나의 수로** 담는다 (예: 서포터+마법사 = 48). 화면은 `ra & 32` 로 본다.
    //   ★ 아이템 하나가 여러 역할군에 들어가는 게 정상이다 — 인게임 상점도 그렇다.
    const rolesOf = (id) => (itemBin['Items/' + id]?.mItemAttributes || []).reduce((a, b) => a | b, 0);

    // ★★ `requiredChampion` 은 **영문 키**다 — 그대로 담으면 화면에 `Kalista 전용` 이 나간다
    //   (2026-08-25 정정. 이름이 같은 칼리스타 창 3599/3600 을 가르는 뱃지라 제일 눈에 띄는 자리였다).
    // ★ champion.json 의 키와 **대소문자가 어긋나는 자리가 있다** — 아이템 쪽은 `FiddleSticks` 인데
    //   champion.json 은 `Fiddlesticks` 다. 정확히 찾으면 못 찾으므로 **소문자로 맞춰 찾는다.**
    // ★ 못 찾으면 영문을 그대로 남기고 경고를 찍는다 — 조용히 빈칸이 되면 칼리스타 창 두 개를
    //   구분할 길이 사라진다. **빈칸보다 영문이 낫다.**
    const korChamp = {};
    Object.values(ddChamp.data).forEach(c => { korChamp[c.id.toLowerCase()] = c.name; });
    const rcMissed = [];
    const korRc = (key) => {
        if (!key) return '';
        const kor = korChamp[key.toLowerCase()];
        if (!kor) { rcMissed.push(key); return key; }
        return kor;
    };

    const items = {};
    liveIds.forEach(i => {
        const x = all[i];
        items[i] = {
            n: x.name,
            d: x.description || '',
            p: x.plaintext || '',
            g: x.gold.total,
            s: x.gold.sell,
            // 조합 재료 / 이 아이템이 들어가는 상위 아이템. 화면이 목록 안에서만 걸으므로
            // **표에 없는 id 는 버린다** (다른 모드 전용 상위 아이템이 딸려올 수 있다).
            f: (x.from || []).map(Number).filter(id => liveIds.includes(String(id))),
            t: (x.into || []).map(Number).filter(id => liveIds.includes(String(id))),
            // ★ DD `tags` 와 bin `mCategories` 는 **215개 전부 같다**(2026-08-25 전수 확인).
            //   그래서 스탯 필터도 이 배열 하나로 충분하다 — bin 을 또 읽을 이유가 없다.
            g2: x.tags || [],
            ep: epicnessOf(i),
            ra: rolesOf(i),
            // 검색 별칭. 라이엇이 넣어 둔 것이라 "인피"·"똥신" 같은 별명이 그대로 있다
            c: (x.colloq || '').split(';').filter(Boolean).join(' '),
            // ★ 챔피언 전용 아이템(오른 등)만 채운다. 칼리스타의 칠흑의 창은
            //   칼리스타용(3599)과 실라스용(3600)이 **이름이 같아서** 이게 없으면 구분이 안 된다.
            //   ★ 화면에 그대로 나가는 값이라 **한글 이름으로 담는다** (위 korRc 주석 참고).
            rc: korRc(x.requiredChampion)
        };
    });

    // 조합 재료가 표 안에 다 있는지 (트리를 그릴 수 있는가)
    let brokenFrom = 0;
    Object.values(items).forEach(it => it.f.forEach(f => { if (!items[f]) brokenFrom++; }));

    // ── 룬. perkstyles 슬롯이 "지금 쓰이는 목록" 이다
    const runes = {};
    const styles = {};
    // ★★ `styles[id].sl` 은 **줄별 룬 id 배열**이고 CD 가 준 순서 그대로다.
    //   도감 트리를 인게임과 같은 자리에 그리려면 이게 있어야 한다. 이름순으로 세우면
    //   20슬롯 중 17개가 클라와 어긋난다 (정밀 핵심룬 = 집중공격/치명적속도/기민한발놀림/정복자).
    const perkIds = new Set(perks.map(p => p.id));
    perkStyles.styles.forEach(st => {
        styles[st.id] = { n: st.name, i: st.iconPath, sl: [] };
        st.slots.filter(sl => sl.type !== 'kStatMod').forEach((sl, slotIdx) => {
            // perks.json 에 없는 id 는 버린다 (바로 아래 runes 를 채우는 가드와 같은 기준이어야 한다)
            styles[st.id].sl.push(sl.perks.filter(pid => perkIds.has(pid)));
            sl.perks.forEach(pid => {
                const p = perks.find(x => x.id === pid);
                if (!p) return;
                runes[pid] = {
                    n: p.name,
                    s: p.shortDesc || '',
                    d: p.longDesc || '',
                    i: p.iconPath,
                    st: st.id,
                    sl: slotIdx           // 0 = 키스톤
                };
            });
        });
    });
    // ★★ 파편 3x3 을 자리 그대로 담는다 — 아래 `shards` 만으로는 못 그린다.
    //   적응형 능력치(5008)가 1·2번 줄, 체력 증가(5001)가 2·3번 줄에 **두 번** 나오는데
    //   shards 는 중복을 버려서(!shards[pid]) 처음 만난 줄만 남기기 때문이다.
    //   ★ 실측(2026-08-21): 파편 3줄은 5개 계열이 전부 같다. 그래서 한 벌만 담는다.
    const statRowsOf = st => st.slots.filter(sl => sl.type === 'kStatMod').map(sl => sl.perks.slice());
    const shardRows = statRowsOf(perkStyles.styles[0]);
    const rowsKey = JSON.stringify(shardRows);
    const oddStyle = perkStyles.styles.find(st => JSON.stringify(statRowsOf(st)) !== rowsKey);

    // 스탯 파편도 도감에 넣는다 (룬 페이지의 일부다)
    const shards = {};
    perkStyles.styles[0].slots.filter(sl => sl.type === 'kStatMod').forEach((sl, i) => {
        sl.perks.forEach(pid => {
            const p = perks.find(x => x.id === pid);
            if (p && !shards[pid]) shards[pid] = { n: p.name, s: p.shortDesc || '', d: p.longDesc || '', i: p.iconPath, row: i };
        });
    });

    // ── 소환사 주문
    //
    // ★★ "다른 모드에서 못 쓴다" 를 같이 담는다 (2026-08-25).
    //   주문 상세가 도감에서 제일 휑한 자리였는데(카드 720px 에 글자 233자),
    //   **시연 영상은 라이엇이 안 만들어서 넣을 수가 없다** (조사 결과는 CLAUDE.md 도감 절).
    //   대신 `modes` 에 실제 정보가 있다 — 강타는 칼바람에서 못 쓰고 순간이동은 셋에서 못 쓴다.
    //
    // ★ 추가 요청 0 이다. **DD `modes` 와 CD `gameModes` 가 9/9 바이트까지 같은 것을 확인했고**
    //   DD summoner.json 은 이미 받고 있다. CD 를 또 받을 이유가 없다.
    //
    // ★ 모드 코드 → 한글은 우리가 잇지만 **이름 자체는 라이엇 것**이다
    //   (CD `queues.json` 의 큐 이름: 3200번대 "칼바람 나락" · 1200 "돌격! 넥서스" ·
    //    480 "신속 대전" · 1020 "단일 챔피언" · 1700 "아레나").
    //   `queues.json` 에는 gameMode 필드가 없어서 코드↔이름을 직접 잇지는 못한다.
    //
    // ★ 아레나(CHERRY)는 뺐다 — 협곡 주문 9개가 **전부** 못 쓴다(별도 주문 체계다).
    //   9개 전부에 같은 딱지가 붙으면 정보가 아니라 잡음이다.
    const MAIN_MODES = [
        ['ARAM', '칼바람 나락'],
        ['URF', 'U.R.F.'],
        ['NEXUSBLITZ', '돌격! 넥서스'],
        ['SWIFTPLAY', '신속 대전'],
        ['ONEFORALL', '단일 챔피언']
    ];

    // ══════════════════════════════════════════════════════════════
    //  ★★ 주문 상세 수치 (2026-08-26)
    //
    //  DD 는 `tooltip` 에 **변수 자리만** 주고(`{{ smitebasedamage }}`) `datavalues` 가
    //  9개 전부 비어 있다. 진짜 값은 게임 bin(`Shared/Spells/<이름>`)에 있고,
    //  **문장은 stringtable 의 `generatedtip_summonerspell_<이름>_tooltip`** 에 있다.
    //  **구조가 챔피언 스킬과 똑같다** — `@변수@` 를 bin 값으로 갈아 끼우면 된다.
    //
    //  ★ 변수 출처 세 군데:
    //     ① `DataValues` 의 `{name, values[]}`   — 대부분 (SmiteBaseDamage 등)
    //     ② `mSpell` 의 직접 필드                 — Cooldown · AmmoRechargeTime
    //     ③ `mSpellCalculations` 의 계산식        — **레벨에 따라 변하는 넷**
    //        (회복 80→318 · 방어막 100→460 · 점화 70/+20/6렙부터 +25 · 유체화 이속)
    //  ★ 이름 대소문자가 어긋나는 자리가 있다 — 툴팁은 `@MovespeedMod@` 인데 bin 은
    //    `MoveSpeedMod` 다. **소문자로 맞춰 찾는다** (아이템 `FiddleSticks` 와 같은 함정).
    const SPELL_OBJ = {
        '1': 'SummonerBoost', '3': 'SummonerExhaust', '4': 'SummonerFlash',
        '6': 'SummonerHaste', '7': 'SummonerHeal', '11': 'SummonerSmite',
        '12': 'SummonerTeleport', '14': 'SummonerDot', '21': 'SummonerBarrier'
    };
    const spellMiss = [];

    // 레벨 1~18 값을 뽑는다. 계산식 종류 둘 다 게임이 쓰는 그대로다.
    //   ★★ `mDisplayAsPercent` 는 **라이엇이 "이건 퍼센트로 보여라" 고 적어 둔 것**이다.
    //     유체화 이동 속도가 그 자리인데, 안 보면 화면에 `0.24 ~ 0.48` 이 나간다
    //     (문장에 `%` 기호가 없어서 값 쪽에 붙여야 한다).
    function levelValues(calc) {
        const part = (calc && calc.mFormulaParts || [])[0];
        if (!part) return null;
        const t = part.__type || '';
        const pct = !!calc.mDisplayAsPercent;
        const done = (vals) => ({ vals, pct });

        if (/ByCharLevelInterpolation/.test(t)) {
            const a = part.mStartValue || 0, b = part.mEndValue || 0;
            // 레벨 1 이 시작값, 레벨 18 이 끝값인 선형 보간
            return done(Array.from({ length: 18 }, (_, i) => a + (b - a) * i / 17));
        }
        if (/ByCharLevelBreakpoints/.test(t)) {
            // 레벨1 값에서 시작해 레벨마다 더한다. 중간에 증가폭이 바뀌는 지점(breakpoint)이 있다.
            const out = [part.mLevel1Value || 0];
            let step = part.mInitialBonusPerLevel || 0;
            const bps = part.mBreakpoints || [];
            for (let lv = 2; lv <= 18; lv++) {
                const bp = bps.find(x => x.mLevel === lv);
                if (bp) step = bp.mBonusPerLevelAtAndAfter;
                out.push(out[out.length - 1] + step);
            }
            return done(out);
        }
        return null;
    }

    const numText = (v) => String(Math.round(v * 1000) / 1000);

    // ★★ 주문의 **변형**. 지금은 순간이동 하나뿐이다 (2026-08-26).
    //   ★ 강타에도 셋이 있는데(강력 강타·붉은 충전 강타·원시의 강타) **안 넣었다** —
    //     툴팁이 `@spell.SummonerSmite:FirstPVPDamage@` 처럼 **다른 주문의 값을 참조**하는
    //     문법을 쓰고, 붉은 충전 강타는 `TooltipImmolatingBurnDamage` 를 못 채운다.
    //     그 자리는 화면에 `@이름@` 이 그대로 나가므로 참조 문법을 지원하기 전에는 넣으면 안 된다.
    //   ★ 강타는 **정글 펫 3종**에 대응하는 변형이 있다. 이름이 셋 다 "원시의 강타" 라
    //     펫 이름으로 갈라 준다 (툴팁 첫 문장도 펫 이름으로 시작한다).
    //   ★ 옛 시즌의 `S5_SummonerSmitePlayerGanker`(강력 강타)·`S5_SummonerSmiteDuel`
    //     (붉은 충전 강타)은 안 넣는다 — 지금 협곡의 강타 강화는 정글 펫 쪽이다.
    const SPELL_UPGRADE = {
        '12': [{ obj: 'S12_SummonerTeleportUpgrade', tip: 's12_summonerteleportupgrade', when: '10분 이후' }],
        '11': [
            { obj: 'SummonerSmiteAvatarOffensive', when: '새끼 화염발톱' },
            { obj: 'SummonerSmiteAvatarDefensive', when: '새끼 이끼쿵쿵이' },
            { obj: 'SummonerSmiteAvatarUtility', when: '새끼 바람돌이' }
        ]
    };

    // 주문 하나의 본문 문장을 만든다. 못 채운 변수가 있으면 그 자리를 원문 그대로 남기고 경고한다.
    //   `objName`/`tipName` 을 주면 그 객체로 만든다 (변형용). 안 주면 주문 본체다.
    function spellTooltip(key, objName, tipName) {
        const obj = objName || SPELL_OBJ[key];
        if (!obj) return null;
        const sp = (sharedBin['Shared/Spells/' + obj] || {}).mSpell;
        const raw = strings['generatedtip_summonerspell_' + (tipName || obj.toLowerCase()) + '_tooltip'];
        if (!sp || !raw) { spellMiss.push(`${obj} (bin ${!!sp} / tip ${!!raw})`); return null; }

        // 한 객체에서 값 표 셋을 뽑는다 (아래 참조 문법이 다른 객체에도 이걸 쓴다)
        const tablesOf = (spell) => {
            const dv = {};
            (spell.DataValues || []).forEach(d => { if (d.name) dv[d.name.toLowerCase()] = (d.values || [])[0]; });
            const calcs = {};
            Object.entries(spell.mSpellCalculations || {}).forEach(([k, v]) => { calcs[k.toLowerCase()] = v; });
            return {
                dv, calcs,
                plain: {
                    cooldown: ((spell.Cooldown || {}).values || [])[0],
                    ammorechargetime: (spell.mAmmoRechargeTime || [])[0]
                }
            };
        };
        const self = tablesOf(sp);
        const dv = self.dv, plain = self.plain, calcs = self.calcs;

        let body = (String(raw).match(/<mainText>([\s\S]*?)<\/mainText>/) || [, String(raw)])[1];
        // ★ 다른 툴팁을 끼워 넣는 `{{ ... }}` 는 뜻이 통하는 문장이 아니라 통째로 지운다
        //   (`{{ Item_KeywordDefinition_Wounds }}` 같은 것 — 인게임에서 hover 로 뜨는 용어 설명이다).
        body = body.replace(/\{\{[^}]*\}\}/g, '');
        // ★★ 그러면 **그 앞의 `<br>` 이 남는다.** 개수가 주문마다 달라서 설명과 아래 구분선
        //   사이 여백이 제각각이 됐다 (2026-08-26 지적 — 점화 4개 · 유체화 2개 · 나머지 0개).
        //   끝의 줄바꿈을 자르고, 문장 중간에 3개 이상 연속된 것도 두 개로 줄인다.
        body = body
            .replace(/(?:\s|<br\s*\/?>)+$/gi, '')
            .replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>')
            .trim();

        const graphs = [];      // 레벨 스케일 자리 → 각주 그래프
        const missing = [];
        // ★★ `@spell.<객체>:<변수>@` 는 **다른 주문의 값을 참조**하는 문법이다 (2026-08-26).
        //   강타 변형들이 이걸 쓴다 — 자기 DataValues 는 비워 두고
        //   `@spell.SummonerSmite:FirstPVPDamage@` 처럼 본체 값을 그대로 가져다 쓴다.
        const filled = body.replace(/@(?:spell\.([A-Za-z0-9_]+):)?([A-Za-z0-9_.]+)(\*([0-9.]+))?@/g,
            (m, ref, name, _x, mul) => {
            const lc = name.toLowerCase();
            const factor = mul ? Number(mul) : 1;

            // 참조가 있으면 그 객체의 표를 쓴다. 없는 객체면 못 채운 자리로 둔다.
            let T = self;
            if (ref) {
                const other = (sharedBin['Shared/Spells/' + ref] || {}).mSpell;
                if (!other) { missing.push(`spell.${ref}:${name}`); return m; }
                T = tablesOf(other);
            }
            const dv = T.dv, plain = T.plain, calcs = T.calcs;

            let v = dv[lc];
            if (v === undefined) v = plain[lc];
            if (v !== undefined) return numText(v * factor);

            const lv = levelValues(calcs[lc]);
            if (lv) {
                // 퍼센트 자리면 100 을 곱하고 `%` 를 붙인다 (문장에 기호가 없다)
                const k = factor * (lv.pct ? 100 : 1);
                const scaled = lv.vals.map(x => Math.round(x * k * 100) / 100);
                const label = `${numText(scaled[0])} ~ ${numText(scaled[17])}${lv.pct ? '%' : ''}`;
                graphs.push({ a: label, t: '레벨별 값', c: '#a78bfa', v: scaled });
                return label;
            }
            missing.push(name);
            return m;
        });

        if (missing.length) spellMiss.push(`${obj}: ${[...new Set(missing)].join(', ')}`);
        // ★★ 못 채운 자리가 있으면 **그 문장을 안 쓴다.** 화면에 `@이름@` 이 그대로 나가느니
        //   변형 칸을 통째로 빼는 게 낫다 (본체는 `d` 로 물러난다).
        return { text: filled, graphs, ok: !missing.length };
    }

    const spells = {};
    Object.values(ddSumm.data)
        .filter(s => s.modes.includes('CLASSIC'))
        .sort((a, b) => Number(a.key) - Number(b.key))
        .forEach(s => {
            // 못 쓰는 주요 모드만 담는다 — 다 쓸 수 있으면 빈 배열이라 화면에 아무것도 안 뜬다
            const no = MAIN_MODES.filter(([code]) => !s.modes.includes(code)).map(([, kor]) => kor);
            // ★ 수치가 든 본문. 못 만들면 `dt` 를 안 담고 화면이 DD 의 짧은 설명(`d`)으로 물러난다.
            const tip = spellTooltip(s.key);
            // 변형(강력 순간이동 · 원시의 강타 3종). 이름은 stringtable 의 displayname 그대로다.
            //   ★ 못 채운 변수가 있는 변형은 뺀다 ( 가 false) — 화면에  이 나가면 안 된다.
            const up = (SPELL_UPGRADE[s.key] || []).map(spec => {
                const t = spellTooltip(s.key, spec.obj, spec.tip);
                if (!t || !t.text || !t.ok) return null;
                const dn = strings['generatedtip_summonerspell_' + (spec.tip || spec.obj.toLowerCase()) + '_displayname'];
                return { n: dn || spec.obj, w: spec.when, d: t.text, ...(t.graphs.length ? { g: t.graphs } : {}) };
            }).filter(Boolean);
            spells[s.key] = {
                n: s.name,
                d: s.description,
                cd: s.cooldownBurn,
                r: s.rangeBurn,
                lv: s.summonerLevel,
                i: s.image.full,
                ...(no.length ? { no } : {}),
                ...(tip && tip.text ? { dt: tip.text } : {}),
                ...(tip && tip.graphs.length ? { g: tip.graphs } : {}),
                ...(up.length ? { up } : {})
            };
        });

    // ★ 통계 탭 "최종 아이템" 이 쓸 이름 표. **도감보다 넓다** — 도감은 살 수 있는 것만
    //   215종인데, 최종 6칸에는 무라마나(3042)·추적자의 팔목(2422)처럼 **못 사는 아이템**이
    //   그대로 남아 있다 (실측 상위 30종 안에 둘 다 있다). 협곡(maps 11)이면 다 담는다.
    const itemNames = {};
    Object.entries(all).forEach(([id, it]) => {
        if (it.maps && it.maps['11'] && it.name) itemNames[id] = it.name.replace(/<[^>]+>/g, '');
    });

    const data = { v: DD_VER, items, runes, styles, shards, shardRows, spells };
    const body = JSON.stringify(data);
    const out = `// 자동 생성 — build_codex_data.js (${new Date().toISOString().slice(0, 10)}, DD ${DD_VER})
// 도감 탭 데이터. 아이템·룬·소환사 주문의 한국어 이름/설명/수치/조합식.
// 손으로 고치지 말 것 — 패치 때 다시 생성된다. 거르는 규칙은 build_codex_data.js 주석 참고.
const codexData = ${body};
`;

    console.log(`아이템 ${Object.keys(items).length}개 (전체 ${Object.keys(all).length}개 중)`);
    const EP_NAME = { 0: '기본', 1: '시작', 4: '서사급', 5: '전설급', 7: '상위(영약·신발 업그레이드)' };
    const byEp = {};
    Object.values(items).forEach(x => byEp[x.ep] = (byEp[x.ep] || 0) + 1);
    console.log(`  등급별: ${Object.entries(byEp).sort((a, b) => a[0] - b[0])
        .map(([k, v]) => `${EP_NAME[k] || '???'}(epicness ${k}) ${v}개`).join(' / ')}`);
    // ★ 모르는 등급 값이 나오면 app.js 의 CODEX_EPICNESS 에 칸을 추가해야 한다.
    //   안 그러면 그 아이템이 등급 버튼 어디에도 안 걸려 목록에서 통째로 사라진다.
    const unknownEp = Object.keys(byEp).filter(k => !(k in EP_NAME));
    if (unknownEp.length) console.log(`  ★ 처음 보는 epicness: ${unknownEp.join(', ')} — app.js 의 CODEX_EPICNESS 를 고칠 것`);
    if (noBin.length) console.log(`  ★ bin 에 없는 아이템 ${noBin.length}개(등급 0 으로 처리): ${noBin.join(', ')}`);
    console.log(`  조합 재료 누락: ${brokenFrom}건`);
    // ★ 역할군 분포. 겹치는 게 정상이라 합계가 215 를 넘는다.
    //   0 인 아이템(어느 역할군에도 없음)이 몇 개인지가 볼 값이다 — 화면에서 '전체' 로만 찾을 수 있다.
    const ROLE_NAME = { 1: '전사', 2: '원거리 딜러', 4: '암살자', 8: '탱커', 16: '마법사', 32: '서포터' };
    const roleCount = Object.entries(ROLE_NAME)
        .map(([bit, nm]) => `${nm} ${Object.values(items).filter(x => x.ra & Number(bit)).length}`).join(' / ');
    const noRole = Object.values(items).filter(x => !x.ra);
    console.log(`  역할군(bin mItemAttributes): ${roleCount}`);
    if (noRole.length) console.log(`  ★ 역할군이 없는 아이템 ${noRole.length}개: ${noRole.map(x => x.n).slice(0, 12).join(', ')}${noRole.length > 12 ? ' …' : ''}`);

    const rcList = Object.entries(items).filter(([, x]) => x.rc);
    console.log(`  챔피언 전용: ${rcList.length}개 — ${rcList.map(([id, x]) => `${x.n}(${id}) ${x.rc}`).join(' / ') || '없음'}`);
    // ★ 한글로 못 바꾼 자리. 화면에 영문이 그대로 나가므로 champion.json 쪽 키를 확인할 것
    if (rcMissed.length) console.log(`  ★ 한글 이름을 못 찾은 requiredChampion: ${[...new Set(rcMissed)].join(', ')} — champion.json 에 그 키가 없다`);
    const tagCount = {};
    Object.values(items).forEach(x => x.g2.forEach(t => tagCount[t] = (tagCount[t] || 0) + 1));
    console.log(`  태그: ${Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join(' ')}`);
    console.log(`룬 ${Object.keys(runes).length}개 (perks.json ${perks.length}개 중) / 계열 ${Object.keys(styles).length} / 파편 ${Object.keys(shards).length}`);
    console.log(`  줄 배치: ${Object.values(styles).map(st => st.n + ' ' + st.sl.map(r => r.length).join('-')).join(' / ')} / 파편 ${shardRows.map(r => r.length).join('-')}`);
    if (oddStyle) console.log(`  ★ 파편 줄이 계열마다 다르다 (${oddStyle.name}) — 도감 파편 격자를 계열별로 갈라야 한다`);
    console.log(`소환사 주문 ${Object.keys(spells).length}개 (전체 ${Object.keys(ddSumm.data).length}개 중)`);
    const noList = Object.values(spells).filter(s => s.no);
    console.log(`  다른 모드에서 못 쓰는 주문: ${noList.length}개 — ${noList.map(s => `${s.n}(${s.no.join('·')})`).join(' / ') || '없음'}`);
    const withTip = Object.values(spells).filter(s => s.dt).length;
    const withGraph = Object.values(spells).filter(s => s.g).length;
    console.log(`  수치가 든 본문: ${withTip}/${Object.keys(spells).length}개 (레벨 그래프 ${withGraph}개)`);
    // ★ 못 채운 변수가 있으면 그 자리가 화면에 `@이름@` 으로 그대로 나간다 — 반드시 볼 것
    const upList=Object.values(spells).filter(s=>s.up);
    if (upList.length) console.log(`  변형: ${upList.map(s=>s.n+" → "+s.up.map(u=>u.n+(u.w?"("+u.w+")":"")).join("·")).join(" / ")}`);
    if (spellMiss.length) console.log(`  ★★ 주문 변수를 못 채웠다: ${spellMiss.join(' / ')}`);
    console.log(`\n크기 ${(Buffer.byteLength(out) / 1024).toFixed(0)}KB  gzip ${(zlib.gzipSync(Buffer.from(out), { level: 9 }).length / 1024).toFixed(0)}KB  brotli ${(zlib.brotliCompressSync(Buffer.from(out)).length / 1024).toFixed(0)}KB`);

    // 이름 표는 별도 파일이다 — 통계 탭이 도감 데이터 160KB 를 받게 할 수는 없다.
    const namesOut = `// 자동 생성 — build_codex_data.js (${new Date().toISOString().slice(0, 10)}, DD ${DD_VER})
// 아이템 id → 한국어 이름. 통계 탭의 "최종 아이템" 이 쓴다.
// ★ 도감(codex_data.js)보다 넓다 — 도감은 **살 수 있는 것** 만이고 여기는 협곡(maps 11) 전부다.
//   최종 6칸에는 무라마나처럼 못 사는(업그레이드) 아이템이 그대로 남기 때문이다.
const itemNames = ${JSON.stringify(itemNames)};
`;
    console.log(`아이템 이름 표 ${Object.keys(itemNames).length}종 (${(Buffer.byteLength(namesOut) / 1024).toFixed(1)}KB)`);

    if (WRITE) {
        const dest = path.join(__dirname, 'public', 'codex_data.js');
        fs.writeFileSync(dest, out);
        console.log(`→ ${dest}`);
        fs.writeFileSync(path.join(__dirname, 'public', 'item_names.js'), namesOut);
        console.log(`→ ${path.join(__dirname, 'public', 'item_names.js')}`);
    } else {
        console.log('(--write 를 붙여야 파일을 만든다)');
    }
})().catch(e => { console.error(e); process.exit(1); });
