// ==========================================
// [0] 전역 변수 및 챔피언, 툴팁 정보 캐싱
// ==========================================
// ★ 이 기본값은 **동기화가 실패했을 때만** 쓰이지만, 그때 챔피언 목록이 이 버전으로 만들어진다.
//   그래서 "신규 챔피언이 다 들어 있는 버전" 이어야 한다.
//   16.5.1 은 챔피언이 172명뿐이라 로크가 없었다 (16.15.1 은 233명). 2026-08-10 올림.
//   새 챔피언이 목록에서 안 보이면 제일 먼저 이 값을 의심할 것.
let ddragonVersion = "16.16.1";
let allMatches = [];
let activeFilters = [];
let championIdMap = {};

let rateLimitUnlockTime = 0;
let toastTimer = null;

let fullRuneData = {};
let runePathMap = {};

// ★ 툴팁 데이터를 담을 전역 저장소
let globalItemMap = {};
let globalSpellMap = {};
let runeDataMap = {};

let arenaAugmentMap = {};

async function fetchArenaAugments() {
    try {
        const res = await fetch('/api/arena/augments');
        if (res.ok) arenaAugmentMap = await res.json();
    } catch (e) {
        console.error("아레나 증강체 데이터 로드 실패", e);
    }
}

// 증강체 아이콘 4~6개를 렌더링
function renderAugments(augments, size = 22) {
    if (!augments || augments.length === 0) return '';
    return augments.map(id => {
        const a = arenaAugmentMap[id];
        if (!a || !a.icon) {
            return `<div class="aug-icon empty" style="width:${size}px;height:${size}px;"></div>`;
        }
        return `<img src="${a.icon}" class="aug-icon" style="width:${size}px;height:${size}px;" data-tt-type="augment" data-tt-id="${id}">`;
    }).join('');
}

// 아레나: 참가자 18명을 "조 번호" 기준으로 6팀으로 묶고 등수 순으로 정렬
//   - 묶는 키는 subteam(조 번호). placement로 묶으면 등수가 0인 참가자가
//     자기 팀에서 떨어져 나가 그룹이 7개가 되거나 남의 팀에 끼어든다.
//   - 조의 등수는 조원 중 유효한 값 하나를 쓴다.
function groupArenaTeams(participantsArray) {
    const groups = {};
    (participantsArray || []).forEach(p => {
        const tid = Number(p.subteam) || 0;
        if (!groups[tid]) groups[tid] = { subteam: tid, placement: 0, members: [] };
        const pl = Number(p.placement) || 0;
        if (pl && !groups[tid].placement) groups[tid].placement = pl;
        groups[tid].members.push(p);
    });
    return Object.values(groups).sort((a, b) => (a.placement || 99) - (b.placement || 99));
}

// 아레나 등수 표기
function placementText(n) {
    if (!n) return '-';
    return n === 1 ? '우승' : `${n}위`;
}

function placementClass(n) {
    if (n === 1) return 'place-1';
    if (n === 2) return 'place-2';
    if (n === 3) return 'place-3';
    return 'place-low';
}

// ============================================================
// 스펠 아이콘
//   하드코딩 spellMap에 없는 ID(아레나 전용 스펠 등)를 만나면 예전에는
//   || "SummonerFlash" / || "SummonerDot" 으로 폴백해서 엉뚱한 아이콘을 그렸다.
//   ddragon summoner.json이 id -> 이미지이름을 이미 갖고 있으므로 그걸 먼저 쓰고,
//   그래도 모르는 ID면 거짓말 대신 빈 칸을 그린다.
// ============================================================
function spellIconUrl(id) {
    const name = (globalSpellMap[id] && globalSpellMap[id].img) || spellMap[id];
    if (!name) return null;
    return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/spell/${name}.png`;
}

function spellImg(id) {
    const url = spellIconUrl(id);
    if (!url) return `<span class="spell-unknown" title="알 수 없는 스펠"></span>`;
    return `<img src="${url}" data-tt-type="spell" data-tt-id="${id}">`;
}
window.matchTimelineCache = {};   // ★ 추가
window.currentPuuid = null;       // ★ 추가

const statRuneMap = {
    5001: "perk-images/StatMods/StatModsHealthScalingIcon.png", 5002: "perk-images/StatMods/StatModsArmorIcon.png", 5003: "perk-images/StatMods/StatModsMagicResIcon.png",
    5005: "perk-images/StatMods/StatModsAttackSpeedIcon.png", 5007: "perk-images/StatMods/StatModsCDRScalingIcon.png", 5008: "perk-images/StatMods/StatModsAdaptiveForceIcon.png",
    5011: "perk-images/StatMods/StatModsHealthPlusIcon.png", 5013: "perk-images/StatMods/StatModsTenacityIcon.png", 5010: "perk-images/StatMods/StatModsMovementSpeedIcon.png"
};

const statRuneDataMap = {
    5001: { name: "체력", desc: "레벨에 비례해 체력이 증가합니다." },
    5002: { name: "방어력", desc: "방어력이 6 증가합니다." },
    5003: { name: "마법 저항력", desc: "마법 저항력이 8 증가합니다." },
    5005: { name: "공격 속도", desc: "공격 속도가 10% 증가합니다." },
    5007: { name: "스킬 가속", desc: "레벨에 비례해 스킬 가속이 증가합니다." },
    5008: { name: "적응형 능력치", desc: "적응형 능력치가 9 증가합니다." },
    5010: { name: "이동 속도", desc: "이동 속도가 2% 증가합니다." },
    5011: { name: "체력", desc: "체력이 65 증가합니다." },
    5013: { name: "강인함", desc: "강인함 및 둔화 저항이 10% 증가합니다." }
};

// ★ 라이엇 공식 텍스트 정규식 클리너
function cleanTooltipText(text) {
    if (!text) return "";
    let cleaned = text.replace(/<br\s*\/?>/gi, '\n');
    cleaned = cleaned.replace(/<li[^>]*>/gi, '\n- ');
    cleaned = cleaned.replace(/<[^>]+>/g, '');
    return cleaned.trim();
}

// ==========================================
// ★ 최신 데이터 드래곤 로드 로직
// ==========================================
// ★ 버전 동기화가 **끝날 때까지 기다릴 수 있게** 약속을 들고 있는다 (2026-08-10).
//   챔피언 탭은 `ddragonVersion` 으로 champion.json 을 받는데, 동기화가 끝나기 전에
//   탭을 열면 기본값으로 받아 버린다. **기본값 16.5.1 에는 챔피언이 172명뿐이라
//   로크 같은 신규 챔피언이 목록에서 통째로 사라진다** (최신 16.15.1 은 233명).
//   CLAUDE.md 의 "구버전 champion.json 을 읽으면 신규 챔피언이 사라진다" 와 같은 사고인데,
//   그때는 서버 응답이 덮어쓰는 경로였고 이번엔 **경주(race)** 가 원인이다.
let ddragonReady = null;

async function initDdragonVersion() {
    try {
        const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
        const versions = await res.json();
        ddragonVersion = versions[0]; // 접속하자마자 무조건 제일 최신 패치 버전으로 동기화!
        console.log("최신 데이터 드래곤 적용 완료:", ddragonVersion);
    } catch (e) {
        console.warn('데이터 드래곤 버전 로드 실패, 기본값 사용');
    }
}

// 패치 버전 비교. a 가 더 새것이면 양수.
function compareDdragonVersion(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x - y;
    }
    return 0;
}

async function fetchRuneMap() {
    if (Object.keys(fullRuneData).length > 0) return;
    try {
        const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/runesReforged.json`);
        const data = await res.json();
        data.forEach(tree => {
            fullRuneData[tree.id] = tree;
            runePathMap[tree.id] = tree.icon;
            tree.slots.forEach(slot => {
                slot.runes.forEach(rune => {
                    runePathMap[rune.id] = rune.icon;
                    runeDataMap[rune.id] = { name: rune.name, desc: cleanTooltipText(rune.longDesc || rune.shortDesc) };
                });
            });
        });
    } catch (e) { }
}

async function fetchItemData() {
    if (Object.keys(globalItemMap).length > 0) return;
    try {
        const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/item.json`);
        const data = await res.json();
        for (const key in data.data) {
            globalItemMap[key] = {
                name: data.data[key].name,
                desc: cleanTooltipText(data.data[key].description)
            };
        }
    } catch (e) { }
}

async function fetchSpellData() {
    if (Object.keys(globalSpellMap).length > 0) return;
    try {
        const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/summoner.json`);
        const data = await res.json();
        for (const key in data.data) {
            globalSpellMap[data.data[key].key] = { name: data.data[key].name, desc: cleanTooltipText(data.data[key].description), img: data.data[key].id };
        }
    } catch (e) { }
}

window.korChampMap = {};
async function fetchChampionMap() {
    if (Object.keys(championIdMap).length > 0) return;
    try {
        const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion.json`);
        const data = await res.json();
        for (let champName in data.data) {
            const champInfo = data.data[champName];
            championIdMap[champInfo.key] = champInfo.id;
            window.korChampMap[champInfo.id] = champInfo.name;
            // 역할군도 같이 담는다. 전적 페이지의 "플레이한 역할군" 이 이 표를 본다.
            //   ★ showChampions() 와 같은 표(champRoleMap)를 채우고 조건도 같아야 한다 —
            //     클래식 챔피언이 섞이면 스탯 탭의 역할군 평균 모집단이 흔들린다.
            if (!isClassicChamp(champInfo.id)) {
                champRoleMap[champInfo.id] = (champInfo.tags || []).map(t => t.toLowerCase());
            }
        }
    } catch (e) { }
}

const spellMap = { 1: "SummonerBoost", 3: "SummonerExhaust", 4: "SummonerFlash", 6: "SummonerHaste", 7: "SummonerHeal", 11: "SummonerSmite", 12: "SummonerTeleport", 13: "SummonerMana", 14: "SummonerDot", 21: "SummonerBarrier", 32: "SummonerSnowball" };

// ==========================================
// [1] 초기화 및 공통 유틸리티
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // 페이지 접속 시 가장 먼저 버전 업데이트 및 툴팁 정보 백그라운드 다운로드
    ddragonReady = initDdragonVersion();
    ddragonReady.then(() => {
        // ★ 공통 헤더 2단 오른쪽의 「패치 26.17」은 2026-09-08 에 뺐다 (사용자 요청).
        //   자리(#dogu-gnb-aside)는 공통 마크업에 그대로 있으니 다시 넣으려면
        //   DoguUI.setAside('패치 <b>' + patchDisplay(ddragonVersion) + '</b>') 한 줄이면 된다
        fetchChampionMap();
        fetchRuneMap();
        fetchItemData();
        fetchSpellData();
        fetchArenaAugments();
    });

    loadHomeTiers();
    loadMythicShop();
    loadPatchNotes();
    updateShopTimer();
    setInterval(updateShopTimer, 1000);

    // ★ 인게임 툴팁 UI 생성 및 이벤트 설정
    const customTooltip = document.createElement('div');
    customTooltip.id = 'info-tooltip';
    customTooltip.style.cssText = `
        position: absolute; background-color: rgba(0, 0, 0, 0.85); color: #ffffff;
        padding: 10px 14px; border-radius: 6px; font-size: 12px; line-height: 1.6;
        pointer-events: none; z-index: 10000; display: none; max-width: 260px;
        white-space: pre-wrap; box-shadow: 0 4px 10px rgba(0,0,0,0.5); text-align: left;
        border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(4px);
    `;
    document.body.appendChild(customTooltip);

    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-tt-type]');
        if (!target) return;

        const type = target.getAttribute('data-tt-type');
        const id = target.getAttribute('data-tt-id');
        let data = null;

        // 커스텀 조건문 싹 빼고 100% 라이엇 API 원본 데이터만 매칭합니다!
        if (type === 'item' && globalItemMap[id]) data = globalItemMap[id];
        else if (type === 'spell' && globalSpellMap[id]) data = globalSpellMap[id];
        else if (type === 'rune') data = runeDataMap[id] || statRuneDataMap[id];
        else if (type === 'augment' && arenaAugmentMap[id]) data = arenaAugmentMap[id];

        if (data) {
            customTooltip.innerHTML = `<span style="color:#facc15; font-weight: 700; display:block; margin-bottom:4px; font-size:13px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">${data.name}</span>${data.desc}`;
            customTooltip.style.display = 'block';
            moveTooltip(e);
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (customTooltip.style.display === 'block') moveTooltip(e);
    });

    document.addEventListener('mouseout', (e) => {
        if (e.target.closest('[data-tt-type]')) customTooltip.style.display = 'none';
    });

    function moveTooltip(e) {
        let x = e.pageX + 15;
        let y = e.pageY + 15;
        const rect = customTooltip.getBoundingClientRect();
        if (x + rect.width > window.innerWidth + window.scrollX) x = e.pageX - rect.width - 15;
        if (y + rect.height > window.innerHeight + window.scrollY) y = e.pageY - rect.height - 15;
        customTooltip.style.left = x + 'px';
        customTooltip.style.top = y + 'px';
    }

    const pathParts = window.location.pathname.split('/');
    const getQueryPage = () => {
        const params = new URLSearchParams(window.location.search);
        const pageParam = params.get('page');
        return pageParam ? parseInt(pageParam) : 1;
    };

    if (pathParts[1] && pathParts[1] !== '') {
        document.getElementById('search-section').style.display = "none";
    }

    if (pathParts[1] === 'summoner' && pathParts[2]) {
        document.getElementById('result-container').style.display = "block";
        document.getElementById('game-list').innerHTML = skelSummonerHtml();
        document.getElementById('dogu-search-input').value = decodeURIComponent(pathParts[2]);
        // /summoner/<라이엇 ID>/<경기 번호> — 친구가 받은 경기 링크. 검색이 끝나면 그 경기를 펼친다
        window.pendingMatchId = pathParts[3] ? decodeURIComponent(pathParts[3]) : null;
        executeSearch();
        setActiveNav('nav-search');   // ★ 예전엔 mountHeader 의 기본 active 가 켜 주던 자리 (2026-08-27)
    } else if (pathParts[1] === 'ranking') {
        document.getElementById('result-container').style.display = "block";
        document.getElementById('game-list').innerHTML = `<div style="min-height:100vh">${skelTableHtml(12, 44)}</div>`;
        showRanking(getQueryPage());
        // ★ 이 줄이 빠져 있어서 /ranking 을 새로고침하면 메뉴 불이 "전적검색" 에 켜졌다.
        //   index.html 에서 nav-search 가 기본 active 라, 아무도 안 바꾸면 그게 그대로 남는다.
        //   다른 분기(stats·codex·mythic·champions·masters)에는 다 있었다.
        setActiveNav('nav-ranking');
    } else if (pathParts[1] === 'masters' && HIDE_UNFINISHED_PAGES) {
        // ★ 가드를 분기 첫머리에서 본다 (2026-09-03 감사 L-12). 예전엔 컨테이너를 먼저 켜고(로딩 문구가 한 프레임
        //   번쩍) showMasters 안의 goLobby() 가 setActiveNav(null) 한 뒤 다음 줄이 nav-masters 를 다시 켰다 —
        //   홈에 있는데 숨겨진 탭이 활성인 상태. 되살릴 땐 HIDE_UNFINISHED_PAGES 만 끄면 아래 분기가 산다
        goLobby();
    } else if (pathParts[1] === 'masters') {
        document.getElementById('masters-container').style.display = "block";
        document.getElementById('masters-container').innerHTML = "<div style='text-align:center; padding:100px 0; min-height:100vh; color:var(--text-muted);'>장인 데이터를 불러오는 중입니다...</div>";
        const requestedChamp = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
        showMasters(requestedChamp);
        setActiveNav('nav-masters');
    } else if (pathParts[1] === 'stats') {
        // ★ `/stats/patch`·`/stats/duo`·`/stats/trend` 는 예약어다 (2026-09-01) —
        //   챔피언 상세(`/stats/<영문키>`)보다 먼저 갈라야 한다 (그런 이름의 챔피언은 없다).
        if (pathParts[2] === 'patch') {
            showPatchImpact();
            setActiveNav('nav-stats-patch');
        } else if (pathParts[2] === 'duo') {
            showDuoPage(pathParts[3] || null);
            setActiveNav('nav-stats-duo');
        } else if (pathParts[2] === 'trend') {
            showTrendPage(pathParts[3] || null);
            setActiveNav('nav-stats-trend');
        } else {
            document.getElementById('stats-container').style.display = "block";
            document.getElementById('stats-container').innerHTML = skelStatsPageHtml();
            // ★ `/stats/<영문키>` 는 챔피언 상세 페이지다 (2026-08-26).
            //   **popstate 쪽도 같이 고쳐야 한다** — 한쪽만 고치면 주소로 들어오는 것과
            //   뒤로가기가 다르게 동작한다 (이 저장소에서 반복해서 겪은 함정이다).
            if (pathParts[2]) showChampStatPage(decodeURIComponent(pathParts[2]), pathParts[3] ? decodeURIComponent(pathParts[3]) : null);
            else showStats();
            setActiveNav('nav-stats-live');
        }
    } else if (pathParts[1] === 'versus') {
        // ★ 챔피언 vs 챔피언 맞대결 비교 (2026-09-02, 로드맵 A-2). 헤더 메뉴는 없고
        //   챔피언 통계 상세의 상성 카드에서 들어온다 — 주소는 그대로 살아 있다.
        //   **popstate 쪽도 같이 고칠 것** (이 저장소가 반복해서 겪은 함정)
        document.getElementById('stats-container').style.display = 'block';
        if (pathParts[2] && pathParts[3]) showVersusPage(decodeURIComponent(pathParts[2]), decodeURIComponent(pathParts[3]), pathParts[4] || null);
        else showStats();
        setActiveNav('nav-stats-live');
    } else if (pathParts[1] === 'codex') {
        // /codex/item · /codex/rune · /codex/spell — 셋이 각각 헤더 메뉴다 (2026-08-27)
        document.getElementById('codex-container').style.display = "block";
        const codexTab = pathParts[2] ? decodeURIComponent(pathParts[2]) : 'item';
        showCodex(codexTab);
        setActiveNav(codexNavId(codexTab));
    } else if (pathParts[1] === 'mythic') {
        // /mythic 또는 /mythic/daily 처럼 소메뉴를 주소에 담을 수 있다 (도감과 같은 모양)
        document.getElementById('mythic-container').style.display = "block";
        showMythicShop(pathParts[2] ? decodeURIComponent(pathParts[2]) : null);
        setActiveNav('nav-mythic');
    } else if (pathParts[1] === 'privacy') {
        showPrivacyPolicy();
    } else if (pathParts[1] === 'terms') {
        showTerms();
    } else if (pathParts[1] === 'champions-classic') {
        const requestedChamp = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
        window.pendingChampView = { tab: pathParts[3] || null, skin: pathParts[4] || null };
        showChampions(requestedChamp, true);
        setActiveNav('nav-champions-classic');
    } else if (pathParts[1] === 'patch') {
        // /patch/live · /patch/pbe — 없으면 본서버 (2026-08-27)
        document.getElementById('patch-container').style.display = "block";
        showPatchNotes(pathParts[2] ? decodeURIComponent(pathParts[2]) : 'live');
    } else if (pathParts[1] === 'esports') {
        showEsports();
    } else if (pathParts[1] === 'broadcast') {
        showBroadcast();
    } else if (pathParts[1] === 'champions') {
        // /champions/<id>/<탭>/<스킨번호> — 뒤 두 조각은 있을 때만 쓴다
        const requestedChamp = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
        window.pendingChampView = { tab: pathParts[3] || null, skin: pathParts[4] || null };
        showChampions(requestedChamp);
        setActiveNav('nav-champions');
    } else {
        document.getElementById('search-section').style.display = "flex";
        if (window.DoguUI) DoguUI.setHome(true);
    }
});

window.addEventListener('popstate', (event) => {
    const currentPath = window.location.pathname;

    if (currentPath.startsWith('/summoner/')) {
        const seg = currentPath.split('/');
        document.getElementById('dogu-search-input').value = decodeURIComponent(seg[2]);
        window.pendingMatchId = seg[3] ? decodeURIComponent(seg[3]) : null;
        executeSearch();
        setActiveNav('nav-search');
    } else if (currentPath === '/ranking') {
        const params = new URLSearchParams(window.location.search);
        const targetPage = params.get('page') ? parseInt(params.get('page')) : 1;

        if (fullRankingData.length > 0) {
            hideAllContainers();
            const resultBox = document.getElementById('result-container');
            resultBox.style.display = "block";
            resultBox.classList.add('is-ranking');   // ★ showRanking 과 같이 고칠 것
            loadRankCutoffs().then(() => {
                const side = document.querySelector('.rank-side');
                if (side) side.outerHTML = rankCutoffSideHtml();
            });

            const sidebarArea = document.getElementById('sidebar-area');
            const filterArea = document.getElementById('filter-area');
            const summaryArea = document.getElementById('summary-stats-area');
            if (sidebarArea) sidebarArea.style.display = "none";
            if (filterArea) filterArea.style.display = "none";
            if (summaryArea) summaryArea.style.display = "none";

            renderRankingHeader();
            renderRankingPage(targetPage);
        } else {
            showRanking(targetPage);
        }
        setActiveNav('nav-ranking');
    } else if (currentPath === '/privacy') {
        showPrivacyPolicy();
    } else if (currentPath === '/terms') {
        showTerms();
    } else if (currentPath.startsWith('/stats')) {
        // ★ 진입부(pathParts 분기)와 여기 두 곳을 항상 같이 고친다 — `/stats/<영문키>` 는 상세 페이지,
        //   `/stats/patch` 는 패치 영향 페이지다 (예약어, 2026-09-01)
        const seg = currentPath.split('/');
        if (seg[2] === 'patch') {
            showPatchImpact();
            setActiveNav('nav-stats-patch');
        } else if (seg[2] === 'duo') {
            showDuoPage(seg[3] || null);
            setActiveNav('nav-stats-duo');
        } else if (seg[2] === 'trend') {
            showTrendPage(seg[3] || null);
            setActiveNav('nav-stats-trend');
        } else if (seg[2]) {
            showChampStatPage(decodeURIComponent(seg[2]), seg[3] ? decodeURIComponent(seg[3]) : null);
            setActiveNav('nav-stats-live');
        } else {
            showStats();
            setActiveNav('nav-stats-live');
        }
    } else if (currentPath.startsWith('/versus')) {
        // ★ 진입부와 두 곳을 같이 고친다 (2026-09-02)
        const vs = currentPath.split('/');
        document.getElementById('stats-container').style.display = 'block';
        if (vs[2] && vs[3]) showVersusPage(decodeURIComponent(vs[2]), decodeURIComponent(vs[3]), vs[4] || null);
        else showStats();
        setActiveNav('nav-stats-live');
    } else if (currentPath.startsWith('/codex')) {
        // ★ 진입부(pathParts 분기)와 여기 두 곳을 항상 같이 고친다. 한쪽만 고치면
        //   뒤로가기로 들어왔을 때 다르게 동작한다 (랭킹 헤더에서 겪은 그 문제다).
        const seg = currentPath.split('/');
        const codexTab = seg[2] ? decodeURIComponent(seg[2]) : 'item';
        showCodex(codexTab);
        setActiveNav(codexNavId(codexTab));
    } else if (currentPath.startsWith('/mythic')) {
        // ★ 여기와 진입부(pathParts 분기)는 항상 같이 고친다 — 위 도감과 같은 이유다.
        const seg = currentPath.split('/');
        showMythicShop(seg[2] ? decodeURIComponent(seg[2]) : null);
        setActiveNav('nav-mythic');
    } else if (currentPath.startsWith('/champions-classic')) {
        // '/champions'보다 먼저 검사해야 한다. startsWith라 순서가 뒤바뀌면 이쪽으로 안 온다.
        const pathParts = currentPath.split('/');
        const champId = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
        window.pendingChampView = { tab: pathParts[3] || null, skin: pathParts[4] || null };
        showChampions(champId, true);
        setActiveNav('nav-champions-classic');
    } else if (currentPath.startsWith('/patch')) {
        // ★ 진입부와 여기 두 곳을 항상 같이 고친다
        showPatchNotes(currentPath.split('/')[2] || 'live');
    } else if (currentPath.startsWith('/esports')) {
        showEsports();
    } else if (currentPath.startsWith('/broadcast')) {
        showBroadcast();
    } else if (currentPath.startsWith('/champions')) {
        // ★ 진입부(pathParts 분기)와 **여기 두 곳을 항상 같이 고친다**
        const pathParts = currentPath.split('/');
        const champId = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
        window.pendingChampView = { tab: pathParts[3] || null, skin: pathParts[4] || null };
        showChampions(champId);
        setActiveNav('nav-champions');
    } else if (currentPath.startsWith('/masters')) {
        const pathParts = currentPath.split('/');
        const champId = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
        const existingGrid = document.getElementById('masters-champ-grid');

        if (existingGrid && existingGrid.innerHTML.trim() !== '') {
            const items = existingGrid.querySelectorAll('.champ-grid-item');
            let targetItem = Array.from(items).find(i => i.dataset.id.toLowerCase() === (champId ? champId.toLowerCase() : items[0].dataset.id.toLowerCase()));

            if (targetItem) {
                hideAllContainers();
                document.getElementById('masters-container').style.display = "block";
                items.forEach(i => i.classList.remove('active'));
                targetItem.classList.add('active');
                renderMasterRanking(targetItem.dataset.name, targetItem.dataset.id);
            } else {
                showMasters(champId);
            }
        } else {
            showMasters(champId);
        }
        setActiveNav('nav-masters');
    } else {
        goLobby();
    }
});

function showErrorToast(message) {
    const toast = document.getElementById('error-toast');
    if (message) toast.innerText = message;
    toast.classList.add('toast-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('toast-show'), 3000);
}

// 공통 검색창 흔들기 (.dogu-search-box.shake — dogu-ui.css 의 doguShakeX)
function triggerShake() {
    const searchBox = document.querySelector('.dogu-search-box');
    if (searchBox) {
        searchBox.classList.remove('shake');
        void searchBox.offsetWidth;
        searchBox.classList.add('shake');
    }
}

function clearSearchError() {
    if (window.DoguUI) DoguUI.showSearchError('');
}

// ============================================================
// 미완성 페이지 비공개 처리
//   ★ 이제 장인랭킹(showMasters) 하나만 막는다. 통계는 2026-08-15에 실제 집계로
//     바꾸면서 공개했고 이 가드를 뗐다 (mastersData.js 는 여전히 하드코딩 샘플이다).
//
//   되살릴 때:
//     1) 아래 값을 false로
//     2) index.html의 nav 주석(장인랭킹) 해제
// ============================================================
const HIDE_UNFINISHED_PAGES = true;

// ============================================================
// LoL 클래식 챔피언
//   클래식 모드가 생기면서 Data Dragon이 챔피언을 두 벌로 준다.
//     정규 : Garen      (key 86)
//     클래식: Jade_Garen (key 60086)
//   정규 챔피언 ID에는 언더스코어가 없으므로(MonkeyKing, DrMundo, TahmKench)
//   '_' 포함 여부로 가른다. 라이엇이 다른 접두사를 붙여도 자동으로 걸러진다.
// ============================================================
function isClassicChamp(id) {
    return typeof id === 'string' && id.includes('_');
}

// 챔피언 페이지가 정규/클래식 중 어느 모드로 열려 있는지
// (selectChampion이 주소를 만들 때 필요)
let currentChampMode = 'normal';

// ==========================================
// [1.5] dogu.gg 공통 UI — 헤더(2단) · 히어로 검색창 · 푸터 (2026-08-22, DOGU_UI.md)
//   public/dogu-header.js 의 DoguUI 가 마크업을 만든다. 여기서는 pixlol 만의 설정
//   (PIXLOL.KR 로고 · 돋보기 버튼 · 탭 6개 · 즐겨찾기/최근 데이터)을 꽂고 라우터에 잇는다.
//   ★ 라우터 연결은 두 줄이다 — hideAllContainers()/goLobby() 의 DoguUI.setHome(),
//     setActiveNav() 안의 DoguUI.setActiveNav(). 안 잇으면 홈/비홈 오버레이 농도가 안 바뀌고
//     네비 불이 안 붙는다.
//   ★ 이 블록은 app.js 의 **실행 코드보다 위**에 있어야 한다 — 아래 [2]절이 스크립트 실행
//     시점에 #dogu-search-input 에 리스너를 붙이므로 히어로가 그 전에 그려져 있어야 한다.
// ==========================================
const DOGU_NAV = [
    // ★ 전적검색은 2026-08-27 부터 **헤더에 안 그린다** (요청). 표에서 지우면 안 된다 —
    //   로고·⌂ 의 href '/' 와 /summoner 의 setActiveNav('nav-search') 가 이 줄을 찾는다.
    //   hidden 은 mountHeader 로 넘길 때만 걸러진다
    { key: 'search',    navId: 'nav-search',    label: '전적검색', href: '/',          go: () => goLobby(), hidden: true },
    { key: 'ranking',   navId: 'nav-ranking',   label: '랭킹',     href: '/ranking',   go: () => showRanking() },
    // ★ 통계도 하위 메뉴만 가진 부모다 (2026-09-01, 사용자 결정 — 실시간/패치 영향 둘로 갈랐다).
    //   도감·패치노트와 같은 꼴: href 가 없어 부모를 눌러도 안 움직이고 하위만 연다.
    //   옛 /stats 주소는 그대로 실시간 통계로 열린다 (라우터가 받는다).
    { key: 'stats',     navId: 'nav-stats',     label: '통계', sub: [
        { key: 'stats-live',  navId: 'nav-stats-live',  label: '실시간 통계', href: '/stats',       go: () => showStats() },
        { key: 'stats-patch', navId: 'nav-stats-patch', label: '패치 영향',   href: '/stats/patch', go: () => showPatchImpact() },
        { key: 'stats-duo',   navId: 'nav-stats-duo',   label: '조합',        href: '/stats/duo',   go: () => showDuoPage() },
        { key: 'stats-trend', navId: 'nav-stats-trend', label: '픽률 추이',   href: '/stats/trend', go: () => showTrendPage() }
    ] },
    // 패치노트도 하위 메뉴만 가진 부모다 (도감과 같은 꼴 — href 가 없어 눌러도 안 움직인다)
    { key: 'patch',     navId: 'nav-patch',     label: '패치노트', sub: [
        { key: 'patch-live', navId: 'nav-patch-live', label: '본서버 패치노트', href: '/patch/live', go: () => showPatchNotes('live') },
        { key: 'patch-pbe',  navId: 'nav-patch-pbe',  label: 'PBE 패치노트',   href: '/patch/pbe',  go: () => showPatchNotes('pbe') }
    ] },
    // ★★ 도감은 하위 메뉴만 가진 부모다 (2026-08-27, 사용자 결정) — **href 가 없어서 눌러도 아무 데도 안 간다.**
    //    공통 헤더가 href 없는 부모를 <span> 으로 그려 하위만 연다. 4칸의 차례는 페이지 안 탭 줄(CODEX_NAV)과 같아야 한다
    { key: 'codex',     navId: 'nav-codex',     label: '도감', sub: [
        { key: 'champions',   navId: 'nav-champions',   label: '챔피언',      href: '/champions',   go: () => showChampions() },
        { key: 'codex-item',  navId: 'nav-codex-item',  label: '아이템',      href: '/codex/item',  go: () => showCodex('item') },
        { key: 'codex-rune',  navId: 'nav-codex-rune',  label: '룬',          href: '/codex/rune',  go: () => showCodex('rune') },
        { key: 'codex-spell', navId: 'nav-codex-spell', label: '소환사 주문', href: '/codex/spell', go: () => showCodex('spell') }
    ] },
    { key: 'mythic',    navId: 'nav-mythic',    label: '신화상점', href: '/mythic',    go: () => showMythicShop() },
    { key: 'esports',   navId: 'nav-esports',   label: 'e스포츠',  href: '/esports',   go: () => showEsports() },
    { key: 'broadcast', navId: 'nav-broadcast', label: '방송',     href: '/broadcast', go: () => showBroadcast() },
    // 비공개: 장인랭킹(nav-masters) · 챔피언(클래식)(nav-champions-classic). 되살릴 때 여기 줄을 더한다
];

// ★ 하위 메뉴까지 평평하게 편 표 — 라우팅(doguRoute)·활성 표시(setActiveNav)는 **이걸로** 찾는다.
//   DOGU_NAV 만 훑으면 하위 4개(챔피언·아이템·룬·소환사 주문)를 못 찾는다
const DOGU_NAV_FLAT = DOGU_NAV.reduce((acc, n) => acc.concat(n, n.sub || []), []);

// 로고·⌂·푸터 링크가 가는 홈. 사이트가 pixlol.kr 루트에서 돌아가므로 '/' 가 곧 pixlol.kr 홈이다
// (절대 주소를 박으면 로컬에서 프로덕션으로 튄다)
const DOGU_HOME = '/';
const DOGU_BRAND = { brand: 'PIXLOL', tld: '.KR', home: DOGU_HOME, linkAttr: 'data-link' };

function doguSearchInput() { return document.getElementById('dogu-search-input'); }

// 공통 링크(data-link)를 pixlol 의 show* 함수로 돌린다. 공통 파일은 href 만 알고 라우터는 모른다
function doguRoute(href, navKey) {
    if (href.startsWith('/summoner/')) {
        const input = doguSearchInput();
        if (input) input.value = decodeURIComponent(href.split('/')[2] || '');
        executeSearch();
        return;
    }
    if (href === '/terms') { showTerms(); return; }
    if (href === '/privacy') { showPrivacyPolicy(); return; }
    const item = DOGU_NAV_FLAT.find(n => n.key === navKey) || DOGU_NAV_FLAT.find(n => n.href === href) || DOGU_NAV[0];
    item.go();
    // ★ 전적검색 탭은 go() 가 goLobby() 라 홈으로 간다 — 거기서 끈 밑줄을 여기서 도로 켜면 안 된다 (2026-08-27)
    if (item.key !== 'search') setActiveNav(item.navId);
}

// (게임 스위처 아이콘은 2026-08-22 부터 공통 파일이 그린다 — mountHeader 의 iconBase 로 경로만 준다.
//  예전에 여기 있던 decorateSwitcherIcons() 의 DOM 덧칠은 공통 원본과 사이즈·간격이 어긋나서 뺐다)

function mountDoguUI() {
    if (!window.DoguUI) return;

    // 1단(헤더)·히어로 검색창 둘 다 같은 길로 — 값을 히어로 입력칸에 넣고 executeSearch()
    // (executeSearch 가 그 칸을 읽는다. 나머지 호출처 20여 곳이 전부 같은 규약이라 그대로 둔다)
    const onSubmit = (q) => {
        const input = doguSearchInput();
        if (input) input.value = q;
        executeSearch();
    };
    const placeholder = '소환사명 검색 (예: Hide on bush#KR1)';

    DoguUI.mountHeader(Object.assign({}, DOGU_BRAND, {
        site: 'lol',
        iconBase: '/',                              // 스위처 아이콘 public/header_{key}.png — pixlol 은 루트에서 돈다
        gamesOrigin: 'https://dogu.gg',             // ★ 다른 게임 링크의 기준 — 안 주면 pixlol.kr/er 로 가서 제자리가 된다 (2026-08-24)
        // ★ 처음엔 아무 탭도 안 켠다 (2026-08-27). 홈에서는 공통 CSS 가 body.dogu-home 을 보고 ⌂ 에 밑줄을 준다 —
        //   예전처럼 여기서 search 를 켜 두면 홈에서 밑줄이 ⌂ 와 전적검색 둘이 된다.
        //   ★ 대신 라우터의 /summoner 분기가 setActiveNav('nav-search') 를 직접 불러야 한다 (기본 active 에 기대던 자리)
        nav: DOGU_NAV.filter(n => !n.hidden).map(n => ({
            key: n.key, label: n.label, href: n.href, active: false,
            sub: n.sub && n.sub.map(x => ({ key: x.key, label: x.label, href: x.href }))
        })),
        aside: '',                                  // 패치 버전 — initDdragonVersion 뒤에 setAside 로 채운다
        search: { placeholder, onSubmit }
    }));

    DoguUI.mountHero('#hero', Object.assign({}, DOGU_BRAND, {
        mascot: '/favicon_lol_180.png',         // 히어로 로고 왼쪽 마스코트 (공통 옵션)
        search: {
            placeholder,
            // ★★ pixlol 만 돋보기 (다른 사이트는 .GG 글자). 2026-09-08 부터 글자(DoguUI.TEXT.searchIcon = 「⌕」)가
            //   아니라 SVG 다 — 글자로는 **세로 가운데정렬이 불가능했다.** 실측: 잉크가 버튼 중심보다 5.8px 아래.
            //   글리프가 Pretendard 에 없어서 OS 기본 기호 폰트(윈도우는 Segoe UI Symbol)가 그리는데,
            //   그 글리프는 베이스라인 위에만 잉크가 있어(-16~0) 줄상자 가운데와 어긋난다. OS 마다 폰트가 달라서
            //   translateY 로 밀면 윈도우에서만 맞는다. SVG 는 viewBox 를 잉크에 딱 맞춰 어디서나 같다.
            //   ★ viewBox 「1 1 14 14」는 원(테두리 포함)과 손잡이 둥근 끝을 합친 실제 잉크 범위다 — 가로세로 14 로 같다.
            button: '<svg class="pix-search-icon" viewBox="1 1 14 14" aria-hidden="true">' +
                    '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
                    '<circle cx="9.7" cy="6.3" r="4.3"/><path d="M6.66 9.34 2 14"/></g></svg>',
            onSubmit,
            favorites: { all: getFavorites, remove: removeFavorite },
            recents:   { all: getRecents,   remove: removeRecentSearch },
            itemHref:  (name) => '/summoner/' + encodeURIComponent(name),
            onPick:    (name) => onSubmit(name)
        }
    }));

    // pixlol 고유 자동완성 상자를 공통 검색창 상자 안으로 옮긴다 (position:absolute 기준이 되도록)
    const wrap = document.querySelector('.dogu-search-wrapper');
    const ac = document.getElementById('autocomplete-dropdown');
    if (wrap && ac) wrap.appendChild(ac);

    // ★ 「PC 버전」 스위치 (2026-08-26, 사용자 요청 — 폰 브라우저의 "데스크톱 사이트" 가 안 먹어서).
    //   켜면 localStorage 에 적고 새로고침한다. 실제 뷰포트 전환은 index.html 머리의 인라인 스크립트가
    //   CSS 보다 먼저 한다 (여기서 바꾸면 첫 그림이 폰 배치로 나갔다가 튄다).
    //   터치 기기(pointer: coarse)이거나 이미 켜져 있을 때만 링크를 보인다 — PC 에서 "PC 버전" 은 뜻이 없다.
    const pcOn = (() => { try { return localStorage.getItem('pixlol_pc') === '1'; } catch (e) { return false; } })();
    const coarse = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || (navigator.maxTouchPoints > 0);
    const pcLink = (pcOn || coarse) ? [{
        id: 'pixlol-pcmode',
        text: pcOn ? '모바일 버전' : 'PC 버전',
        onClick: () => {
            try { if (pcOn) localStorage.removeItem('pixlol_pc'); else localStorage.setItem('pixlol_pc', '1'); } catch (e) { }
            location.reload();
        }
    }] : [];

    DoguUI.mountFooter(null, Object.assign({}, DOGU_BRAND, {
        links: { terms: '/terms', privacy: '/privacy' },
        extraLinks: pcLink,
        notice: "pixlol.kr isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.",
        contact: '00.y4no@gmail.com'
    }));

    // 공통 마크업의 내부 링크를 가로챈다. 드롭다운 항목은 onPick 이 이미 처리하므로 뺀다
    document.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-link]');
        if (!a || a.classList.contains('dogu-dropdown-link')) return;
        e.preventDefault();
        doguRoute(a.getAttribute('href') || '/', a.dataset.nav);
    });
}
mountDoguUI();

function setActiveNav(navId) {
    const item = DOGU_NAV_FLAT.find(n => n.navId === navId);
    if (window.DoguUI) DoguUI.setActiveNav(item ? item.key : null);
    // 탭 제목은 페이지와 무관하게 고정 — index.html <title> 과 같은 값 (2026-08-22 요청).
    // 사이트 이름은 .env 가 아니라 여기와 index.html 두 곳에 박혀 있다
    document.title = 'PIXLOL.KR: 리그오브레전드';
}

// ==========================================
//  패치노트 탭 (2026-08-27 신설)
// ==========================================
//  본서버(공식 홈페이지 목록)와 PBE(RiotPhroxzon 의 Preview 글) 둘을 목록으로 쭉 보여준다.
//  ★ 본문은 안 들여온다 — 제목을 누르면 원문(공식 페이지 / x.com)으로 나간다.
//    공식 패치노트에는 상향·하향 마커가 없어서 우리가 옮기면 "10 → 8" 의 방향을 추측하게 된다
//    (dogu_er 의 패치 페이지가 같은 이유로 목록만 싣는다).
//  ★ 자료는 홈 위젯과 **같은 `/api/patch-notes`** 다 — 여기만 `limit=100` 으로 부른다.
const PATCH_NAV = [
    { key: 'live', name: '본서버 패치노트', href: '/patch/live', navId: 'nav-patch-live' },
    { key: 'pbe',  name: 'PBE 패치노트',   href: '/patch/pbe',  navId: 'nav-patch-pbe' }
];

function patchTabsHtml(active) {
    return `<div class="codex-tabs">${PATCH_NAV.map(t =>
        `<button class="codex-tab${t.key === active ? ' active' : ''}" data-patch="${t.key}">${t.name}</button>`).join('')}</div>`;
}

// 페이지 안 2칸 줄 — 도감 4칸과 같이 **이력은 덮어쓴다**(replaceState)
document.addEventListener('click', (e) => {
    const b = e.target.closest('.codex-tab[data-patch]');
    if (!b) return;
    const t = PATCH_NAV.find(x => x.key === b.dataset.patch);
    if (!t) return;
    if (window.location.pathname !== t.href) window.history.replaceState({ page: 'patch' }, '', t.href);
    showPatchNotes(t.key);
});

async function showPatchNotes(kind) {
    const cur = PATCH_NAV.some(t => t.key === kind) ? kind : 'live';
    if (!window.location.pathname.startsWith('/patch')) {
        window.history.pushState({ page: 'patch' }, '', '/patch/' + cur);
    }
    hideAllContainers();
    const box = document.getElementById('patch-container');
    box.style.display = 'block';
    setActiveNav(PATCH_NAV.find(t => t.key === cur).navId);

    box.innerHTML = patchTabsHtml(cur) +
        `<div class="patch-page-list" id="patch-page-list">
            ${Array.from({ length: 6 }, () => '<div class="skel" style="height:96px;border-radius:12px"></div>').join('')}
        </div>`;

    let data = null;
    try {
        const res = await fetch('/api/patch-notes?limit=200');   // 공식 목록 전부 (실측 172건)
        data = await res.json();
    } catch (e) { /* 아래 폴백으로 */ }

    // ★ 그리는 사이에 다른 화면으로 옮겼으면 버린다 (느린 응답이 새 화면을 덮어쓰지 않게)
    if (!window.location.pathname.startsWith('/patch')) return;
    const list = document.getElementById('patch-page-list');
    if (!list) return;

    const items = (cur === 'pbe' ? data && data.pbe : data && data.official) || [];
    if (!items.length) {
        const href = cur === 'pbe'
            ? 'https://x.com/RiotPhroxzon'
            : 'https://www.leagueoflegends.com/ko-kr/news/tags/patch-notes/';
        const label = cur === 'pbe' ? 'X 프로필에서 보기 →' : '공식 홈페이지에서 보기 →';
        list.innerHTML = `<div class="patch-page-empty">패치노트를 불러오지 못했습니다.<br>
            <a class="patch-note-x-link" href="${href}" target="_blank" rel="noopener">${label}</a></div>`;
        return;
    }
    list.innerHTML = items.map(n => cur === 'pbe' ? pbeNoteRowHtml(n) : patchNoteRowHtml(n)).join('');
}

// 본서버 — 썸네일 + 제목 + 한 줄 요약 + 날짜, 오른쪽에 패치 번호
function patchNoteRowHtml(n) {
    const thumb = n.thumb
        ? `<img src="${escapeHtml(n.thumb)}" alt="" loading="lazy" onerror="this.remove()">`
        : '';
    const desc = n.desc ? `<em class="patch-page-desc">${escapeHtml(n.desc)}</em>` : '';
    const ver = n.version ? `<span class="patch-page-ver">${escapeHtml(n.version)}</span>` : '';
    return `<a class="patch-page-item" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">
        <span class="patch-page-thumb">${thumb}</span>
        <span class="patch-page-info">
            <b class="patch-page-title">${escapeHtml(n.title)}</b>
            ${desc}
            <span class="patch-page-date">${patchDateText(n.date)}</span>
        </span>${ver}</a>`;
}

// PBE — 그림이 없다 (x.com 글이라). 그 자리엔 큰 패치 번호를 둔다
//   (2026-08-31, 260830 디자인 8-2 — "PBE" 빈 박스 반복이 밋밋하다는 지적. 상세/간단도 여기서 갈린다)
function pbeNoteRowHtml(n) {
    const title = `PBE 서버 ${n.patch} 패치 [${n.detail ? '상세' : '간단'}]`;
    return `<a class="patch-page-item is-pbe" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">
        <span class="patch-page-thumb"><span class="patch-page-pbe-mark${n.detail ? ' is-detail' : ''}"><b>${escapeHtml(n.patch)}</b><i>${n.detail ? '상세 프리뷰' : '간단 프리뷰'}</i></span></span>
        <span class="patch-page-info">
            <b class="patch-page-title">${escapeHtml(title)}</b>
            <em class="patch-page-desc">RiotPhroxzon · x.com</em>
            <span class="patch-page-date">${patchDateText(n.date)}</span>
        </span>
        <span class="patch-page-ver">${escapeHtml(n.patch)}</span></a>`;
}

function patchDateText(iso) {
    const d = iso ? new Date(iso) : null;
    const p = x => String(x).padStart(2, '0');
    return d && !isNaN(d) ? `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}` : '';
}

// 도감 탭 키 → 헤더 활성 표시용 navId (라우터 두 곳이 같이 쓴다)
function codexNavId(tab) {
    const t = CODEX_NAV.find(x => x.key === tab);
    return t ? t.navId : 'nav-codex-item';
}

// ★ 준비 중 페이지 (2026-08-27) — 내용은 공통 파일의 comingSoonHtml 하나다.
//   나중에 진짜 내용을 채울 땐 이 함수 안만 갈아 끼우면 된다
function showComingPage(containerId, title, path, navId) {
    if (!window.location.pathname.startsWith(path)) {
        window.history.pushState({ page: navId }, '', path);
    }
    hideAllContainers();
    const box = document.getElementById(containerId);
    box.style.display = 'block';
    box.innerHTML = `
        <div class="stats-header" style="margin-bottom: 20px; display: flex; align-items: center; justify-content: center; gap: 15px; height: 80px;">
            <h1 class="ranking-title">${title}</h1>
        </div>` +
        (window.DoguUI ? DoguUI.comingSoonHtml(DOGU_BRAND) : '');
    setActiveNav(navId);
}
function showEsports() { showComingPage('esports-container', 'e스포츠', '/esports', 'nav-esports'); }
function showBroadcast() { showComingPage('broadcast-container', '방송', '/broadcast', 'nav-broadcast'); }

function hideAllContainers() {
    document.querySelectorAll('.page-container').forEach(container => {
        container.style.display = "none";
    });

    // ★ 홈(히어로)이 아닌 화면은 공통 오버레이를 진하게 (body.dogu-home 을 뗀다).
    //   페이지를 갈아 끼우는 길목이 여기 하나라 홈 판정도 여기서 한다. 홈은 goLobby() 가 켠다
    if (window.DoguUI) DoguUI.setHome(false);

    // 랭킹 탭에서만 통을 넓혔던 것을 되돌린다 (안 벗기면 전적검색 화면까지 넓어진다)
    const resultBox = document.getElementById('result-container');
    if (resultBox) resultBox.classList.remove('is-ranking');

    clearSearchError();
    if (window.refreshTimerInterval) clearInterval(window.refreshTimerInterval);

    // ★ 메뉴를 옮기면 스크롤을 맨 위로 되돌린다 (2026-08-19).
    //   랭킹 탭만 renderRankingPage 가 알아서 올려 주고 나머지는 스크롤이 내려간 채
    //   새 화면이 나왔다. 페이지를 갈아 끼우는 유일한 길목이 여기라 여기서 한 번에 처리한다.
    window.scrollTo(0, 0);
}

function goLobby() {
    if (window.location.pathname !== '/') window.history.pushState(null, '', '/');
    hideAllContainers();
    document.getElementById('search-section').style.display = "flex";
    if (window.DoguUI) DoguUI.setHome(true);     // 홈 — 오버레이를 옅게
    document.getElementById('dogu-search-input').value = "";
    hideAutocomplete();
    setActiveNav(null);      // 홈은 어떤 탭의 페이지도 아니다 — 밑줄은 ⌂ 가 받는다 (2026-08-27)
}

// ==========================================
// [2] 전적 검색 및 모스트 챔피언
// ==========================================
// ★ 검색 버튼 클릭·Enter 는 공통 히어로의 <form submit> 이 받아 mountDoguUI 의 onSubmit 으로 온다.
//   여기선 입력이 바뀌면 오류 문구만 지운다
document.getElementById('dogu-search-input').addEventListener('input', clearSearchError);

async function executeSearch() {
    const inputName = document.getElementById('dogu-search-input').value.trim();

    clearSearchError();

    hideAutocomplete();

    if (!inputName) {
        if (window.DoguUI) DoguUI.showSearchError("소환사명을 입력해 주세요.");
        triggerShake();
        return;
    }

    // 태그 없이 닉네임만 입력한 경우 → 같은 닉네임의 태그 후보 목록 표시
    if (!inputName.includes('#')) {
        await showCandidates(inputName);
        return;
    }

    hideAllContainers();
    // ★ 랭킹 표에서 소환사를 눌러 들어오면 랭킹 밑줄이 남아 있었다 (2026-09-03 감사 3-6-2) —
    //   라우터 직진입·popstate 에만 이 줄이 있고 페이지 안 검색 경로에는 없었다.
    //   nav-search 는 hidden 이라 "아무 탭도 안 켜짐" 이 맞는 상태다
    setActiveNav('nav-search');
    document.getElementById('result-container').style.display = "block";
    document.getElementById('user-profile').innerHTML = "";
    const sidebarArea = document.getElementById('sidebar-area');
    if (sidebarArea) sidebarArea.style.display = "none";
    const filterArea = document.getElementById('filter-area');
    if (filterArea) filterArea.style.display = "none";
    const summaryArea = document.getElementById('summary-stats-area');
    if (summaryArea) summaryArea.style.display = "none";
    document.getElementById('game-list').innerHTML = skelSummonerHtml();

    try {
        const response = await fetch(`/api/summoner/${encodeURIComponent(inputName)}`);

        if (response.status === 429) {
            renderSearchFail("서버 요청이 많아 지연되고 있습니다.\n잠시 후 다시 시도해주세요.");
            return;
        }

        if (response.status === 404) {
            renderSearchFail("해당 유저를 찾을 수 없습니다.\n정확한 닉네임과 태그로 검색해 주세요.");
            return;
        }

        if (!response.ok) throw new Error("서버 통신 중 오류가 발생했습니다.");

        const data = await response.json();

        if (data.error) throw new Error(data.error);

        if (data.isCachedFallback) {
            showErrorToast("서버 지연으로 최근 저장된 과거 데이터를 표시합니다.\n잠시 후 다시 갱신해주세요.");
        }

        addRecentSearch(data.profile.name);

        // ★ 서버가 주는 version 은 서버가 부팅할 때 받아 둔 값이라 클라이언트가 이미
        //   맞춰 둔 최신보다 오래된 경우가 있다 (갱신 실패 시 server.js 기본값 16.1.1).
        //   그대로 덮어쓰면 챔피언 탭이 구버전 champion.json 을 읽어서
        //   신규 챔피언이 목록에서 통째로 사라진다. 로크가 정확히 이 경우였다.
        //   (16.1.1 / 16.5.1 = 172명, 로크 없음 / 16.15.1 = 로크 있음)
        //   그래서 "더 새 것일 때만" 받아들인다.
        if (data.version && compareDdragonVersion(data.version, ddragonVersion) > 0) {
            ddragonVersion = data.version;
        }
        window.currentPuuid = data.puuid || null;    // ★ 추가
        allMatches = data.history || [];
        // 새 소환사를 검색하면 챔피언 필터는 초기화 (큐 필터는 유지)
        activeChampFilter = null;
        updateChampFilterBtn();

        window.champDetailCache = window.champDetailCache || {};
        const uniqueChamps = [...new Set(allMatches.map(m => m.championName))];
        await Promise.all(uniqueChamps.map(async champName => {
            if (!window.champDetailCache[champName]) {
                try {
                    const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion/${champName}.json`);
                    const detailData = await res.json();
                    window.champDetailCache[champName] = detailData.data[champName].spells.map(s => ({ img: s.image.full, max: s.maxrank }));
                } catch (e) { }
            }
        }));

        await fetchChampionMap();
        await fetchRuneMap();
        await fetchItemData();
        await fetchSpellData();

        activeFilters = [];

        hideAllContainers();
        document.getElementById('result-container').style.display = "block";
        const sidebar = document.getElementById('sidebar-area');
        if (sidebar) sidebar.style.display = "flex";

        window.scrollTo(0, 0);

        document.getElementById('user-profile').innerHTML = `
            <div class="profile-header">
                <img src="${data.profile.icon}" class="profile-icon">
                <div class="profile-info">
                    <div class="profile-level">레벨 ${data.profile.level}</div>
                    <h2 class="profile-name">${data.profile.name}</h2>
                    <div id="profile-fav-wrap"></div>
                </div>
                <div class="profile-actions">
                    <button id="refresh-btn" class="refresh-btn profile-action-btn">전적 갱신</button>
                    <button id="live-btn" class="profile-action-btn live-btn" onclick="toggleLiveGamePanel()" disabled>인게임 정보</button>
                </div>
            </div>
            <div id="live-game-area"></div>
        `;

        const rawTier = data.profile.tier || "Unranked";
        const rawRank = data.profile.rank || "";
        const safeTier = rawTier.split(' ')[0].toLowerCase();

        // ★ 점수와 승패 데이터 변수 할당
        const lp = data.profile.leaguePoints || 0;
        const wins = data.profile.wins || 0;
        const losses = data.profile.losses || 0;
        const totalGames = wins + losses;

        let displayRank = rawRank;
        if (["MASTER", "GRANDMASTER", "CHALLENGER"].includes(rawTier.toUpperCase())) displayRank = "";

        // ★ 1. 티어 텍스트 옆에 LP 합치기 (Unranked가 아닐 때만)
        let finalTierText = `${rawTier} ${displayRank}`.trim();
        if (safeTier !== 'unranked') {
            finalTierText += ` <span style="font-size: 14px; font-weight: normal; color: #ffffff;">${lp} LP</span>`;
        }

        // ★ 2. 승패 및 승률 계산 (소수점 2자리 고정)
        let winRateHtml = '';
        if (totalGames > 0) {
            const winRate = ((wins / totalGames) * 100).toFixed(2);
            const wrColor = winRate >= 50.00 ? 'var(--win)' : 'var(--lose-text)';
            winRateHtml = `<div style="font-size: 12px; color: #ffffff; margin-top: 4px;">
                ${wins}W ${losses}L <span style="color: ${wrColor}; margin-left: 5px;">${winRate}%</span>
            </div>`;
        }

        let sidebarHtml = `
            <div class="pix-box pix-tier-box">
                <div class="pix-tier-icon">
                    <img src="https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${safeTier}.png" 
                         class="${safeTier === 'unranked' ? 'unranked-icon' : ''}" 
                         onerror="this.src='https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/images/unranked.png'; this.className='unranked-icon'; this.onerror=null;">
                </div>
                <div class="pix-tier-info">
                    <h3>솔로랭크</h3>
                    <div class="tier-rank">${finalTierText}</div>
                    ${winRateHtml}
                </div>
            </div>
        `;

        const userPuuid = data.puuid || (data.profile && data.profile.puuid);

        // ★ LP 추이 카드 (2026-09-01, 로드맵 A-9) — 마스터+ 랭커만 기록이 있다.
        //   서버가 매일 자정 +2분에 명단 전원의 LP 를 한 점씩 남긴다 (배포일부터 — 소급 불가).
        //   기록이 없거나 하나뿐이면 "모으는 중" 안내가 뜬다.
        if (userPuuid && ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(rawTier.toUpperCase())) {
            try {
                const lpRes = await fetch(`/api/lp-history/${userPuuid}`);
                if (lpRes.ok) sidebarHtml += lpTrendCardHtml((await lpRes.json()).rows || [], lp);
            } catch (e) { }
        }

        if (userPuuid) {
            try {
                const masteryRes = await fetch(`/api/mastery/${userPuuid}`);
                if (masteryRes.ok) {
                    const masteryData = await masteryRes.json();
                    sidebarHtml += `
                        <div class="pix-box" style="padding: 20px;">
                            <h3 style="color: #fff; font-size: 14px; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">숙련도 TOP 7</h3>
                            <div style="display: flex; flex-direction: column; gap: 12px;">`;

                    masteryData.forEach((mastery, index) => {
                        const champEngName = championIdMap[mastery.championId] || '0';
                        sidebarHtml += `
                            <div style="display: flex; align-items: center; gap: 12px; background: rgba(255,255,255,0.02); padding: 8px 12px; border-radius: 8px; transition: background 0.2s;">
                                <div style="font-size: 12px; color: var(--text-faint); width: 12px; text-align: center; font-weight: 700;">${index + 1}</div>
                                <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champEngName}.png" 
                                     style="width: 36px; height: 36px; border-radius: 4px; object-fit: cover; border: 2px solid var(--accent-mid);" 
                                     onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/0.png'">
                                <div style="flex: 1;">
                                        <div style="color: var(--text-bright); font-weight: 700; font-size: 13px;">Lv. ${mastery.championLevel}</div>
                                        <div style="color: var(--text-muted); font-size: 12px;">${mastery.championPoints.toLocaleString()} pts</div>
                                    </div>
                                </div>
                            `;
                    });
                    sidebarHtml += `</div></div>`;
                }
            } catch (e) { }
        }

        // ★ 최근 같이 한 소환사 (2026-09-04, 로드맵 A-8) — **자리만 만들어 둔다.**
        //   큐 필터를 따라가야 해서 여기서 그리면 안 된다 — applyMatchFilters 가 채운다
        //   (그게 첫 렌더·필터 클릭·더 보기 세 경로를 전부 거쳐 가는 유일한 자리다).
        sidebarHtml += `<div id="recent-mates-area"></div>`;

        sidebar.innerHTML = sidebarHtml;
        document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));

        renderMatches(allMatches);
        window.matchOffset = allMatches.length;
        renderLoadMore(allMatches.length >= 20);

        const allBtn = document.querySelector('.filter-btn');
        if (allBtn) toggleFilter(allBtn, '전체');

        const refreshBtn = document.getElementById('refresh-btn');
        let expireAt = data.expireAt;
        if (data.isCachedFallback) expireAt = Date.now() + 120 * 1000;

        refreshBtn.addEventListener('click', executeSearch);

        function updateRefreshTimer() {
            if (!expireAt) return;
            const diff = expireAt - Date.now();
            if (diff <= 0) {
                refreshBtn.disabled = false;
                refreshBtn.style.background = "#6b3f8e";
                refreshBtn.style.cursor = "pointer";
                refreshBtn.innerText = "전적 갱신";
                if (window.refreshTimerInterval) clearInterval(window.refreshTimerInterval);
            } else {
                refreshBtn.disabled = true;
                refreshBtn.style.background = "#444";
                refreshBtn.style.cursor = "not-allowed";
                const mins = Math.floor(diff / 1000 / 60);
                const secs = String(Math.floor((diff / 1000) % 60)).padStart(2, '0');
                refreshBtn.innerText = `갱신: ${mins}분 ${secs}초`;
            }
        }
        updateRefreshTimer();
        if (window.refreshTimerInterval) clearInterval(window.refreshTimerInterval);
        window.refreshTimerInterval = setInterval(updateRefreshTimer, 1000);

        currentProfileName = data.profile.name;
        renderProfileFavBtn();

        checkLiveGame(data.puuid || (data.profile && data.profile.puuid));

        // 경기 링크로 들어왔으면 주소에서 경기 번호를 떨어뜨리지 않는다.
        // 안 그러면 펼치기도 전에 /summoner/<이름> 으로 바뀌어 새로고침 때 링크가 죽는다.
        const newUrl = `/summoner/${encodeURIComponent(inputName)}`
            + (window.pendingMatchId ? `/${encodeURIComponent(window.pendingMatchId)}` : '');
        if (window.location.pathname !== newUrl) {
            window.history.pushState({ summoner: inputName }, '', newUrl);
        }

        openPendingMatch();

    } catch (e) {
        console.error("전적 화면 렌더링 에러:", e);
        renderSearchFail("서버 요청이 많아 지연되고 있습니다.\n잠시 후 다시 시도해주세요.");
    }
}

// ★ 검색이 실패했을 때 목록 자리에 상태를 남긴다 (2026-09-03 감사 3-6-1).
//   예전엔 토스트만 띄우고 return 해서 **스켈레톤이 영영 남았다** — `/summoner/<없는 유저>` 직링크로
//   들어오면 API 는 404 를 즉시 주는데 화면은 10초 뒤에도 뼈대 그대로였다. 토스트는 3초면 사라진다.
//   공유 링크가 유입 경로라 죽은 링크의 첫인상이 빈 화면이면 안 된다. 토스트도 그대로 띄운다
function renderSearchFail(message) {
    showErrorToast(message);
    const list = document.getElementById('game-list');
    if (!list) return;
    list.innerHTML = `<div class="stats-empty">${escapeHtml(message).replace(/\n/g, '<br>')}<br>
        <a href="/" data-link class="stat-back">← 홈으로</a></div>`;
}

// ★ 참가자 이름 클릭 → 그 사람 검색 (2026-09-03 감사 H-4).
//   예전엔 `onclick="...value='${p.summonerName}'"` 로 닉네임을 문자열에 박아서 `D'Arcy` 같은
//   아포스트로피 하나에 **그 카드만 클릭이 통째로 죽었다** — 랭킹 표에서 이미 겪고 고친 함정인데
//   전적 카드·상세 표 다섯 자리에는 안 옮겨져 있었다. data-search-name + 위임 하나다 —
//   카드를 매번 새로 그려도 리스너는 살아 있다. 값은 escapeHtml 을 거쳐 속성에 들어간다
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-search-name]');
    if (!el) return;
    const input = document.getElementById('dogu-search-input');
    if (!input) return;
    input.value = el.dataset.searchName;
    executeSearch();
});

// 스킬 빌드 표 생성
function buildSkillTableHtml(game, myTimeline) {
    if (!myTimeline?.skills?.length) return '';

    const maxLevel = Math.max(15, myTimeline.skills.length);
    const spellInfos = window.champDetailCache?.[game.championName] || [];
    let counts = { 1: 0, 2: 0, 3: 0, 4: 0 };

    let html = `<div class="skill-table-wrapper"><table class="skill-table"><thead><tr><th class="skill-icon-cell"></th>`;
    for (let i = 1; i <= maxLevel; i++) html += `<th>${i}</th>`;
    html += `</tr></thead><tbody>`;

    [1, 2, 3, 4].forEach(slot => {
        counts[slot] = 0;
        const spell = spellInfos[slot - 1];
        const sImg = spell ? (typeof spell === 'string' ? spell : spell.img) : null;
        const sMax = spell && spell.max ? spell.max : (slot === 4 ? 3 : 5);
        const letter = ['Q', 'W', 'E', 'R'][slot - 1];

        let rowHtml = `<tr><td class="skill-icon-cell">${sImg ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/spell/${sImg}" title="${letter}">` : `<b style="color:#fff;">${letter}</b>`}</td>`;

        for (let i = 0; i < maxLevel; i++) {
            if (myTimeline.skills[i] === slot) {
                counts[slot]++;
                const isMastered = counts[slot] === sMax;
                const tdStyle = isMastered ? ` style="box-shadow: inset 0 0 0 2px currentColor;"` : ``;
                rowHtml += `<td class="skill-active-${slot}"${tdStyle}>${counts[slot]}</td>`;
            } else {
                rowHtml += `<td></td>`;
            }
        }
        html += rowHtml + `</tr>`;
    });
    return html + `</tbody></table></div>`;
}

// 아이템 빌드 순서 생성
function buildItemOrderHtml(myTimeline) {
    if (!myTimeline?.items?.length) return '';

    let groupedItems = [];
    let currentGroup = [];

    myTimeline.items.forEach((item) => {
        if (currentGroup.length === 0) currentGroup.push(item);
        else {
            const lastItem = currentGroup[currentGroup.length - 1];
            if (item.ts - lastItem.ts <= 20000) currentGroup.push(item);
            else { groupedItems.push(currentGroup); currentGroup = [item]; }
        }
    });
    if (currentGroup.length > 0) groupedItems.push(currentGroup);

    let html = `<div class="build-items">`;
    html += groupedItems.map((grp) => {
        const firstTs = grp[0].ts;
        const mins = String(Math.floor(firstTs / 60000)).padStart(2, '0');
        const secs = String(Math.floor((firstTs % 60000) / 1000)).padStart(2, '0');
        let grpHtml = `<div class="item-group-col"><div class="item-row">`;
        grp.forEach(item => {
            grpHtml += `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${item.id}.png" data-tt-type="item" data-tt-id="${item.id}">`;
        });
        return grpHtml + `</div><div class="build-item-time">${mins}:${secs}</div></div>`;
    }).join('<div class="build-item-arrow">▶</div>');
    return html + `</div>`;
}

// 타임라인 확보 (캐시 우선, 없으면 서버 요청)
async function ensureTimeline(matchId) {
    const cached = window.matchTimelineCache[matchId];
    if (cached?.loaded) return cached;

    try {
        const puuidParam = window.currentPuuid ? `?puuid=${window.currentPuuid}` : '';
        const res = await fetch(`/api/timeline/${matchId}${puuidParam}`);
        if (!res.ok) throw new Error('timeline fetch failed');
        const data = await res.json();
        window.matchTimelineCache[matchId] = { ...data, loaded: true };
        return window.matchTimelineCache[matchId];
    } catch (e) {
        window.matchTimelineCache[matchId] = { goldFrames: null, myTimeline: null, loaded: true };
        return window.matchTimelineCache[matchId];
    }
}

function renderMatches(matches, append = false) {
    const listDiv = document.getElementById('game-list');
    const filterArea = document.getElementById('filter-area');
    if (filterArea) filterArea.style.display = "flex";
    if (!append) listDiv.innerHTML = "";

    if (!append && (!matches || matches.length === 0)) {
        listDiv.innerHTML = `<div style="text-align: center; padding: 60px 0; color: var(--text-muted); line-height: 1.6;">전적 데이터가 없습니다.<br><span style="font-size: 12px; color: var(--text-faint);">(최근 20게임 기준)</span></div>`;
        return;
    }

    const champNameExceptions = { "FiddleSticks": "Fiddlesticks" };

    matches.forEach(game => {
        if (!game.participants || game.participants.length === 0) return;
        if (champNameExceptions[game.championName]) game.championName = champNameExceptions[game.championName];

        const isArena = !!game.isArena;
        const isAram = !!game.isAram;
        const isRemake = !isArena && (game.isRemake === true || game.durationMin < 4);

        // 아레나는 승/패가 아니라 등수로 색을 정한다 (1위 금색 / 2~3위 상위권 / 4~6위 하위권)
        const myPlacement = isArena ? (Number(game.placement) || 0) : 0;
        let resultClass, winText, queueColor;

        if (isArena) {
            if (myPlacement === 1) { resultClass = 'win arena-first'; queueColor = '#facc15'; }
            else if (myPlacement >= 2 && myPlacement <= 3) { resultClass = 'win'; queueColor = 'var(--win)'; }
            else { resultClass = 'lose'; queueColor = 'var(--lose)'; }
            winText = placementText(myPlacement);
        } else if (isRemake) {
            resultClass = 'remake'; winText = '다시하기'; queueColor = '#7b7a8e';
        } else {
            resultClass = game.win ? 'win' : 'lose';
            winText = game.win ? '승리' : '패배';
            queueColor = game.win ? 'var(--win)' : 'var(--lose)';
        }

        let exactDateText = '상세 시간 정보 없음';
        let displayDate = game.dateStr;

        if (game.timestamp) {
            const now = Date.now();
            const timeDiff = now - game.timestamp;
            const diffMinutes = Math.floor(timeDiff / (1000 * 60));
            const diffHours = Math.floor(timeDiff / (1000 * 60 * 60));
            const diffDays = Math.floor(timeDiff / (1000 * 60 * 60 * 24));

            // 화면을 그리는 시점(Date.now())이 기준. 30일이 넘으면 전부 "1개월 전"으로
            // 뭉개지던 것을 개월/년까지 단계화했다.
            if (diffHours < 1) displayDate = diffMinutes <= 0 ? "방금 전" : `${diffMinutes}분 전`;
            else if (diffHours < 24) displayDate = `${diffHours}시간 전`;
            else if (diffDays < 30) displayDate = `${diffDays}일 전`;
            else if (diffDays < 365) displayDate = `${Math.max(1, Math.round(diffDays / 30.44))}개월 전`;
            else displayDate = `${Math.floor(diffDays / 365)}년 전`;

            const durationMs = (game.durationMin * 60 + game.durationSec) * 1000;
            const startTime = new Date(game.timestamp - durationMs);
            const endTime = new Date(game.timestamp);

            const formatCustomDate = (date) => {
                const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
                let h = date.getHours(); const ampm = h >= 12 ? '오후' : '오전'; h = h % 12 || 12;
                const hh = String(h).padStart(2, '0'), mm = String(date.getMinutes()).padStart(2, '0'), ss = String(date.getSeconds()).padStart(2, '0');
                return `${y}.${m}.${d} ${ampm} ${hh}:${mm}:${ss}`;
            };
            exactDateText = `${formatCustomDate(startTime)}\n~ ${formatCustomDate(endTime)}`;
        }

        const runeMap = { 8000: '7201_Precision', 8100: '7200_Domination', 8200: '7202_Sorcery', 8300: '7203_Whimsy', 8400: '7204_Resolve' };
        const mainRuneImg = `https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${runeMap[game.mainRune] || '7200_Domination'}.png`;
        const subRuneImg = `https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${runeMap[game.subRune] || '7204_Resolve'}.png`;

        let itemsHtml = `<div class="pix-items">`;

        [0, 1, 2, 6].forEach(i => {
            const id = game[`item${i}`];
            const tClass = (i === 6) ? " trinket" : "";
            itemsHtml += id ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png" class="${tClass.trim()}" data-tt-type="item" data-tt-id="${id}">` : `<div class="empty${tClass}"></div>`;
        });

        [3, 4, 5].forEach(i => {
            const id = game[`item${i}`];
            itemsHtml += id ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png" data-tt-type="item" data-tt-id="${id}">` : `<div class="empty"></div>`;
        });

        const item7 = game[`item7`];
        if (item7) {
            itemsHtml += `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${item7}.png" style="width: 28px; height: 28px; border-radius: 3px;" data-tt-type="item" data-tt-id="${item7}">`;
        } else {
            itemsHtml += `<div class="empty"></div>`;
        }

        itemsHtml += `</div>`;

        const badgeHtml = buildBadges(game, isArena, isAram);

        const renderTeamList = (participantsArray, targetTeamId) => {
            return participantsArray.filter(p => p.teamId === targetTeamId).map(p => {
                const shortName = p.summonerName.split('#')[0];
                const isMeStyle = p.isSearchedUser ? "font-weight: 700; color: #fff;" : "";
                return `
                    <div class="pix-player" data-search-name="${escapeHtml(p.summonerName)}" style="cursor:pointer;" title="${escapeHtml(p.summonerName)} 검색">
                        <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${p.championName}.png" alt="${p.championName}">
                        <span style="${isMeStyle}">${escapeHtml(shortName)}</span>
                    </div>
                `;
            }).join('');
        };

        // 아레나 미리보기: 1~3위는 왼쪽 열, 4~6위는 오른쪽 열 (일반 게임의 블루/레드팀과 같은 폭)
        const renderArenaTeams = (participantsArray) => {
            const teams = groupArenaTeams(participantsArray);

            const renderCol = (list) => `
                <div class="arena-col">
                    ${list.map(t => {
                        const mine = t.members.some(m => m.isSearchedUser);
                        return `
                        <div class="arena-team ${mine ? 'mine' : ''}" title="${t.placement ? placementText(t.placement) : '등수 없음'}">
                            <span class="arena-team-rank ${placementClass(t.placement)}">${t.placement || '-'}</span>
                            ${t.members.map(p => `
                                <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${p.championName}.png"
                                     class="${p.isSearchedUser ? 'me' : ''}"
                                     title="${escapeHtml(p.summonerName)}"
                                     data-search-name="${escapeHtml(p.summonerName)}">
                            `).join('')}
                        </div>`;
                    }).join('')}
                </div>`;

            return renderCol(teams.slice(0, 3)) + renderCol(teams.slice(3, 6));
        };

        const me = game.participants.find(p => p.isSearchedUser);
        if (!me) return;
        const supportItems = [3869, 3870, 3871, 3873, 3874, 3875, 3876, 3877];
        const isSupport = [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6].some(id => supportItems.includes(id));

        let statsHtml = '';
        if (isArena) {
            const totalMins = game.durationMin + (game.durationSec / 60);
            const dpm = totalMins > 0 ? Math.round(me.damage / totalMins) : 0;
            statsHtml = `
                <div class="kp">골드 ${me.gold.toLocaleString()}</div>
                <div>DPM ${dpm.toLocaleString()}</div>
            `;
        } else if (isSupport) {
            statsHtml = `
                <div class="kp">킬관여 ${game.kp}%</div>
                <div style="display: flex; align-items: center; justify-content: flex-start; gap: 3px;">
                    <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/2055.png" style="width: 12px; height: 12px; border-radius: 50%; transform: translateY(1.5px);">
                    <span style="color: #fff; font-weight: 700;">${me.visionWards}</span>
                    <span style="font-size: 12px; margin-left: 2px; cursor: help;" data-tooltip="와드 설치 / 와드 파괴">(+${me.wardsPlaced}/-${me.wardsKilled})</span>
                </div>
                <div>시야점수 ${me.visionScore}</div>
            `;
        } else {
            const totalMins = game.durationMin + (game.durationSec / 60);
            const dpm = totalMins > 0 ? Math.round(me.damage / totalMins) : 0;
            statsHtml = `
                <div class="kp">킬관여 ${game.kp}%</div>
                <div>CS ${me.cs} <span style="font-size:12px;">(${game.csPerMin})</span></div>
                <div>DPM ${dpm.toLocaleString()}</div>
            `;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'match-wrapper';
        wrapper.dataset.matchId = game.matchId;                     // 경기 링크로 찾아올 때 쓴다
        wrapper.dataset.queue = game.queueType;                    // 표시용 라벨
        wrapper.dataset.group = game.queueGroup || '기타';          // 필터용 그룹
        wrapper.dataset.champ = game.championName || '';            // 챔피언 필터용

        const summary = document.createElement('div');
        summary.className = `pix-game ${resultClass}`;

        summary.innerHTML = `
            <div class="pix-info">
                <div class="queue" style="color: ${queueColor};">${game.queueType}</div>
                <div data-tooltip="${exactDateText}" style="cursor: help; width: fit-content;">${displayDate}</div>
                <div class="bar"></div>
                <div class="win-text">${winText}</div>
                <div>${game.durationMin}분 ${game.durationSec}초</div>
            </div>
            <div class="pix-champ ${isArena ? 'arena' : ''}">
                <div class="pix-champ-icon">
                    <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${game.championName}.png">
                    <div class="pix-level">${game.champLevel}</div>
                    ${badgeHtml} 
                </div>
                ${isArena
                ? `<div class="pix-augments">${renderAugments(game.augments, 22)}</div>`
                : `<div class="pix-spells">
                    ${spellImg(game.spell1)}
                    ${spellImg(game.spell2)}
                </div>
                <div class="pix-spells">
                    <img src="${mainRuneImg}" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/7200_Domination.png'" data-tt-type="rune" data-tt-id="${game.mainRune}">
                    <img src="${subRuneImg}" style="width:22px; height:22px; border-radius:50%; background:#202d37; padding:2px;" data-tt-type="rune" data-tt-id="${game.subRune}">
                </div>`}
            </div>
            <div class="pix-kda">
                <div class="pix-kda-score">${game.kills} / <span class="d">${game.deaths}</span> / ${game.assists}</div>
                <!-- 표기 두 벌: 데스크톱 "평점 5.40" / 폰 "5.40:1 평점" (op.gg 모바일 표기).
                     CSS 가 한쪽만 보여준다 — 글자를 CSS 로는 못 바꿔서 둘 다 그려 둔다.
                     숫자가 아닌 값(Perfect)에 ":1" 을 붙이면 "Perfect:1" 이 되므로 뺀다 -->
                <div class="pix-kda-ratio"><span class="kda-ratio-pc">평점 ${game.kda}</span><span class="kda-ratio-m">${/^[\d.]+$/.test(String(game.kda)) ? `${game.kda}:1 평점` : `${game.kda}`}</span></div>
            </div>
            <div class="pix-stats">
                ${statsHtml}
            </div>
            <div class="pix-items-box">
                ${itemsHtml} 
            </div>
            ${isArena
                ? `<div class="pix-players arena-players">${renderArenaTeams(game.participants)}</div>`
                : `<div class="pix-players">
                <div class="pix-team">${renderTeamList(game.participants, 100)}</div>
                <div class="pix-team">${renderTeamList(game.participants, 200)}</div>
            </div>`}
            <button class="share-btn" type="button" title="이 경기 주소 복사" onclick="copyMatchLink(event, this, '${game.matchId}')">
                <svg viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
            </button>
            <button class="toggle-btn" onclick="
                const wrapper = this.closest('.match-wrapper');
                if (!wrapper.classList.contains('open')) {
                    const firstTab = wrapper.querySelector('.detail-tab-btn');
                    if (firstTab) firstTab.click();
                }
                wrapper.classList.toggle('open');
            ">
                <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
        `;

        const maxDamage = Math.max(...game.participants.map(p => p.damage));
        const maxDamageTaken = Math.max(...game.participants.map(p => p.damageTaken));

        // ★ 참가자 티어 배지 (2026-09-01) — 마스터+ 명단에 있으면 초상화 왼쪽에 미니 문장.
        //   한 명이라도 있어야 자리(18px)를 만든다 — 아무도 없는 판(일반·칼바람)에 빈 칸을 두면
        //   이름 시작점만 밀린다. 협곡 표와 아레나 표(renderArenaDetail)가 같이 쓴다.
        const anyTier = game.participants.some(x => x.rankTier);
        const tierSlot = (p) => anyTier
            ? `<span class="detail-tier-slot">${p.rankTier
                ? `<img src="${RANK_MEDAL_BASE}${rankTierInfo(p.rankTier[0]).icon}.png" alt=""
                       title="${rankTierInfo(p.rankTier[0]).name} · ${p.rankTier[1].toLocaleString()} LP" loading="lazy">`
                : ''}</span>`
            : '';

        const blueWon = game.participants.find(p => p.teamId === 100)?.win;
        const redWon = game.participants.find(p => p.teamId === 200)?.win;
        const blueHeaderClass = blueWon ? 'team-blue-header' : 'team-red-header';
        const blueBodyClass = blueWon ? 'team-blue' : 'team-red';
        const redHeaderClass = redWon ? 'team-blue-header' : 'team-red-header';
        const redBodyClass = redWon ? 'team-blue' : 'team-red';

        const renderDetailRow = (p) => {
            const pMainRune = `https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${runeMap[p.mainRune] || '7200_Domination'}.png`;
            const pSubRune = `https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${runeMap[p.subRune] || '7204_Resolve'}.png`;

            let pItems = `<div class="detail-items" style="display:flex; flex-direction:column; gap:1px; align-items:center;">
                            <div style="display:flex; gap:1px;">`;
            [0, 1, 2, 6].forEach(i => {
                const id = p[`item${i}`];
                const tClass = (i === 6) ? " trinket" : "";
                pItems += id ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png" class="${tClass.trim()}" style="width:20px; height:20px; border-radius:3px;" data-tt-type="item" data-tt-id="${id}">` : `<div class="empty${tClass}" style="width:20px; height:20px; background:rgba(0,0,0,0.3); border-radius:3px;"></div>`;
            });
            pItems += `</div><div style="display:flex; gap:1px;">`;
            [3, 4, 5].forEach(i => {
                const id = p[`item${i}`];
                pItems += id ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png" style="width:20px; height:20px; border-radius:3px;" data-tt-type="item" data-tt-id="${id}">` : `<div class="empty" style="width:20px; height:20px; background:rgba(0,0,0,0.3); border-radius:3px;"></div>`;
            });

            const pItem7 = p.item7;
            if (pItem7) {
                pItems += `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${pItem7}.png" style="width: 20px; height: 20px; border-radius: 3px;" data-tt-type="item" data-tt-id="${pItem7}">`;
            } else {
                pItems += `<div class="empty" style="width:20px; height:20px; background:rgba(0,0,0,0.3); border-radius:3px;"></div>`;
            }

            pItems += `</div></div>`;

            const dmgPercent = maxDamage > 0 ? (p.damage / maxDamage) * 100 : 0;
            const dmgTakenPercent = maxDamageTaken > 0 ? (p.damageTaken / maxDamageTaken) * 100 : 0;
            const kdaRatio = p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(2);
            const isMeStyle = p.isSearchedUser ? 'background: rgba(255,255,255,0.08); font-weight: 700;' : '';
            const kpColor = 'var(--text-muted)';

            const totalMins = game.durationMin + (game.durationSec / 60);
            const pCsPerMin = totalMins > 0 ? (p.cs / totalMins).toFixed(1) : "0.0";

            return `
                <tr style="${isMeStyle}">
                    <td class="detail-champ-col">
                        <div class="champ-name-wrapper">
                            ${tierSlot(p)}
                            <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${p.championName}.png">
                            <div class="detail-summoner" data-search-name="${escapeHtml(p.summonerName)}" title="${escapeHtml(p.summonerName)}">${escapeHtml(p.summonerName)}</div>
                        </div>
                    </td>
                    <td class="detail-spell-rune-col">
                        <div class="spell-rune-wrapper">
                            <div class="detail-spells">
                                ${spellImg(p.spell1)}
                                ${spellImg(p.spell2)}
                            </div>
                            <div class="detail-runes">
                                <img src="${pMainRune}" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/7200_Domination.png'">
                                <img src="${pSubRune}" class="sub">
                            </div>
                        </div>
                    </td>
                    <td style="color: #fff; font-size: 12px; font-weight: 700;">${p.champLevel || '-'}</td>
                    <td>
                        <div class="detail-kda">${p.kills} / <span class="d">${p.deaths}</span> / ${p.assists}</div>
                        <div style="color: var(--text-muted); font-size: 12px;">(${kdaRatio})</div>
                    </td>
                    <td style="color: ${kpColor}; font-weight: 700; font-size: 12px;">${p.kp}%</td>
                    <td>${pItems}</td>
                    <td style="color: var(--text-muted);">
                        <div style="color: var(--text-bright);">${p.cs} <span style="font-size: 12px; color: var(--text-muted);">(${pCsPerMin})</span></div>
                        <div style="font-size: 12px; margin-top: 2px;">${p.gold.toLocaleString()} G</div>
                    </td>
                    <td>
                        <div style="color: #fff;">${p.damage.toLocaleString()}</div>
                        <div class="damage-bar-container"><div class="damage-bar" style="width: ${dmgPercent}%;"></div></div>
                    </td>
                    <td>
                        <div style="color: #fff;">${p.damageTaken.toLocaleString()}</div>
                        <div class="damage-bar-container"><div class="damage-bar taken" style="width: ${dmgTakenPercent}%;"></div></div>
                    </td>
                    <td style="color: var(--text-muted); cursor: help;" data-tooltip="시야 점수: ${p.visionScore || 0}">
                        <div style="display: flex; align-items: center; justify-content: center; gap: 3px;">
                            <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/2055.png" style="width: 12px; height: 12px; border-radius: 50%; transform: translateY(1.5px);">
                            <span style="color: #fff;">${p.visionWards}</span>
                        </div>
                        <div style="font-size: 12px; margin-top: 2px;">+${p.wardsPlaced} / -${p.wardsKilled}</div>
                    </td>
                </tr>
            `;
        };

        // 아레나 상세: 등수별로 묶은 표
        const renderArenaDetail = () => {
            const teams = groupArenaTeams(game.participants);

            const rows = teams.map(t => {
                const members = t.members;
                const header = `
                    <thead>
                        <tr class="arena-group-header">
                            <th colspan="10" style="text-align:left; padding-left:15px;">
                                <span class="arena-rank-badge ${placementClass(t.placement)}">${t.placement ? placementText(t.placement) : '순위 미상'}</span>
                            </th>
                        </tr>
                    </thead>`;

                const body = members.map(p => {
                    const kdaRatio = p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(2);
                    const isMeStyle = p.isSearchedUser ? 'background: rgba(255,255,255,0.08); font-weight: 700;' : '';
                    const dmgPercent = maxDamage > 0 ? (p.damage / maxDamage) * 100 : 0;
                    const dmgTakenPercent = maxDamageTaken > 0 ? (p.damageTaken / maxDamageTaken) * 100 : 0;

                    // 일반 상세 표와 동일한 4 + 4 배치
                    //   윗줄: item0, item1, item2, 장신구(item6)
                    //   아랫줄: item3, item4, item5, item7
                    let pItems = `<div class="detail-items" style="display:flex; flex-direction:column; gap:1px; align-items:center;">
                                    <div style="display:flex; gap:1px;">`;
                    [0, 1, 2, 6].forEach(i => {
                        const id = p[`item${i}`];
                        const tClass = (i === 6) ? " trinket" : "";
                        pItems += id
                            ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png" class="${tClass.trim()}" style="width:20px; height:20px; border-radius:3px;" data-tt-type="item" data-tt-id="${id}">`
                            : `<div class="empty${tClass}" style="width:20px; height:20px; background:rgba(0,0,0,0.3); border-radius:3px;"></div>`;
                    });
                    pItems += `</div><div style="display:flex; gap:1px;">`;
                    [3, 4, 5].forEach(i => {
                        const id = p[`item${i}`];
                        pItems += id
                            ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png" style="width:20px; height:20px; border-radius:3px;" data-tt-type="item" data-tt-id="${id}">`
                            : `<div class="empty" style="width:20px; height:20px; background:rgba(0,0,0,0.3); border-radius:3px;"></div>`;
                    });
                    pItems += p.item7
                        ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${p.item7}.png" style="width:20px; height:20px; border-radius:3px;" data-tt-type="item" data-tt-id="${p.item7}">`
                        : `<div class="empty" style="width:20px; height:20px; background:rgba(0,0,0,0.3); border-radius:3px;"></div>`;
                    pItems += `</div></div>`;

                    return `
                        <tr style="${isMeStyle}">
                            <td class="detail-champ-col">
                                <div class="champ-name-wrapper">
                                    ${tierSlot(p)}
                                    <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${p.championName}.png">
                                    <div class="detail-summoner" data-search-name="${escapeHtml(p.summonerName)}" title="${escapeHtml(p.summonerName)}">${escapeHtml(p.summonerName)}</div>
                                </div>
                            </td>
                            <td class="detail-spell-rune-col">
                                <div class="detail-augments">${renderAugments(p.augments, 16) || '<span style="color:var(--text-faint);">-</span>'}</div>
                            </td>
                            <td style="color: #fff; font-size: 12px; font-weight: 700;">${p.champLevel || '-'}</td>
                            <td>
                                <div class="detail-kda">${p.kills} / <span class="d">${p.deaths}</span> / ${p.assists}</div>
                                <div style="color: var(--text-muted); font-size: 12px;">(${kdaRatio})</div>
                            </td>
                            <td style="color: var(--text-muted); font-weight: 700; font-size: 12px;">${p.kp}%</td>
                            <td>${pItems}</td>
                            <td style="color: var(--text-bright); font-size: 12px;">${(p.gold || 0).toLocaleString()} G</td>
                            <td>
                                <div style="color: #fff;">${p.damage.toLocaleString()}</div>
                                <div class="damage-bar-container"><div class="damage-bar" style="width: ${dmgPercent}%;"></div></div>
                            </td>
                            <td>
                                <div style="color: #fff;">${p.damageTaken.toLocaleString()}</div>
                                <div class="damage-bar-container"><div class="damage-bar taken" style="width: ${dmgTakenPercent}%;"></div></div>
                            </td>
                            <td class="detail-spell-rune-col">
                                <div class="spell-rune-wrapper">
                                    <div class="detail-spells">
                                        ${spellImg(p.spell1)}
                                        ${spellImg(p.spell2)}
                                    </div>
                                </div>
                            </td>
                        </tr>`;
                }).join('');

                return header + `<tbody>${body}</tbody>`;
            }).join('');

            // 아레나 밴: 참가자 1명당 1개라 18인 경기는 18개가 한 줄로 온다.
            //   라이엇이 전부 teams[0] 한 곳에 몰아 보내고 누가 밴했는지는 안 알려준다.
            //   그래서 지금은 조 구분 없이 한 줄로만 보여준다. (CLAUDE.md "아레나 밴" 절)
            const arenaBans = (game.teamStats || []).flatMap(t => t.bans || []);
            const banRow = arenaBans.length === 0 ? '' : `
                    <tbody class="arena-ban-summary">
                        <tr>
                            <td colspan="10">
                                <div class="arena-ban-box">
                                    <span class="arena-ban-label">밴 ${arenaBans.length}</span>
                                    <div class="arena-ban-list">${champBanIconsHtml(arenaBans)}</div>
                                </div>
                            </td>
                        </tr>
                    </tbody>`;

            return `
                <table class="detail-table arena-detail-table">
                    <colgroup>
                        <!-- ★ 첫 칸(소환사)만 폭을 안 정한다 (2026-08-18). 나머지 아홉 칸 합이
                             585px 이고, 남거나 모자란 폭을 이 칸이 흡수해 표가 상세 상자와 정확히 맞는다.
                             예전엔 열 칸이 다 고정이라 합이 735px 로 **상자보다 6px 넓었다.** -->
                        <col> <col style="width: 55px;"> <col style="width: 30px;"> <col style="width: 90px;"> <col style="width: 45px;"> <col style="width: 105px;"> <col style="width: 65px;"> <col style="width: 70px;"> <col style="width: 70px;"> <col style="width: 55px;"> </colgroup>
                    <thead>
                        <tr class="arena-col-header">
                            <th style="text-align:left; padding-left:15px;">소환사</th>
                            <th>증강체</th><th>레벨</th><th>KDA</th><th>킬관여</th><th>아이템</th><th>골드</th><th>피해량</th><th>받은피해량</th><th>스펠</th>
                        </tr>
                    </thead>
                    ${rows}
                    ${banRow}
                </table>`;
        };

        const detailHtml = document.createElement('div');
        detailHtml.className = 'match-detail';

        // 서버가 이미 타임라인을 보내줬으면 캐시에 넣어둠
        if (game.goldFrames || game.myTimeline) {
            window.matchTimelineCache[game.matchId] = {
                goldFrames: game.goldFrames || null,
                myTimeline: game.myTimeline || null,
                loaded: true
            };
        }

        let runesHtml = '';

        if (game.myRunes) {

            let primaryTree = fullRuneData[game.myRunes.primaryStyle];
            let subTree = fullRuneData[game.myRunes.subStyle];
            runesHtml = `<div class="rune-trees-wrap">`;

            if (primaryTree) {
                runesHtml += `
                    <div class="rune-tree" style="justify-content: flex-start;">
                        <div style="display:flex; align-items:center; gap:6px; color:#fff; font-weight: 700; margin-bottom:2px; height: 24px;">
                            <img src="https://ddragon.leagueoflegends.com/cdn/img/${primaryTree.icon}" style="width:24px;"> ${primaryTree.name}
                        </div>`;
                primaryTree.slots.forEach((slot, index) => {
                    const isKeystone = index === 0;
                    runesHtml += `<div class="rune-row" ${isKeystone ? 'style="min-height: 68px;"' : ''}>`;
                    slot.runes.forEach(rune => {
                        const isActive = game.myRunes.primarySelections.includes(rune.id);
                        const iconClass = isKeystone ? 'rune-icon keystone' : 'rune-icon';
                        runesHtml += `
                            <div class="rune-item-wrap">
                                <img src="https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}" class="${iconClass} ${isActive ? '' : 'inactive'}" style="${isActive ? 'border-color:var(--accent); background:rgba(0,0,0,0.5);' : ''}" data-tt-type="rune" data-tt-id="${rune.id}">
                                <div class="rune-name ${isActive ? 'active' : ''}">${rune.name}</div>
                            </div>`;
                    });
                    runesHtml += `</div>`;
                });
                runesHtml += `</div>`;
            }

            if (subTree) {
                runesHtml += `
                    <div class="rune-tree" style="justify-content: flex-start;">
                        <div style="display:flex; align-items:center; gap:6px; color:#fff; font-weight: 700; margin-bottom:2px; height: 24px;">
                            <img src="https://ddragon.leagueoflegends.com/cdn/img/${subTree.icon}" style="width:24px;"> ${subTree.name}
                        </div>`;
                subTree.slots.forEach((slot, index) => {
                    if (index === 0) {
                        runesHtml += `<div class="rune-row" style="min-height: 68px; width: 100%;"></div>`;
                        return;
                    }

                    runesHtml += `<div class="rune-row">`;
                    slot.runes.forEach(rune => {
                        const isActive = game.myRunes.subSelections.includes(rune.id);
                        runesHtml += `
                            <div class="rune-item-wrap">
                                <img src="https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}" class="rune-icon ${isActive ? '' : 'inactive'}" style="${isActive ? 'border-color:var(--text-muted); background:rgba(0,0,0,0.5);' : ''}" data-tt-type="rune" data-tt-id="${rune.id}">
                                <div class="rune-name ${isActive ? 'active' : ''}">${rune.name}</div>
                            </div>`;
                    });
                    runesHtml += `</div>`;
                });
                runesHtml += `</div>`;
            }

            const statGrid = [[5008, 5005, 5007], [5008, 5010, 5001], [5011, 5013, 5001]];
            runesHtml += `<div class="rune-tree" style="border-left: 1px solid rgba(255,255,255,0.1); padding-left: 30px; justify-content: flex-start;">`;

            runesHtml += `<div style="height: 26px; width: 100%;"></div>`;
            runesHtml += `<div class="rune-row" style="min-height: 68px; width: 100%;"></div>`;

            statGrid.forEach((row, rIdx) => {
                runesHtml += `<div class="rune-row" style="gap: 10px;">`;
                row.forEach(id => {
                    const isActive = game.myRunes.statPerks[rIdx] === id;
                    runesHtml += `
                        <div class="rune-item-wrap" style="width: auto; min-width: auto; gap: 4px;">
                            <img src="https://ddragon.leagueoflegends.com/cdn/img/${statRuneMap[id] || statRuneMap[5008]}" class="rune-icon stat ${isActive ? '' : 'inactive'}" style="${isActive ? 'border-color:#ccc; background:#000;' : 'filter: grayscale(1) invert(0.8) opacity(0.2);'}" data-tt-type="rune" data-tt-id="${id}">
                        </div>`;
                });
                runesHtml += `</div>`;
            });
            runesHtml += `</div>`;
            runesHtml += `</div>`;
        }

        detailHtml.innerHTML = `
            <div class="detail-tabs-header">
                <button class="detail-tab-btn active" onclick="switchDetailTab(event, '${game.matchId}', 'summary')">종합</button>
                ${isArena ? '' : `<button class="detail-tab-btn" onclick="switchDetailTab(event, '${game.matchId}', 'analysis')">타임라인</button>`}
                <button class="detail-tab-btn" onclick="switchDetailTab(event, '${game.matchId}', 'build')">빌드</button>
            </div>
            
            <div id="tab-summary-${game.matchId}" class="detail-tab-content active" style="padding: 0;">
                ${isArena ? renderArenaDetail() : `
                <table class="detail-table">
                    <colgroup>
                        <!-- ★ 첫 칸(소환사)만 폭을 안 정한다 — 위 아레나 표와 같은 이유다 -->
                        <col> <col style="width: 55px;"> <col style="width: 30px;"> <col style="width: 90px;"> <col style="width: 45px;"> <col style="width: 90px;"> <col style="width: 65px;"> <col style="width: 70px;"> <col style="width: 70px;"> <col style="width: 70px;"> </colgroup>
                    <thead>
                        <tr class="${blueHeaderClass}">
                            <th style="text-align:left; padding-left:15px;">${blueWon ? '승리' : '패배'} (블루팀)</th>
                            <th>스펠/룬</th><th>레벨</th><th>KDA</th><th>킬관여</th><th>아이템</th><th>CS/골드</th><th>피해량</th><th>받은피해량</th><th>와드</th>
                        </tr>
                    </thead>
                    <tbody class="${blueBodyClass}">${sortByLane(game.participants.filter(p => p.teamId === 100)).map(p => renderDetailRow(p)).join('')}</tbody>
                    ${renderTeamSummaryRow(game)}
                    <thead>
                        <tr class="${redHeaderClass}">
                            <th style="text-align:left; padding-left:15px;">${redWon ? '승리' : '패배'} (레드팀)</th>
                            <th>스펠/룬</th><th>레벨</th><th>KDA</th><th>킬관여</th><th>아이템</th><th>CS/골드</th><th>피해량</th><th>받은피해량</th><th>와드</th>
                        </tr>
                    </thead>
                    <tbody class="${redBodyClass}">${sortByLane(game.participants.filter(p => p.teamId === 200)).map(p => renderDetailRow(p)).join('')}</tbody>
                </table>`}
            </div>

            ${isArena ? '' : `
            <div id="tab-analysis-${game.matchId}" class="detail-tab-content" style="padding: 20px;">
                <div id="analysis-body-${game.matchId}">
                    <div class="skel" style="height:220px;border-radius:10px;margin:10px 0;"></div>
                </div>
            </div>`}

            <div id="tab-build-${game.matchId}" class="detail-tab-content">
                ${runesHtml === ''
                ? `<div style="text-align:center; padding:50px; color:var(--text-muted);">룬 데이터가 없습니다.</div>`
                : `
                <div class="build-container">
                    <div class="build-box">
                        <div class="build-title">룬 세팅</div>
                        ${runesHtml}
                    </div>
                    <div class="build-box">
                        <div class="build-title">스킬 빌드</div>
                        <div id="skill-body-${game.matchId}">
                            <div class="skel" style="height:72px;border-radius:8px;margin:8px 0;"></div>
                        </div>
                    </div>
                    <div class="build-box">
                        <div class="build-title">아이템 빌드</div>
                        <div id="item-body-${game.matchId}">
                            <div class="skel" style="height:72px;border-radius:8px;margin:8px 0;"></div>
                        </div>
                    </div>
                </div>
                `}
            </div>
        `;

        wrapper.appendChild(summary);
        wrapper.appendChild(detailHtml);
        listDiv.appendChild(wrapper);
    });
}

// ============================================================
// 칼바람 전용 요약 패널
//   승률·챔피언·KDA는 협곡과 같은 방식이 통하지만, 라인이 없어서
//   포지션 그래프 자리에는 칼바람에서 의미 있는 지표를 대신 넣는다.
// ============================================================
function renderAramSummaryHtml(matches) {
    const total = matches.length;

    let wins = 0, losses = 0;
    let totalKills = 0, totalDeaths = 0, totalAssists = 0, totalKp = 0;
    let totalDmg = 0, totalTaken = 0, totalGold = 0, totalMins = 0, multiKills = 0;

    matches.forEach(game => {
        if (game.win) wins++; else losses++;
        totalKills += game.kills; totalDeaths += game.deaths; totalAssists += game.assists;
        totalKp += game.kp || 0;
        totalGold += game.goldEarned || 0;
        if (game.multiKill) multiKills++;

        const mins = game.durationMin + (game.durationSec / 60);
        totalMins += mins;
        const me = (game.participants || []).find(x => x.isSearchedUser);
        if (me) { totalDmg += me.damage || 0; totalTaken += me.damageTaken || 0; }
    });

    const winRate = Math.round((wins / total) * 100);
    const winDeg = Math.round((wins / total) * 360);
    const wrColor = winRate >= 50 ? 'var(--win)' : 'var(--lose)';
    const avgK = (totalKills / total).toFixed(1);
    const avgD = (totalDeaths / total).toFixed(1);
    const avgA = (totalAssists / total).toFixed(1);
    const kdaRatio = totalDeaths === 0 ? 'Perfect' : ((totalKills + totalAssists) / totalDeaths).toFixed(2);
    const avgKp = Math.round(totalKp / total);

    const avgDpm = totalMins > 0 ? Math.round(totalDmg / totalMins) : 0;
    const avgTpm = totalMins > 0 ? Math.round(totalTaken / totalMins) : 0;
    const avgGpm = totalMins > 0 ? Math.round(totalGold / totalMins) : 0;
    const avgLenMin = Math.floor(totalMins / total);
    const avgLenSec = Math.round(((totalMins / total) - avgLenMin) * 60);

    const metric = (label, value) => `
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:3px 0;">
            <span style="color:var(--text-muted);">${label}</span>
            <span style="color:#ffffff; font-weight: 700;">${value}</span>
        </div>`;

    return `
        <div style="background: linear-gradient(135deg, var(--surface-hover), #161625); border-radius: 8px; padding: 25px 30px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; border: 1px solid rgba(107, 70, 193, 0.4);">

            <div style="display: flex; align-items: center; gap: 22px; width: 195px;">
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <div style="color: #ffffff; font-size: 12px;">${total}전 ${wins}승 ${losses}패</div>
                    <div style="width: 88px; height: 88px; border-radius: 50%; background: conic-gradient(var(--win) ${winDeg}deg, var(--lose) 0); display: flex; align-items: center; justify-content: center;">
                        <div style="width: 64px; height: 64px; background: #201435; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; color: ${wrColor};">
                            ${winRate}%
                        </div>
                    </div>
                </div>

                <div style="display: flex; flex-direction: column; justify-content: center; gap: 6px; text-align: left;">
                    <div style="font-size: 12px; color: #ffffff; font-weight: 700;">
                        ${avgK} / <span style="color: var(--lose-text);">${avgD}</span> / ${avgA}
                    </div>
                    <div style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">
                        ${kdaRatio} <span style="font-size: 14px; font-weight: normal; color: #ffffff;">: 1</span>
                    </div>
                    <div style="font-size: 12px; color: var(--lose-text); font-weight: 700;">
                        킬관여 ${avgKp}%
                    </div>
                </div>
            </div>

            <div style="width: 1px; height: 90px; background: rgba(107, 70, 193, 0.4); margin: 0 10px;"></div>

            <!-- ★ 폭 258px = 244 + 좌우 숫자 한 자리씩. 세 패널이 같이 움직여야 한다 —
                 하나만 바꾸면 space-between 이 남는 폭을 다시 나눠 구분선이 어긋난다 -->
            <div style="width: 258px; padding-left: 9px; display: flex; flex-direction: column; justify-content: center;">
                <div style="color: #ffffff; font-size: 12px; margin-bottom: 12px;">플레이한 역할군 (최근 ${total}게임)</div>
                ${renderRoleRowsHtml(matches, 'aram')}
            </div>

            <div style="width: 1px; height: 90px; background: rgba(107, 70, 193, 0.4); margin: 0 10px;"></div>

            <!-- ★ 폭을 176px 로 맞춘다. 여기만 181px 이던 시절엔 space-between 이 남는 폭을
                 다시 나눠서 구분선이 협곡·아레나보다 1px·4px 왼쪽에 찍혔다 (실측).
                 필터를 누를 때마다 구분선이 옮겨 다니는 게 그 때문이었다. -->
            <div style="display: flex; flex-direction: column; justify-content: center; width: 176px;">
                <div style="color: #ffffff; font-size: 12px; margin-bottom: 8px; text-align: center;">칼바람 지표 (평균)</div>
                ${metric('분당 피해량', avgDpm.toLocaleString())}
                ${metric('분당 받은 피해', avgTpm.toLocaleString())}
                ${metric('분당 골드', avgGpm.toLocaleString())}
                ${metric('게임 시간', `${avgLenMin}분 ${avgLenSec}초`)}
                ${metric('멀티킬 기록', `${multiKills}게임`)}
            </div>

        </div>`;
}

// ============================================================
// 칼바람·아레나의 "플레이한 역할군"
//   두 모드는 라인이 없어서 챔피언을 나열해도 성향이 안 보인다. 역할군으로 묶는다.
//
//   ★ 챔피언 하나가 역할군 2개에 들어갈 수 있다(DD tags 는 1~2개). 그래서 역할군별
//     게임 수의 합이 총 게임 수보다 많을 수 있다 — 틀린 게 아니다.
//   ★ 줄 높이(28 + margin 6)를 챔피언 줄과 똑같이 맞춰야 한다. 다르면 모드마다
//     통계 박스 높이가 달라져 필터를 누를 때 박스가 위아래로 튄다.
//   ★ 아레나는 승패가 아니라 등수다 (경기 칸도 placementText 로 등수를 찍는다).
//     같은 패널 안에 "평균 등수" 가 있는데 옆에서 승률을 말하면 서로 어긋난다.
// ============================================================
function renderRoleRowsHtml(matches, mode) {
    const roleData = {};

    matches.forEach(game => {
        (champRoleMap[game.championName] || []).forEach(r => {
            if (!roleData[r]) roleData[r] = { games: 0, wins: 0, firsts: 0 };
            roleData[r].games++;
            if (game.win) roleData[r].wins++;
            if (Number(game.placement) === 1) roleData[r].firsts++;
        });
    });

    const sorted = Object.entries(roleData)
        .sort((a, b) => b[1].games - a[1].games || b[1].wins - a[1].wins)
        .slice(0, 3);

    // champion.json 이 아직 안 왔으면 역할군을 하나도 못 찾는다
    if (sorted.length === 0) {
        return `<div style="height: 102px; display: flex; align-items: center; color: var(--text-faint); font-size: 12px;">역할군 정보를 불러오지 못했습니다.</div>`;
    }

    let html = sorted.map(([r, d]) => {
        const wr = Math.round((d.wins / d.games) * 100);
        const tail = mode === 'arena'
            ? `<span style="color: #ffffff; width: 56px;">${d.games}게임</span>
               <span style="color: #facc15; font-weight: 700;">우승 ${d.firsts}회</span>`
            : `<span style="color: #ffffff;">(${d.wins}승 ${d.games - d.wins}패
                   <span style="color: ${wr >= 50 ? 'var(--lose-text)' : '#ffffff'}; font-weight: 700;">${wr}%</span>)</span>`;
        return `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <img src="${ROLE_ICON}${r}.png" alt="${ROLE_KO[r]}" style="width: 28px; height: 28px;">
                <div style="flex: 1; display: flex; align-items: center; gap: 6px; font-size: 12px;">
                    <span style="color: #ffffff; width: 72px;">${ROLE_KO[r]}</span>
                    ${tail}
                </div>
            </div>`;
    }).join('');

    for (let i = sorted.length; i < 3; i++) {
        html += `<div style="height: 28px; margin-bottom: 6px;"></div>`;
    }
    return html;
}

// ============================================================
// 아레나 전용 요약 패널
//   아레나엔 승패도 포지션도 없다. 등수로 이야기해야 맞다.
// ============================================================
function renderArenaSummaryHtml(matches) {
    const total = matches.length;

    let firsts = 0, top3 = 0, placeSum = 0, placeCount = 0;
    let totalKills = 0, totalDeaths = 0, totalAssists = 0, totalKp = 0;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

    matches.forEach(game => {
        const pl = Number(game.placement) || 0;
        if (pl) {
            placeSum += pl; placeCount++;
            if (dist[pl] !== undefined) dist[pl]++;
            if (pl === 1) firsts++;
            if (pl <= 3) top3++;
        }

        totalKills += game.kills; totalDeaths += game.deaths; totalAssists += game.assists;
        totalKp += game.kp || 0;
    });

    const avgPlace = placeCount ? (placeSum / placeCount).toFixed(2) : '-';
    const top3Rate = placeCount ? Math.round((top3 / placeCount) * 100) : 0;
    const avgK = (totalKills / total).toFixed(1);
    const avgD = (totalDeaths / total).toFixed(1);
    const avgA = (totalAssists / total).toFixed(1);
    const kdaRatio = totalDeaths === 0 ? 'Perfect' : ((totalKills + totalAssists) / totalDeaths).toFixed(2);
    const avgKp = Math.round(totalKp / total);

    const placeColor = (n) => n === 1 ? '#facc15' : (n <= 3 ? 'var(--win)' : 'var(--lose)');
    const top3Deg = Math.round((top3Rate / 100) * 360);
    const avgColor = placeColor(Math.round(Number(avgPlace)) || 6);

    const maxDist = Math.max(...Object.values(dist)) || 1;
    const bars = [1, 2, 3, 4, 5, 6].map(n => {
        const val = dist[n];
        const h = val === 0 ? 0 : Math.max(2, (val / maxDist) * 60);
        const isTop = val === maxDist && val > 0;
        return `
            <div data-tooltip="${n}위: ${val}게임" style="display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:6px; height: 90px; width: 22px;">
                <div style="width: 12px; background: ${isTop ? placeColor(n) : '#31313c'}; height: ${h}px; border-radius: 2px;"></div>
                <div style="font-size: 12px; color: ${isTop ? placeColor(n) : 'var(--text-faint)'}; font-weight: 700;">${n}</div>
            </div>`;
    }).join('');

    return `
        <div style="background: linear-gradient(135deg, var(--surface-hover), #161625); border-radius: 8px; padding: 25px 30px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; border: 1px solid rgba(107, 70, 193, 0.4);">

            <div style="display: flex; align-items: center; gap: 22px; width: 195px;">
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <div style="color: #ffffff; font-size: 12px;">${total}전 · ${firsts}회 우승</div>
                    <div style="width: 88px; height: 88px; border-radius: 50%; background: conic-gradient(var(--win) ${top3Deg}deg, var(--lose) 0); display: flex; align-items: center; justify-content: center;" data-tooltip="3위 안에 든 비율 ${top3Rate}%">
                        <div style="width: 64px; height: 64px; background: #201435; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: ${avgColor};">
                            <div style="font-size: 15px; font-weight: 700;">${avgPlace}위</div>
                            <div style="font-size: 12px; color: var(--text-muted);">평균 등수</div>
                        </div>
                    </div>
                </div>

                <div style="display: flex; flex-direction: column; justify-content: center; gap: 6px; text-align: left;">
                    <div style="font-size: 12px; color: #ffffff; font-weight: 700;">
                        ${avgK} / <span style="color: var(--lose-text);">${avgD}</span> / ${avgA}
                    </div>
                    <div style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">
                        ${kdaRatio} <span style="font-size: 14px; font-weight: normal; color: #ffffff;">: 1</span>
                    </div>
                    <div style="font-size: 12px; color: var(--lose-text); font-weight: 700;">
                        킬관여 ${avgKp}%
                    </div>
                </div>
            </div>

            <div style="width: 1px; height: 90px; background: rgba(107, 70, 193, 0.4); margin: 0 10px;"></div>

            <!-- ★ 폭 258px = 244 + 좌우 숫자 한 자리씩. 세 패널이 같이 움직여야 한다 —
                 하나만 바꾸면 space-between 이 남는 폭을 다시 나눠 구분선이 어긋난다 -->
            <div style="width: 258px; padding-left: 9px; display: flex; flex-direction: column; justify-content: center;">
                <div style="color: #ffffff; font-size: 12px; margin-bottom: 12px;">플레이한 역할군 (최근 ${total}게임)</div>
                ${renderRoleRowsHtml(matches, 'arena')}
            </div>

            <div style="width: 1px; height: 90px; background: rgba(107, 70, 193, 0.4); margin: 0 10px;"></div>

            <div style="display: flex; flex-direction: column; justify-content: center; width: 176px;">
                <div style="color: #ffffff; font-size: 12px; margin-bottom: 8px; text-align: center;">등수 분포</div>
                <div style="display: flex; justify-content: center; gap: 8px; align-items: flex-end;">
                    ${bars}
                </div>
            </div>

        </div>`;
}

// ============================================================
//  최근 같이 한 소환사 (2026-09-04, 로드맵 A-8) — 전적 사이드바
//
//  ★ 라이엇 호출 0 · 서버 수정 0 — 이미 받아 둔 전적의 participants 를 세기만 한다.
//  ★★ 큐 필터를 그대로 따른다 (사용자 결정) — applyMatchFilters 가 거른 목록을 받으므로
//    「솔로랭크」를 누르면 솔랭에서 만난 사람만, 「아레나」면 아레나에서 만난 사람만 나온다.
//    그래서 renderSummaryStats 와 **같은 자리에서 같은 인자로** 불러야 한다.
//  ★ 클릭은 2026-09-03 에 만든 [data-search-name] 위임이 받는다 — 새 리스너가 0이다.
// ============================================================
const MATE_MIN_GAMES = 2;   // 1판은 그냥 랜덤 매칭이라 뜻이 없다
const MATE_TOP = 5;         // 사이드바 폭(350px)에 맞춘 개수

function renderRecentMates(matchesToCalc) {
    const area = document.getElementById('recent-mates-area');
    if (!area) return;

    // 리메이크는 뺀다 (renderSummaryStats 의 `played` 와 같은 규칙)
    const played = (matchesToCalc || []).filter(g => !(g.isRemake || (!g.isArena && g.durationMin < 4)));

    const ally = new Map(), foe = new Map();
    played.forEach(g => {
        const parts = g.participants || [];
        const me = parts.find(p => p.isSearchedUser);
        if (!me) return;

        parts.forEach(p => {
            if (p.isSearchedUser || !p.puuid) return;

            // ★ 아레나의 teamId 는 진영이 아니라 "상위 절반 / 하위 절반" 이라 그대로 쓰면 안 된다.
            //   조(subteam)로 갈라야 진짜 같은 편이 나온다 (CLAUDE.md 아레나 밴 절과 같은 함정)
            const sameTeam = g.isArena ? (p.subteam === me.subteam) : (p.teamId === me.teamId);

            // ★★ 승패는 언제나 **내 기준**이다 — 적군 줄의 "3승" 은 *내가 그 사람을 만나 이긴 판* 이다.
            //   아레나는 승패가 없고 등수뿐이라 등수로 판정한다:
            //   같은 조면 1등일 때만 승(요약 통계의 "우승 N회" 와 같은 정의),
            //   적이면 내 등수가 그 사람보다 앞설 때 승 — 6조라 "3등 vs 5등" 도 이긴 것이다.
            const iWon = g.isArena
                ? (sameTeam
                    ? me.placement === 1
                    : (me.placement > 0 && p.placement > 0 && me.placement < p.placement))
                : !!me.win;

            const bag = sameTeam ? ally : foe;
            const e = bag.get(p.puuid) || { name: p.summonerName, games: 0, wins: 0 };
            e.games++;
            if (iWon) e.wins++;
            e.name = p.summonerName;   // 닉네임이 바뀌었으면 더 최근 판의 것으로 덮는다
            bag.set(p.puuid, e);
        });
    });

    const pick = (bag) => [...bag.values()]
        .filter(e => e.games >= MATE_MIN_GAMES)
        .sort((a, b) => b.games - a.games || (b.wins / b.games) - (a.wins / a.games))
        .slice(0, MATE_TOP);

    const rowsHtml = (list) => list.map(e => {
        const pct = Math.round((e.wins / e.games) * 100);
        const short = e.name.split('#')[0];   // 태그는 뗀다 — 사이드바가 좁다 (전체 이름은 title 에)
        return `<div class="mate-row" data-search-name="${escapeHtml(e.name)}" title="${escapeHtml(e.name)}">
                <span class="mate-name">${escapeHtml(short)}</span>
                <span class="mate-games">${e.games}판</span>
                <span class="mate-wl">${e.wins}승 ${e.games - e.wins}패</span>
                <span class="mate-pct" style="color:${pct >= 50 ? 'var(--win)' : 'var(--lose-text)'}">${pct}%</span>
            </div>`;
    }).join('');

    const a = pick(ally), f = pick(foe);

    // ★ 둘 다 없으면 카드를 통째로 안 그린다 (홈 위젯·도감 채택률과 같은 정신).
    //   CSS 의 `#recent-mates-area:empty { display: none }` 가 사이드바 flex gap 까지 지운다
    if (!a.length && !f.length) { area.innerHTML = ''; return; }

    area.innerHTML = `<div class="pix-box mates-box">
            ${a.length ? `<h3 class="mates-title">같이 한 소환사</h3>${rowsHtml(a)}` : ''}
            ${f.length ? `<h3 class="mates-title${a.length ? ' is-second' : ''}">상대한 소환사</h3>${rowsHtml(f)}` : ''}
        </div>`;
}

function renderSummaryStats(matchesToCalc) {
    const statsArea = document.getElementById('summary-stats-area');
    if (!statsArea) return;

    if (!matchesToCalc || matchesToCalc.length === 0) {
        statsArea.innerHTML = '';
        statsArea.style.display = 'none';
        return;
    }

    // ============================================================
    // 모드별로 통계의 의미가 달라서 한 통에 넣으면 안 된다.
    //   협곡  : 승률 / 챔피언 / 포지션 / 킬관여 전부 유효
    //   칼바람: 라인이 없음 -> 포지션 그래프가 무의미 (전부 미드로 집계됨)
    //   아레나: 승패도 라인도 없음 -> 등수로 봐야 함
    //
    // '전체'에서는 협곡 판만 집계하고, 칼바람과 아레나는 각자 버튼을
    // 눌렀을 때만 전용 패널로 보여준다.
    // ============================================================
    // 다시하기는 실제로 플레이한 게임이 아니다. 승/패로도, 포지션으로도 세면 안 된다.
    //   (스펠은 챔피언 선택에서 이미 정해지므로 3분짜리 다시하기도 포지션에 집계됐었다)
    const played = matchesToCalc.filter(g => !(g.isRemake || (!g.isArena && g.durationMin < 4)));

    if (played.length === 0) {
        statsArea.innerHTML = '';
        statsArea.style.display = 'none';
        return;
    }

    const RIFT_GROUPS = new Set(['솔로랭크', '자유랭크', '일반']);

    const arenaMatches = played.filter(g => g.isArena);
    const aramMatches = played.filter(g => g.isAram);
    const others = played.filter(g => !g.isArena && !g.isAram);
    // 협곡 랭크·일반만 '전체' 종합 통계에 들어간다.
    // 봇전(승률 대부분 100%)과 이벤트 모드는 섞이면 승률이 통째로 왜곡된다.
    const riftMatches = others.filter(g => RIFT_GROUPS.has(g.queueGroup));
    const offRiftMatches = others.filter(g => !RIFT_GROUPS.has(g.queueGroup));

    if (riftMatches.length > 0) {
        matchesToCalc = riftMatches;
    } else if (aramMatches.length > 0 && arenaMatches.length === 0 && offRiftMatches.length === 0) {
        // 칼바람 필터
        statsArea.innerHTML = renderAramSummaryHtml(aramMatches);
        statsArea.style.display = 'block';
        return;
    } else if (arenaMatches.length > 0 && aramMatches.length === 0 && offRiftMatches.length === 0) {
        // 아레나 필터
        statsArea.innerHTML = renderArenaSummaryHtml(arenaMatches);
        statsArea.style.display = 'block';
        return;
    } else if (offRiftMatches.length > 0 && aramMatches.length === 0 && arenaMatches.length === 0) {
        // 봇 필터 등 — 승패·라인 개념이 살아있으므로 기본 패널을 그대로 쓴다
        matchesToCalc = offRiftMatches;
    } else {
        // '전체'인데 협곡 판이 하나도 없는 경우 — 섞어서 평균 내지 않고 안내만
        statsArea.innerHTML = `
            <div style="background: linear-gradient(135deg, var(--surface-hover), #161625); border-radius: 8px; padding: 22px 30px; margin-bottom: 15px; border: 1px solid rgba(107, 70, 193, 0.4); text-align: center; color: var(--text-muted); font-size: 13px; line-height: 1.7;">
                협곡 전적이 없어 종합 통계를 낼 수 없습니다.<br>
                <span style="font-size: 12px; color: var(--text-faint);">칼바람 · 아레나 · 봇은 각각의 필터 버튼에서 확인할 수 있습니다.</span>
            </div>`;
        statsArea.style.display = 'block';
        return;
    }

    let wins = 0, losses = 0, totalKills = 0, totalDeaths = 0, totalAssists = 0, totalKp = 0;
    let champData = {};
    let posCounts = { top: 0, jungle: 0, mid: 0, adc: 0, support: 0 };

    const supportItems = [3869, 3870, 3871, 3873, 3874, 3875, 3876, 3877, 4003, 4004];
    const adcList = ["Ashe", "Caitlyn", "Draven", "Ezreal", "Jhin", "Jinx", "Kaisa", "Kalista", "KogMaw", "Lucian", "MissFortune", "Nilah", "Samira", "Sivir", "Smolder", "Tristana", "Twitch", "Varus", "Vayne", "Xayah", "Zeri", "Yunara"];
    const topList = ["Aatrox", "Camille", "ChoGath", "Darius", "DrMundo", "Fiora", "Garen", "Gnar", "Gragas", "Gwen", "Illaoi", "Irelia", "Jax", "Jayce", "KSante", "Kayle", "Kennen", "Kled", "Malphite", "Mordekaiser", "Nasus", "Olaf", "Ornn", "Pantheon", "Poppy", "Quinn", "Renekton", "Riven", "Rumble", "Sett", "Shen", "Singed", "Sion", "TahmKench", "Teemo", "Trundle", "Tryndamere", "Urgot", "Volibear", "Wukong", "Yorick", "Ambessa", "Mel", "Zaahen"];

    matchesToCalc.forEach(game => {
        if (game.win) wins++; else losses++;
        totalKills += game.kills; totalDeaths += game.deaths; totalAssists += game.assists;
        totalKp += game.kp || 0;

        const cName = game.championName;
        if (!champData[cName]) champData[cName] = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
        champData[cName].games++;
        if (game.win) champData[cName].wins++;
        champData[cName].kills += game.kills;
        champData[cName].deaths += game.deaths;
        champData[cName].assists += game.assists;

        // 라이엇이 판정한 라인이 있으면 그걸 쓴다.
        // 예전 방식(스마이트·서폿템·챔피언 이름 목록)은 신챔이나 유연한 픽에서 자주 틀렸다.
        const riotPos = POS_KEY[game.teamPosition];
        if (riotPos) {
            posCounts[riotPos]++;
        } else {
            const hasSmite = (game.spell1 === 11 || game.spell2 === 11);
            const hasSuppItem = [game.item0, game.item1, game.item2, game.item3, game.item4, game.item5, game.item6].some(id => supportItems.includes(id));

            if (hasSmite) posCounts.jungle++;
            else if (hasSuppItem) posCounts.support++;
            else if (adcList.includes(cName)) posCounts.adc++;
            else if (topList.includes(cName)) posCounts.top++;
            else posCounts.mid++;
        }
    });

    const totalGames = matchesToCalc.length;
    const winRate = Math.round((wins / totalGames) * 100);
    const avgK = (totalKills / totalGames).toFixed(1), avgD = (totalDeaths / totalGames).toFixed(1), avgA = (totalAssists / totalGames).toFixed(1);
    const kdaRatio = totalDeaths === 0 ? 'Perfect' : ((totalKills + totalAssists) / totalDeaths).toFixed(2);
    const avgKp = Math.round(totalKp / totalGames);

    const sortedChamps = Object.entries(champData).sort((a, b) => b[1].games - a[1].games || b[1].wins - a[1].wins).slice(0, 3);

    let champsHtml = sortedChamps.map(([cName, data]) => {
        const cWinRate = Math.round((data.wins / data.games) * 100);
        const cKda = data.deaths === 0 ? 'Perfect' : ((data.kills + data.assists) / data.deaths).toFixed(2);
        let kdaColor = "#ffffff";
        if (cKda >= 5 || cKda === 'Perfect') kdaColor = "var(--lose)"; else if (cKda >= 4) kdaColor = "var(--win)"; else if (cKda >= 3) kdaColor = "#10b981";
        const wrColor = cWinRate >= 60 ? "var(--lose-text)" : (cWinRate >= 50 ? "var(--lose-text)" : "#ffffff");

        return `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${cName}.png" style="width: 28px; height: 28px; border-radius: 50%;" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/0.png'">
                <div style="flex: 1; display: flex; align-items: center; gap: 6px; font-size: 12px;">
                    <span style="color: ${wrColor}; font-weight: 700; width: 34px;">${cWinRate}%</span>
                    <!-- ★ 62px 이면 두 자리 승패("10승 / 15패")에서 줄이 넘어간다. 76px = 숫자 두 자리분 -->
                    <span style="color: #ffffff; width: 76px; white-space: nowrap;">(${data.wins}승 / ${data.games - data.wins}패)</span>
                    <span style="color: ${kdaColor}; font-weight: 700;">${cKda}:1 평점</span>
                </div>
            </div>
        `;
    }).join('');

    if (sortedChamps.length < 3) {
        for (let i = 0; i < 3 - sortedChamps.length; i++) {
            champsHtml += `<div style="height: 28px; margin-bottom: 6px;"></div>`;
        }
    }

    const winDeg = Math.round((wins / totalGames) * 360);
    const maxPos = Math.max(posCounts.top, posCounts.jungle, posCounts.mid, posCounts.adc, posCounts.support) || 1;

    // ★ 여기 남아 있던 op.gg 아이콘 5개도 CD 공식으로 갈았다 (2026-08-19).
    //   통계 탭과 같은 표(STAT_LANE_ICON)를 그대로 쓴다 — 두 벌 두면 어긋난다.
    const posIcon = (k) => `<img src="${STAT_LANE_ICON[k]}" style="width:16px;">`;
    const iconTop = posIcon('top');
    const iconJungle = posIcon('jungle');
    const iconMid = posIcon('mid');
    const iconAdc = posIcon('adc');
    const iconSup = posIcon('support');

    const posOrder = [
        { id: 'top', name: '탑', icon: iconTop, val: posCounts.top },
        { id: 'jungle', name: '정글', icon: iconJungle, val: posCounts.jungle },
        { id: 'mid', name: '미드', icon: iconMid, val: posCounts.mid },
        { id: 'adc', name: '원딜', icon: iconAdc, val: posCounts.adc },
        { id: 'support', name: '서포터', icon: iconSup, val: posCounts.support }
    ];

    const renderBar = (p) => {
        const isActive = p.val === Math.max(posCounts.top, posCounts.jungle, posCounts.mid, posCounts.adc, posCounts.support) && p.val > 0;
        const h = p.val === 0 ? 0 : Math.max(2, (p.val / maxPos) * 60);
        const barColor = isActive ? 'var(--accent)' : '#31313c';
        // CD 아이콘은 원래 금색이라, 주 포지션은 원색 그대로 / 나머지는 회색으로 죽인다
        // (역할군 버튼 .role-btn 과 같은 규칙. 옛 invert 필터는 흑백 op.gg 아이콘용이었다)
        const filterStyle = isActive ? '' : 'filter: grayscale(1) brightness(0.75); opacity: 0.5;';

        return `
            <div data-tooltip="${p.name} 플레이 횟수: ${p.val}게임" style="display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:8px; height: 90px; width: 24px;">
                <div style="width: 12px; background: ${barColor}; height: ${h}px; border-radius: 2px;"></div>
                <div style="display:flex; ${filterStyle}">${p.icon}</div>
            </div>
        `;
    };

    const wrColor = winRate >= 50 ? 'var(--win)' : 'var(--lose)';

    statsArea.innerHTML = `
        <div style="background: linear-gradient(135deg, var(--surface-hover), #161625); border-radius: 8px; padding: 25px 30px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; border: 1px solid rgba(107, 70, 193, 0.4);">
            
            <div style="display: flex; align-items: center; gap: 22px; width: 195px;">
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <div style="color: #ffffff; font-size: 12px;">${totalGames}전 ${wins}승 ${losses}패</div>
                    <div style="width: 88px; height: 88px; border-radius: 50%; background: conic-gradient(var(--win) ${winDeg}deg, var(--lose) 0); display: flex; align-items: center; justify-content: center;">
                        <div style="width: 64px; height: 64px; background: #201435; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; color: ${wrColor};">
                            ${winRate}%
                        </div>
                    </div>
                </div>
                
                <div style="display: flex; flex-direction: column; justify-content: center; gap: 6px; text-align: left;">
                    <div style="font-size: 12px; color: #ffffff; font-weight: 700;">
                        ${avgK} / <span style="color: var(--lose-text);">${avgD}</span> / ${avgA}
                    </div>
                    <div style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">
                        ${kdaRatio} <span style="font-size: 14px; font-weight: normal; color: #ffffff;">: 1</span>
                    </div>
                    <div style="font-size: 12px; color: var(--lose-text); font-weight: 700;">
                        킬관여 ${avgKp}%
                    </div>
                </div>
            </div>

            <div style="width: 1px; height: 90px; background: rgba(107, 70, 193, 0.4); margin: 0 10px;"></div>

            <!-- ★ 폭 258px = 244 + 좌우 숫자 한 자리씩. 세 패널이 같이 움직여야 한다 —
                 하나만 바꾸면 space-between 이 남는 폭을 다시 나눠 구분선이 어긋난다 -->
            <div style="width: 258px; padding-left: 9px; display: flex; flex-direction: column; justify-content: center;">
                <div style="color: #ffffff; font-size: 12px; margin-bottom: 12px;">플레이한 챔피언 (최근 ${totalGames}게임)</div>
                ${champsHtml}
            </div>

            <div style="width: 1px; height: 90px; background: rgba(107, 70, 193, 0.4); margin: 0 10px;"></div>

            <div style="display: flex; flex-direction: column; justify-content: center; width: 176px;">
                <div style="color: #ffffff; font-size: 12px; margin-bottom: 8px; text-align: center;">선호 포지션 (랭크)</div>
                <div style="display: flex; justify-content: center; gap: 10px; align-items: flex-end;">
                    ${posOrder.map(renderBar).join('')}
                </div>
            </div>

        </div>
    `;
    statsArea.style.display = 'block';
}

// 필터는 두 축이다. 큐(전체/솔랭/칼바람/...)와 챔피언.
// 서로 독립이라 상태를 따로 두고 적용은 한 군데서 한다.
let activeQueueFilter = '전체';
let activeChampFilter = null;   // 챔피언 영문 ID. null이면 전체

function toggleFilter(btn, type) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeQueueFilter = type;
    applyMatchFilters();
}

function applyMatchFilters() {
    const games = document.querySelectorAll('.match-wrapper');

    // 전적이 아예 없으면 renderMatches가 이미 안내를 그려놨다.
    // 여기서 또 만들면 같은 문구가 두 번 뜬다.
    if (games.length === 0) {
        renderSummaryStats([]);
        renderRecentMates([]);
        return;
    }

    let visibleCount = 0; let filteredMatches = [];

    games.forEach((gameDiv, index) => {
        // 라벨 부분일치(includes)는 라벨을 늘릴 때 서로 잡아먹는다. 그룹 완전일치로 판정.
        const group = gameDiv.dataset.group || '기타';
        const champ = gameDiv.dataset.champ || '';

        const queueOk = activeQueueFilter === '전체' || group === activeQueueFilter;
        const champOk = !activeChampFilter || champ === activeChampFilter;

        if (queueOk && champOk) {
            gameDiv.style.display = 'block'; visibleCount++;
            if (allMatches[index]) filteredMatches.push(allMatches[index]);
        } else { gameDiv.style.display = 'none'; }
    });

    renderSummaryStats(filteredMatches);
    // ★ 요약 통계와 **같은 자리에서 같은 인자로** 부른다 — 한쪽만 부르면 표와 사이드바가 어긋난다
    renderRecentMates(filteredMatches);
    const listDiv = document.getElementById('game-list');
    let emptyMsg = document.getElementById('empty-filter-msg');

    if (visibleCount === 0) {
        if (!emptyMsg) {
            emptyMsg = document.createElement('div');
            emptyMsg.id = 'empty-filter-msg';
            emptyMsg.style.cssText = "text-align: center; padding: 60px 0; color: var(--text-muted); line-height: 1.6;";
            listDiv.appendChild(emptyMsg);
        }
        emptyMsg.innerHTML = activeChampFilter
            ? "선택한 챔피언의 전적이 없습니다.<br><span style='font-size: 12px; color: var(--text-faint);'>(최근 20게임 기준)</span>"
            : "전적 데이터가 없습니다.<br><span style='font-size: 12px; color: var(--text-faint);'>(최근 20게임 기준)</span>";
        emptyMsg.style.display = 'block';
    } else if (emptyMsg) emptyMsg.style.display = 'none';
}

// ============================================================
// 챔피언 필터 패널
// ============================================================

// 한글 초성 검색 ("ㄱㄹ" -> 가렌)
const HANGUL_CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

function getChosung(str) {
    return [...str].map(ch => {
        const code = ch.charCodeAt(0) - 0xAC00;
        return (code >= 0 && code <= 11171) ? HANGUL_CHO[Math.floor(code / 588)] : ch;
    }).join('');
}

// ★ 영문 자판을 두벌식 한글 자모로 (2026-08-13).
//   한영 전환 없이 챔피언을 찾으려는 것이다 — "d" -> "ㅇ", "rkfps" -> "가렌".
//   ★★ **소문자로 바꾸기 전에** 이 함수를 태워야 한다. Shift 조합(ㅃㅉㄸㄲㅆ)이
//     대문자로 들어오기 때문이다. 순서를 바꾸면 **쓰레쉬(Tmfptn)와 뽀삐(QhQl)를
//     영영 못 찾는다** — 소문자화하면 "스레쉬", "보비" 가 되어 버린다.
const QWERTY_KO_SHIFT = { Q: 'ㅃ', W: 'ㅉ', E: 'ㄸ', R: 'ㄲ', T: 'ㅆ', O: 'ㅒ', P: 'ㅖ' };
const QWERTY_KO = {
    q: 'ㅂ', w: 'ㅈ', e: 'ㄷ', r: 'ㄱ', t: 'ㅅ', y: 'ㅛ', u: 'ㅕ', i: 'ㅑ', o: 'ㅐ', p: 'ㅔ',
    a: 'ㅁ', s: 'ㄴ', d: 'ㅇ', f: 'ㄹ', g: 'ㅎ', h: 'ㅗ', j: 'ㅓ', k: 'ㅏ', l: 'ㅣ',
    z: 'ㅋ', x: 'ㅌ', c: 'ㅊ', v: 'ㅍ', b: 'ㅠ', n: 'ㅜ', m: 'ㅡ',
};

// 자모 -> 음절 조합에 쓰는 표. 초성은 위 HANGUL_CHO 를 그대로 쓴다.
const HANGUL_JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ',
    'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const HANGUL_JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ',
    'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
// 두 번 눌러 만드는 겹모음·겹받침
const JUNG_COMBO = { 'ㅗㅏ': 'ㅘ', 'ㅗㅐ': 'ㅙ', 'ㅗㅣ': 'ㅚ', 'ㅜㅓ': 'ㅝ', 'ㅜㅔ': 'ㅞ', 'ㅜㅣ': 'ㅟ', 'ㅡㅣ': 'ㅢ' };
const JONG_COMBO = {
    'ㄱㅅ': 'ㄳ', 'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ', 'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ', 'ㄹㅂ': 'ㄼ',
    'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ', 'ㄹㅎ': 'ㅀ', 'ㅂㅅ': 'ㅄ',
};

// ★ 영문 자판을 한글로 바꾼다 — **조합까지 한다** (2026-08-13).
//   "rkfps" -> "가렌", "rf" -> "ㄱㄹ", "d" -> "ㅇ".
//   자음만 이어지면 음절이 안 되므로 자모가 그대로 남는데, 그게 곧 초성 검색이다.
//   즉 초성 검색과 풀타이핑이 **같은 함수 하나로** 처리된다.
//   ★ 한글을 직접 친 경우("가렌", "ㄱㄹ")는 QWERTY_KO 에 없으니 그대로 통과한다.
function qwertyToKo(s) {
    // Shift 조합(대문자)을 먼저 본다. 나머지 대문자는 소문자와 같은 자리다.
    const jamo = [...s].map(ch => QWERTY_KO_SHIFT[ch] || QWERTY_KO[ch.toLowerCase()] || ch);
    let out = '';
    let cho = -1, jung = -1, jong = 0;   // 조립 중인 음절

    const flush = () => {
        if (cho >= 0 && jung >= 0) out += String.fromCharCode(0xAC00 + (cho * 21 + jung) * 28 + jong);
        else if (cho >= 0) out += HANGUL_CHO[cho];
        else if (jung >= 0) out += HANGUL_JUNG[jung];
        cho = -1; jung = -1; jong = 0;
    };

    for (const ch of jamo) {
        const ci = HANGUL_CHO.indexOf(ch);
        const vi = HANGUL_JUNG.indexOf(ch);

        if (vi >= 0) {
            // 모음: 받침이 있었다면 그 받침을 떼어 다음 글자의 초성으로 넘긴다 ("각"+ㅏ -> "가가")
            if (cho >= 0 && jung >= 0 && jong > 0) {
                const last = HANGUL_JONG[jong];
                const split = Object.entries(JONG_COMBO).find(([, v]) => v === last);
                const moved = split ? split[0][1] : last;
                jong = split ? HANGUL_JONG.indexOf(split[0][0]) : 0;
                flush();
                cho = HANGUL_CHO.indexOf(moved); jung = vi;
            } else if (jung >= 0 && JUNG_COMBO[HANGUL_JUNG[jung] + ch]) {
                jung = HANGUL_JUNG.indexOf(JUNG_COMBO[HANGUL_JUNG[jung] + ch]);
            } else if (jung >= 0) {
                flush(); jung = vi;
            } else {
                jung = vi;
            }
        } else if (ci >= 0) {
            // 자음: 중성이 있으면 받침으로, 없으면 새 음절의 초성으로
            if (cho >= 0 && jung >= 0) {
                const ji = HANGUL_JONG.indexOf(ch);
                if (jong === 0 && ji > 0) jong = ji;
                else if (jong > 0 && JONG_COMBO[HANGUL_JONG[jong] + ch]) jong = HANGUL_JONG.indexOf(JONG_COMBO[HANGUL_JONG[jong] + ch]);
                else { flush(); cho = ci; }
            } else if (cho >= 0) {
                flush(); cho = ci;          // 자음만 이어짐 -> 초성 검색용으로 자모가 남는다
            } else {
                cho = ci;
            }
        } else {
            flush(); out += ch;              // 완성형 한글·숫자·기호는 그대로
        }
    }
    flush();
    return out;
}

// ★ 대소문자는 판단하지 않고 **가능한 해석을 전부 후보로 둔다** (2026-08-13).
//   대문자 하나하나가 "Shift(된소리)" 인지 "caps 로 친 소문자" 인지 알 방법이 없다.
//   "TMFPTNL"(쓰레쉬)이 그 예다 — 첫 T 는 ㅆ 이고 뒤의 T 는 ㅅ 이라 규칙으로 못 가른다.
//   그래서 **된소리가 될 수 있는 자리(QWERTOP)만 켜고 끄는 조합**을 전부 만든다.
//   그 자리가 4개를 넘으면 조합이 과해지므로 양 끝(전부 Shift / 전부 소문자)만 본다.
//   덕분에 대소문자를 아예 신경 안 써도 되고, 된소리가 필요한 챔피언
//   (쓰레쉬·뽀삐)만 자연히 Shift 해석 쪽으로 걸린다.
// ★★ 초성만 이어 치면 IME 가 **겹받침으로 묶어 버린다** (2026-08-14).
//   "르블랑" 을 찾으려고 ㄹ·ㅂ·ㄹ 을 누르면 화면엔 `ㄼㄹ` 이 뜬다 (ㄹ+ㅂ = ㄼ).
//   "암베사" 는 ㅇ·ㅂ·ㅅ -> `ㅇㅄ` 이다. 우리가 비교하는 초성 문자열은 `ㄹㅂㄹ`·`ㅇㅂㅅ`
//   이라 한 글자도 안 맞아서 **검색이 통째로 헛돈다.**
//   ★ 초성 자리에는 겹받침이 올 수 없으므로 **풀어 주는 게 항상 옳다.**
//     쌍자음(ㄲㄸㅃㅆㅉ)은 Shift 조합이라 자동으로 묶이지 않으니 건드리면 안 된다 —
//     풀어 버리면 "쓰레쉬"(ㅆㄹㅅ)가 "ㅅㅅㄹㅅ" 이 되어 못 찾는다.
const JONG_SPLIT = {
    'ㄳ': 'ㄱㅅ', 'ㄵ': 'ㄴㅈ', 'ㄶ': 'ㄴㅎ',
    'ㄺ': 'ㄹㄱ', 'ㄻ': 'ㄹㅁ', 'ㄼ': 'ㄹㅂ', 'ㄽ': 'ㄹㅅ', 'ㄾ': 'ㄹㅌ', 'ㄿ': 'ㄹㅍ', 'ㅀ': 'ㄹㅎ',
    'ㅄ': 'ㅂㅅ',
};
const splitJong = (s) => [...String(s)].map(c => JONG_SPLIT[c] || c).join('');

function koCandidates(raw) {
    const spots = [...raw].map((c, i) => (QWERTY_KO_SHIFT[c] ? i : -1)).filter(i => i >= 0);
    const out = new Set();
    if (spots.length && spots.length <= 4) {
        for (let mask = 0; mask < (1 << spots.length); mask++) {
            const arr = [...raw];
            spots.forEach((pos, bit) => { if (!(mask & (1 << bit))) arr[pos] = arr[pos].toLowerCase(); });
            out.add(qwertyToKo(arr.join('')).toLowerCase());
        }
    } else {
        out.add(qwertyToKo(raw).toLowerCase());
        out.add(qwertyToKo(raw.toLowerCase()).toLowerCase());
    }
    // 겹받침을 푼 후보를 **덧붙인다** (원래 후보도 남긴다 — 진짜 겹받침이 든 이름도 있다)
    for (const c of [...out]) { const s = splitJong(c); if (s !== c) out.add(s); }
    return [...out];
}

let champFilterCache = null;

async function loadChampFilterList() {
    if (champFilterCache) return champFilterCache;
    const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion.json`);
    const data = await res.json();

    let list = [];
    for (let key in data.data) {
        const c = data.data[key];
        if (isClassicChamp(c.id)) continue;   // 클래식(Jade_) 제외
        list.push({ id: c.id, name: c.name });
    }

    list.sort((a, b) => a.name.localeCompare(b.name, 'ko-KR'));
    champFilterCache = list;
    return list;
}

function champIconUrl(id) {
    return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${id}.png`;
}

function champKorName(id) {
    const found = champFilterCache && champFilterCache.find(c => c.id === id);
    return found ? found.name : id;
}

// 현재 불러온 전적에서 많이 한 챔피언 상위 5개
function getRecentTopChamps() {
    const counts = {};
    (allMatches || []).forEach(g => {
        if (!g.championName) return;
        counts[g.championName] = (counts[g.championName] || 0) + 1;
    });
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, n]) => ({ id, count: n }));
}

async function toggleChampFilterPanel(e) {
    if (e) e.stopPropagation();
    const panel = document.getElementById('champ-filter-panel');
    if (!panel) return;

    if (panel.classList.contains('open')) { closeChampFilterPanel(); return; }

    await loadChampFilterList();
    renderChampFilterPanel();
    panel.classList.add('open');

    const search = document.getElementById('cf-search');
    if (search) { search.value = ''; search.focus(); }
}

function closeChampFilterPanel() {
    const panel = document.getElementById('champ-filter-panel');
    if (panel) panel.classList.remove('open');
}

function renderChampFilterPanel() {
    const recent = getRecentTopChamps();
    const recentBox = document.getElementById('cf-recent');
    const listBox = document.getElementById('cf-list');
    if (!recentBox || !listBox) return;

    recentBox.innerHTML = recent.length
        ? recent.map(c => champFilterRow(c.id, `${c.count}게임`)).join('')
        : `<div class="cf-empty">기록 없음</div>`;

    listBox.innerHTML = champFilterCache.map(c => champFilterRow(c.id)).join('');
}

function champFilterRow(id, sub = '') {
    const active = activeChampFilter === id ? ' active' : '';
    return `
        <div class="cf-item${active}" data-id="${id}" data-name="${champKorName(id)}"
             onclick="selectChampFilter('${id}')">
            <img src="${champIconUrl(id)}" onerror="this.style.visibility='hidden'">
            <span class="cf-name">${champKorName(id)}</span>
            ${sub ? `<span class="cf-sub">${sub}</span>` : ''}
        </div>`;
}

function filterChampFilterList() {
    const cands = koCandidates((document.getElementById('cf-search').value || '').trim());

    document.querySelectorAll('#cf-list .cf-item').forEach(row => {
        const name = (row.dataset.name || '').toLowerCase();
        const cho = getChosung(row.dataset.name || '').toLowerCase();
        const hit = cands.some(c => name.includes(c) || cho.includes(c));
        row.style.display = hit ? 'flex' : 'none';
    });
}

function selectChampFilter(id) {
    // 이미 선택된 챔피언을 다시 누르면 해제
    activeChampFilter = (activeChampFilter === id) ? null : id;
    updateChampFilterBtn();
    closeChampFilterPanel();
    applyMatchFilters();
}

function clearChampFilter(e) {
    // stopPropagation 때문에 바깥 클릭 감지가 안 걸린다. 여기서 직접 닫아준다.
    if (e) e.stopPropagation();
    activeChampFilter = null;
    updateChampFilterBtn();
    closeChampFilterPanel();
    applyMatchFilters();
}

function updateChampFilterBtn() {
    const btn = document.getElementById('champ-filter-btn');
    if (!btn) return;

    if (activeChampFilter) {
        btn.classList.add('selected');
        btn.innerHTML = `
            <img src="${champIconUrl(activeChampFilter)}" class="cf-btn-icon">
            <span>${champKorName(activeChampFilter)}</span>
            <span class="cf-clear" onclick="clearChampFilter(event)">×</span>`;
    } else {
        btn.classList.remove('selected');
        btn.innerHTML = `<span>챔피언 필터</span>`;
    }
}

// 패널 바깥을 누르면 닫기
document.addEventListener('click', (e) => {
    const wrap = document.getElementById('champ-filter-wrap');
    if (wrap && !wrap.contains(e.target)) closeChampFilterPanel();
});

// ==========================================
// 각주 상자 위치잡기
// ------------------------------------------
//   ★ 각주 상자(.custom-footnote-content)는 position: fixed 다.
//     스킬 본문(.champ-skill-body)이 overflow-y: auto 라 **가로도 같이 잘려서**
//     (한 축이 visible 이 아니면 다른 축도 auto 로 계산된다)
//     화면 좌우 끝의 각주가 잘려 보였다. fixed 는 어떤 조상도 자르지 못한다.
//
//   대신 fixed 는 CSS 로 "부모 기준 가운데" 를 못 잡으므로 여기서 좌표를 찍어 준다.
//   각주 표시([1]) 의 가로 중심에 상자 중심을 맞춘다 — 기존 위치 그대로다.
//   (CSS 의 transform: translate(-50%, ...) 가 가운데 정렬과 아래 간격을 맡는다)
//
//   화면 밖으로 나가도 밀어 넣지 않는다. "영역을 침범해서라도 그대로 보여준다" 가 목적이다.
// ==========================================
function positionFootnote(fn) {
    const box = fn.querySelector('.custom-footnote-content');
    if (!box) return;
    const r = fn.getBoundingClientRect();
    let cx = r.left + r.width / 2;

    // ★ 폰에서만 화면 안으로 밀어 넣는다 (2026-08-19). 데스크톱은 "침범해서라도 그대로
    //   보여준다" 를 유지하지만, 폰은 화면이 좁아 밖으로 나간 부분을 볼 방법이 아예 없다.
    //   상자가 visibility:hidden(display 아님)이라 offsetWidth 는 숨어 있어도 정확하다.
    //   left 는 상자의 **중심**이다 (CSS 의 translate(-50%, …) 기준).
    if (window.innerWidth <= 768) {
        const half = box.offsetWidth / 2;
        const margin = 8;
        cx = Math.min(Math.max(cx, margin + half), window.innerWidth - margin - half);
    }

    box.style.left = cx + 'px';
    box.style.top = r.bottom + 'px';
}

//   mouseover 는 자식에서도 올라오므로 closest 로 각주를 찾는다.
//   :hover 로 보이기 **전에** 좌표가 찍히도록 mouseover 를 쓴다 (mouseenter 는 위임이 안 된다).
document.addEventListener('mouseover', (e) => {
    const fn = e.target instanceof Element ? e.target.closest('.custom-footnote') : null;
    if (fn) positionFootnote(fn);
}, true);

// ==========================================
// [6] 즐겨찾기 및 최근기록 로직
// ==========================================
// ★ 값이 한 번 깨지면(확장 프로그램·옛 형식) 즐겨찾기·최근검색이 통째로 죽고 뒤 코드까지 멈추던 것 —
//   파싱 실패는 빈 목록으로 (2026-09-03 감사 L-14)
function readLocalList(key) {
    try {
        const v = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
}
function getFavorites() { return readLocalList('pix_favorites'); }
function saveFavorites(favs) { localStorage.setItem('pix_favorites', JSON.stringify(favs)); }

function getRecents() { return readLocalList('pix_recent'); }
function saveRecents(recents) { localStorage.setItem('pix_recent', JSON.stringify(recents)); }

// 현재 보고 있는 소환사. 즐겨찾기 버튼 상태를 갱신할 때 쓴다.
let currentProfileName = null;

// 프로필의 즐겨찾기 버튼을 다시 그린다.
// 이미 등록된 소환사면 버튼 자체를 없앤다. (해제는 검색창 드롭다운의 ×로)
function renderProfileFavBtn() {
    const wrap = document.getElementById('profile-fav-wrap');
    if (!wrap) return;

    if (!currentProfileName || getFavorites().includes(currentProfileName)) {
        wrap.innerHTML = '';
        return;
    }

    wrap.innerHTML = `
        <button class="profile-fav-btn" onclick="addFavorite(currentProfileName)">즐겨찾기</button>`;
}

function addFavorite(name) {
    if (!name) return;
    let favs = getFavorites();
    if (favs.includes(name)) return;

    favs.push(name);
    if (favs.length > 10) favs.shift();
    saveFavorites(favs);

    renderDropdownList();
    renderProfileFavBtn();
}

function removeFavorite(name) {
    let favs = getFavorites();
    favs = favs.filter(f => f !== name);
    saveFavorites(favs);

    renderDropdownList();
    renderProfileFavBtn();   // 지운 소환사를 보고 있으면 버튼이 다시 나타난다
}

function addRecentSearch(name) {
    let recents = getRecents();
    recents = recents.filter(r => r !== name);
    recents.unshift(name);
    if (recents.length > 10) recents.pop();
    saveRecents(recents);
    renderDropdownList();
}

function removeRecentSearch(name) {
    let recents = getRecents();
    recents = recents.filter(r => r !== name);
    saveRecents(recents); renderDropdownList();
}

// ★ 드롭다운 자체는 공통 파일(DoguUI.mountHero 의 favorites/recents)이 그린다 (2026-08-22).
//   목록이 바뀌면 열려 있는 드롭다운만 다시 그려 달라고 한다. 옛 switchTab/pickDefaultDropdownTab
//   /renderDropdownList 본체와 focus/바깥 클릭 리스너는 전부 공통 파일로 넘어갔다
function renderDropdownList() {
    if (window.DoguUI) DoguUI.refreshDropdown();
}

// ==========================================
// [7] 통계 및 랭킹 페이지 로직
// ==========================================
// ============================================================
//  스킬·아이템·룬 툴팁 색 (2026-08-09 인게임 스크린샷 실측 / 2026-08-16 상수로 분리)
//
//    ★★ 이 표는 **한 벌만 있어야 한다.** 챔피언 스킬 탭과 도감 탭이 같이 쓴다 —
//      아이템·룬 설명도 라이엇이 같은 태그를 쓰기 때문이다 (도감에 나오는 36종 중
//      31종이 이미 여기 있었다). 복붙해서 두 벌이 되면 색이 어긋난다.
//
//    ★ style.css 로 옮기면 안 된다. `li` · `b` · `i` · `font` 같은 **진짜 HTML 태그**에도
//      규칙을 걸고 있어서, 전역이 되면 약관·개인정보 페이지의 <li> 까지 줄표가 붙는다
//      (index.html 5곳 · app.js 4곳에서 <li> 를 쓴다). 그래서 쓰는 쪽에 끼워 넣는다.
// ============================================================
// ==========================================
// ★ 각주 헬퍼 두 개 — 챔피언 스킬 각주와 도감 룬 각주가 **같은 함수를 쓴다**.
//   원래 custom_values.js 맨 앞에 있었는데 2026-08-21에 여기로 옮겼다.
//   도감(룬)에서도 필요한데 그 파일이 489KB 라 도감에서 받게 할 수 없었다.
//   ★ window 에 심는 이유: custom_values.js 가 `const drawGraph` 로 들고 있던 자리라,
//     옛 파일이 캐시에 남아 같이 로드돼도 const 가 이걸 가리기만 하고 **에러가 안 난다.**
//     (여기서도 const 로 선언하면 같은 이름이 두 번 선언돼 그 페이지가 통째로 죽는다)
//   ★ custom_graphs.js 는 로드되는 순간 이 함수들을 부른다. app.js 가 defer 로 먼저 돌고
//     그 안의 loadChampionData() 가 그 파일을 붙이므로 순서는 항상 보장된다.
// ==========================================

// 꺾은선 그래프 각주. drawGraph("각주번호", "선색상", [1렙, 2렙, ..., 18렙], "제목(생략 가능)")
//   ★ 4번째 인자는 값과 각주의 **단위가 다를 때**만 쓴다 (아이번 P 두 자리).
window.drawGraph = (id, color, dataArr, title) => {
    let max = Math.max(...dataArr);
    let width = 210, height = 90, padX = 15, padY = 20;

    let points = "";
    let elements = "";

    // 점 x좌표를 먼저 다 구해 둔다. 아래 "세로 히트존" 이 이웃 점과의 중간을 알아야 한다.
    const xs = dataArr.map((_, i) => padX + (i / (dataArr.length - 1)) * (width - padX * 2));

    dataArr.forEach((val, index) => {
        let x = xs[index];
        let y = (height - padY) - (val / max) * (height - padY * 2);
        points += `${x},${y} `;

        // 텍스트가 그래프 위로 뚫고 나가지 않도록 위치 자동 조정
        let textY = y - 10;
        if (textY < 12) textY = y + 18;

        // ★ 세로 히트존 (2026-08-11)
        //   예전엔 반지름 3.5px 점에 정확히 올려야만 수치가 떴다. 18개가 촘촘해서 매우 어렵다.
        //   그래서 각 점이 "담당하는 x 구간"을 그래프 높이만큼 덮는 투명 사각형을 깔고,
        //   CSS 인접 선택자(.graph-hit:hover + .graph-point)로 바로 뒤 점을 켠다.
        const left = index === 0 ? 0 : (xs[index - 1] + x) / 2;
        const right = index === dataArr.length - 1 ? width : (x + xs[index + 1]) / 2;

        //   ★ 히트존이 반드시 <g> **바로 앞**에 와야 한다. CSS 가 + 로 짝짓기 때문이다.
        elements += `
        <rect class="graph-hit" x="${left}" y="0" width="${right - left}" height="${height}" fill="transparent" />
        <g class="graph-point">
            <circle cx="${x}" cy="${y}" r="3.5" fill="${color}" />
            <text class="point-label" x="${x}" y="${textY}" text-anchor="middle" fill="#fff">Lv.${index + 1}: ${val}</text>
        </g>`;
    });

    return `<span class="custom-footnote">[${id}]
        <span class="custom-footnote-content">
            <div style="font-size: 12px; margin-bottom: 8px; color: #fff;">${title || '레벨별 성장 수치'} (Lv.1 ~ 18)</div>
            <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="overflow: visible;">
                <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" />
                ${elements}
                <text x="${padX}" y="${height - 2}" fill="#fff" font-size="10" text-anchor="middle">1</text>
                <text x="${width - padX}" y="${height - 2}" fill="#fff" font-size="10" text-anchor="middle">18</text>
                <text x="5" y="10" fill="${color}" font-size="11" font-weight="bold">${max}</text>
            </svg>
        </span>
    </span>`;
};

// 계단식 각주. drawSteps("각주번호", "선색상", [[1, 12], [7, 18], [13, 24]])
//   레벨마다 조금씩 크는 게 아니라 **특정 레벨에서만 값이 바뀌는** 자리용이다.
//   ★ 제목의 "상승 / 감소" 는 양 끝값을 비교해 정한다 — 줄어드는 계단(그라가스 12 -> 6)이 있다.
window.drawSteps = (id, color, pairs) => {
    const rows = pairs.map(([lv, val]) => `
        <div style="display:flex; justify-content:space-between; gap:14px; padding:2px 0;">
            <span style="color:#fff;">Lv.${lv}</span>
            <span style="color:${color}; font-weight: 700;">${val}</span>
        </div>`).join('');

    return `<span class="custom-footnote">[${id}]
        <span class="custom-footnote-content">
            <div style="font-size: 12px; margin-bottom: 6px; color: #fff;">${pairs.map(p => p[0]).join(' / ')}레벨에 ${pairs.length > 1 && Number(pairs[pairs.length - 1][1]) < Number(pairs[0][1]) ? '감소' : '상승'}</div>
            <div style="font-size: 12px; min-width: 96px;">${rows}</div>
        </span>
    </span>`;
};

const TOOLTIP_STYLE_CSS = `
            mainText { display: block; font-size: 14px; line-height: 1.6; color: #ddd; } stats { display: block; color: #a78bfa; font-size: 13px; margin-bottom: 12px; font-weight: 700; background: rgba(167, 139, 250, 0.05); padding: 10px; border-radius: 8px; border: 1px solid rgba(167, 139, 250, 0.1); }
            /* ★ 아래 색은 인게임 툴팁 스크린샷에서 픽셀을 직접 뽑은 값이다 (2026-08-09).
                 렐 W / 쉬바나 Q / 바드 P / 우디르 Q / 로크 W 를 썼고,
                 색이 나타나는 좌표가 해당 단어 위치와 맞는지 역으로 검증했다.
                 겹치는 태그는 서로 다른 스크린샷에서 같은 값이 나와 교차 확인됐다
                 (magicdamage 는 렐·쉬바나·바드 3장에서 동일).
                 ※ "구분이 잘 되게" 가 아니라 "인게임과 같게" 가 기준이다. 색끼리 비슷해도 그대로 둔다. */
            magicdamage { color: #0acbe6; font-weight: 700; } physicaldamage { color: #f26522; font-weight: 700; } truedamage { color: #cdfafa; font-weight: 700; }
            /* health 는 유미 P 처럼 <healing><health>…</health></healing> 로 중첩돼 있어
               같은 색을 쓴다. heal 도 같은 의미라 함께 묶었다 (실측한 건 healing 뿐). */
            healing, heal, health { color: #60e08f; font-weight: 700; } shield { color: #4dd0eb; font-weight: 700; }
            scalearmor { color: #f0ba57; } scalemr { color: #4fdfff; } scalemana { color: #189ce7; }
            keywordmajor { color: #dddd77; font-weight: 700; }
            speed { color: #fffdc9; font-weight: 700; } status { color: #ad76c4; font-weight: 700; }
            attackspeed { color: #ffe384; font-weight: 700; }
            spellname, onhit, scalelevel, attention, unique { color: #f0e6d2; font-weight: 700; }
            recast { color: #d67351; font-weight: 700; }
            scalead { color: #eb8d34; } scaleap { color: #786cff; }
            keywordstealth { color: #d182be; font-weight: 700; }
            evolve { color: #bc3598; font-weight: 700; }
            danger { color: #ff0000; font-weight: 700; }
            /* ★ 인게임 실측값은 #5a5955 인데 우리 배경이 인게임 툴팁보다 어두워서
                 거의 안 읽혔다. 밝기만 올린 값이다 (색상·채도는 그대로). 2026-08-12 */
            rules { color: #918f86; }
            /* 라벨류는 전부 "기본 지속 효과:" 색으로 통일한다.
               인게임은 스킬마다 미묘하게 다르지만(니코 W 는 사용 시만 연노랑,
               갈리오 W 는 충전 시작 시가 또 다름) 통일하는 쪽이 읽기 낫다는 판단. */
            active, passive, charge, release, toggle, tap, hold { display: block; margin-top: 8px; color: #f0e6d2; font-weight: 700; }
            /* ★ 이 태그들이 **파트 맨 앞**에 올 때는 위 여백을 없앤다 (2026-08-10).
               하위 스킬 파트는 각자 자기 <div> 에 들어가므로 첫 태그의 margin-top 8px 이
               텍스트만 아래로 밀어 **옆 아이콘과 수평이 어긋난다.**
               모데카이저 W(<active> 로 시작)와 르블랑 R(<spellname> 로 시작)이
               서로 다르게 보이던 원인이 이거였다. 구분선이 이미 간격을 주므로 여백은 불필요. */
            active:first-child, passive:first-child, charge:first-child,
            release:first-child, toggle:first-child, tap:first-child, hold:first-child { margin-top: 0; }
            /* 강인함(slow)은 인게임에서 색이 안 들어간다. 본문색을 그대로 따라간다. */
            slow { color: inherit; font-weight: normal; }
            /* scalehealth 와 lifesteal 은 실제로 같은 초록이다 (블라디미르 P / 아트록스 E).
               keyword 와 keywordstealth 도 같은 분홍보라다 (블라디미르 W / 니코 W).
               "구분이 안 된다" 가 아니라 라이엇이 원래 같은 색을 쓴다. */
            scalehealth, lifesteal { color: #1f995c; font-weight: 700; }
            keyword { color: #d182be; font-weight: 700; }
            armorpen { color: #f95f55; font-weight: 700; }
            omnivamp { color: #cb0c2d; font-weight: 700; }
            specialrules { color: #f0e6d2; font-weight: 700; }
            /* 아래는 인게임에서 색이 안 들어가는 자리다. 본문색을 그대로 따라간다. 전부 실측 확인:
               keywordname 탐 켄치 R "고정"·"심연 잠수", slow 가렌 W "60%의 강인함",
               level 애니비아 P, stattracking 드레이븐 P (뒤 둘은 스샷에 강조색 자체가 없었다). */
            keywordname, stattracking, level { color: inherit; }
            /* ★ <li> 에 CSS 가 없어서 브라우저 기본 불릿(동그라미)이 찍히고 있었다 (2026-08-12).
                 <ul> 없이 <li> 만 쓰는 문장이라 마커가 글 밖으로 삐져나오기도 했다.
                 인게임 툴팁은 동그라미가 아니라 짧은 줄표를 쓴다. DD 폴백 경로도
                 cleanTooltipText 가 <li> 를 "- " 로 바꾸고 있어서 이제 양쪽이 같아졌다. */
            li { display: block; margin: 2px 0; }
            li::before { content: '- '; color: #9aa4af; }
            /* activerank 는 구분선 아래 회색 글씨에서만 나온다 (볼리베어 E 한 자리).
               인게임 색을 실측한 적이 없으므로 색을 지어내지 않고 본문색을 따라간다. */
            activerank { color: inherit; }
            /* ★ 구분선 아래 회색 글씨(.skill-rules) 안에서는 라벨류를 인라인으로 되돌린다.
                 위 규칙이 display:block 이라 문장 한가운데서 줄이 끊긴다 —
                 이렐리아 W 의 "<charge>충전</charge>이 끝나면" 이 세 줄로 갈라졌다.
                 여기서는 라벨이 아니라 그냥 단어로 쓰인다. */
            .skill-rules active, .skill-rules passive, .skill-rules charge,
            .skill-rules release, .skill-rules toggle, .skill-rules tap, .skill-rules hold
                { display: inline; margin-top: 0; }
            /* --- 문장에 안 쓰이는 태그. 확인 대상이 아니다 --- */
            gold { color: #ffd700; font-weight: 700; }
            b { font-weight: 700; }
            i { font-style: italic; }
            /* ★ <font color=...> 는 라이엇이 원문에 색을 직접 박아 둔 것이고,
                 그 값이 인게임 색과 정확히 일치한다 (바드 P 의 "고대의 종" #cccc00,
                 "정령" #ff9900 을 스크린샷에서 뽑아 확인). 그러니 color 는 건드리지 않는다.
                 예전엔 여기서 color 를 !important 로 덮어써서 44곳의 라이엇 지정색이
                 전부 죽어 있었다 (아펠리오스 무기색·바드 종·아우렐리온 솔 별가루 등).
                 font-size 는 원문에 <font size='18'> 같은 게 있어 글자가 튀므로 계속 막는다. */
            font { display: inline; font-size: inherit !important; font-weight: 700; }
            /* ★ 아래 5종은 **도감(아이템·룬)에만 나오는 태그**다 (2026-08-16).
                 위 색들과 달리 인게임 스크린샷 실측이 아니라 뜻에 맞춰 고른 값이다 —
                 나중에 실측하면 여기만 고치면 된다. 도감 36종 중 나머지 31종은
                 스킬 툴팁에서 이미 실측해 둔 값을 그대로 쓴다. */
            raritylegendary { color: #ff9b00; font-weight: 700; }   /* 아이템 "전설" 표기 */
            raritygeneric { color: #f0e6d2; font-weight: 700; }
            scalelethality { color: #f95f55; }                        /* armorpen 과 같은 계열이라 맞췄다 */
            statgood { color: #60e08f; font-weight: 700; }
            /* 룬 설명의 커스텀 엘리먼트. 인게임에선 hover 하면 용어 설명이 뜨는 자리인데
               우리는 그 툴팁이 없으므로 점선 밑줄로 "용어" 라는 것만 표시한다. */
            lol-uikit-tooltipped-keyword { color: inherit; border-bottom: 1px dotted rgba(255,255,255,0.35); }
            .custom-footnote { position: relative; display: inline-block; cursor: pointer; color: #a78bfa; margin-left: 2px; }
            .custom-footnote .footnote-text {
                visibility: hidden; width: max-content; max-width: 250px; background-color: #111; color: #fff;
                text-align: left; border-radius: 6px; padding: 6px 10px; position: absolute; z-index: 99;
                bottom: 150%; left: 50%; transform: translateX(-50%); border: 1px solid rgba(255,255,255,0.2);
                font-size: 12px; font-weight: normal; line-height: 1.5; opacity: 0; transition: opacity 0.2s; box-shadow: 0 4px 10px rgba(0,0,0,0.8);
            }
            .custom-footnote:hover .footnote-text { visibility: visible; opacity: 1; }
            .skill-damage-line { color: #ddd; font-size: 14px; line-height: 1.7; }
            .skill-damage-line + .skill-damage-line { margin-top: 6px; }
`;

// ============================================================
// 챔피언 통계 (티어리스트) — 2026-08-15에 실제 집계로 교체
//
//   예전엔 statsData.js 의 하드코딩 샘플을 썼다. 지금은 server.js 의
//   /api/champion-stats 가 champstats 컬렉션을 그대로 내려준다.
//   ★ 표본은 "마스터+ 가 5명 이상인 솔랭" 이다. 전체 티어 통계가 아니다
//     — 명단 1.1만 명을 전수로 훑기 때문에 그 구간만은 커버리지가 높다.
// ============================================================
const STAT_POS = [
    { code: 0, key: 'top', name: '탑' },
    { code: 1, key: 'jungle', name: '정글' },
    { code: 2, key: 'mid', name: '미드' },
    { code: 3, key: 'adc', name: '바텀' },
    { code: 4, key: 'support', name: '서포터' }
];
// ★ 라인 아이콘을 op.gg CDN → 라이엇 공식(CommunityDragon) 으로 바꿨다 (2026-08-19).
//   남의 사이트 정적 자산을 핫링크하면 그쪽이 리퍼러 차단·경로 변경만 해도 아이콘이
//   전부 깨지고, 우리 심사(라이엇 프로덕션 키)에도 좋을 게 없다.
//   CD 아이콘은 금색(#c8aa6e) 클라이언트 원본이라 invert 필터 없이 그대로 쓴다 —
//   style.css 의 .stats-lane img / .stats-filter-btn img 에서 invert(1) 을 뺐다.
const STAT_LANE_ICON = {
    top: 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg/position-top.svg',
    jungle: 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg/position-jungle.svg',
    mid: 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg/position-middle.svg',
    adc: 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg/position-bottom.svg',
    support: 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg/position-utility.svg'
};

// ★ 이 아래는 티어를 안 매기고 회색으로 둔다. 30판이면 승률 95% 신뢰구간이
//   ±18%p 라, 숫자를 진하게 찍으면 없느니만 못하다.
const STAT_MIN_GAMES = 30;

// ============================================================
//  티어 계산 (2026-08-28 개편 — lol.ps · 딥롤과 같은 기준으로. 그 전(08-17)은 z 점수 가중합 → S~D)
//
//    ★★ **라인별 pool 안에서만 비교한다.** 서포터와 미드를 같은 잣대로 재는 게 뜻이 없다
//      (라인마다 평균 승률도 분포도 다르다). ALL 탭도 마찬가지라, 거기 찍히는 티어는
//      **그 챔피언의 주 라인에서 받은 티어**다.
//
//    점수 = 1.5 + 0.86·보정승률 + 3.1·ln(1+픽률) + 0.6·ln(1+밴률)     (50 근처, 높을수록 좋다)
//    티어 = OP ≥ 56 · 1 ≥ 53.5 · 2 ≥ 50.5 · 3 ≥ 48.5 · 4 ≥ 45.5 · 나머지 5
//
//    ★★ 계수는 lol.ps 의 「PS 점수」를 26.16 마스터+ 256줄로 회귀해서 얻었다 (R² 0.90).
//      옛 공식(승률 60%·밴 25%·픽 15%)과의 결정적 차이는 **픽률 비중**이다 — 픽률 1% → 10%
//      가 승률 +6%p 와 같다. 그래서 승률 55% 라도 픽률 0.6% 면 5티어다 (탑 제드·퀸 — lol.ps ·
//      딥롤 둘 다 그렇게 찍는다. 옛 공식은 S 였다). 우리 16.16 자료에 넣으면 lol.ps 마스터+ 와
//      티어 일치 59% · 한 칸 차이 안 99% (옛 공식 44% / 91%). 라인 평균 점수도 우리 49.5 vs
//      lol.ps 49.2~50.3 이라 계수를 그대로 써도 된다.
//    ★ 컷은 lol.ps 의 라인별 경계(1티어 53.3 · 2티어 50.5 · 3티어 49 · 4티어 45.5 ±0.5)를
//      우리 자료에서 일치율로 다듬은 값이다. z 컷이 아니라 **고정 점수 컷**이라 표본이 얇은
//      패치 초반엔 보정 승률이 가운데로 몰려 1·5티어가 저절로 적어진다 (의도한 것).
//    ★ OP 는 점수 56 이상 하나다. lol.ps 의 OP 판정은 점수만으로는 안 맞아서(56 넘는데 OP
//      아닌 줄이 있다) 정확히 못 옮겼다 — 16.16 에서 리 신·니달리·카이사 셋이고 그쪽도 셋 다 OP 다.
//    ★ 밴률은 **챔피언 전체 밴률**을 그대로 쓴다 (lol.ps 도 그렇다). 옛 공식은 라인 비율로
//      배분했는데, 그걸 넣으면 일치율이 떨어졌다. 값은 `banGames`(밴된 판 수)다 — 화면 표기
//      `bans`(밴 슬롯)는 양 팀이 같은 챔피언을 밴하면 2로 세어 100% 를 넘는다.
//    ★ 보정 승률(prior 200)은 08-17 것 그대로다. lol.ps 는 표본이 우리 1.6배라 날 승률을
//      쓰지만, 우리 30판 컷에서 날 승률을 쓰면 표본 적은 챔피언이 양 끝을 차지한다.
//      prior 를 0/50/100/200/300 으로 훑었을 때 일치율이 55 → 62% 로 올라가는 쪽이라 200 을 유지.
// ============================================================
const TIER_COEF = { base: 1.5, win: 0.86, pick: 3.1, ban: 0.6 };
const TIER_PRIOR = 200;     // 보정 승률의 사전 표본 (판)
const TIER_CUTS = [['OP', 56], ['1', 53.5], ['2', 50.5], ['3', 48.5], ['4', 45.5]];
// 티어 라벨 → CSS 클래스 접미사 (tier-op · tier-1 …)
const tierClass = (t) => `tier-${String(t).toLowerCase()}`;

const tierFromScore = (s) => (TIER_CUTS.find(([, cut]) => s >= cut) || ['5'])[0];

// list = collect() 결과 (champ|pos 행), total = scope 총 경기 수
//   → Map("champ|pos" -> { tier, score })
function computeLaneTiers(list, total) {
    const banOf = {};
    list.forEach(c => { if (c.pos === -1) banOf[c.champ] = c.banGames || 0; });

    const out = new Map();
    STAT_POS.forEach(({ code }) => {
        const pool = list.filter(c => c.pos === code && c.games >= STAT_MIN_GAMES);
        // 라인에 챔피언이 몇 개 없으면 라인 평균 승률이 뜻을 잃는다. 그땐 티어를 안 매긴다(화면엔 '-').
        if (pool.length < 5) return;

        // 라인 평균 승률 (판수 가중). 보정 승률이 이쪽으로 당겨진다.
        const sumG = pool.reduce((a, c) => a + c.games, 0);
        const sumW = pool.reduce((a, c) => a + c.wins, 0);
        const p0 = sumG ? sumW / sumG : 0.5;

        pool.forEach(c => {
            const win = (c.wins + TIER_PRIOR * p0) / (c.games + TIER_PRIOR) * 100;
            const pick = total ? c.games / total * 100 : 0;
            const ban = total ? (banOf[c.champ] || 0) / total * 100 : 0;
            const score = TIER_COEF.base + TIER_COEF.win * win
                + TIER_COEF.pick * Math.log(1 + pick) + TIER_COEF.ban * Math.log(1 + ban);
            out.set(`${c.champ}|${code}`, { tier: tierFromScore(score), score });
        });
    });
    return out;
}

// ★ 화면 표기용 패치 번호 (2026-08-31, 260830 디자인 8-1). 내부(주소·API·scope 키·집계)는
//   DD 번호(16.x) 그대로 쓰고 **보여줄 때만** 라이엇 공식 표기(26.x)로 — 앞자리 +10.
//   앞자리가 20 이상이면 이미 공식 표기(PBE 트윗의 26.x 등)라 그대로 둔다.
function patchDisplay(v) {
    const m = String(v || '').match(/^(\d+)\.(\d+)/);
    if (!m) return String(v || '');
    const major = Number(m[1]);
    return `${major < 20 ? major + 10 : major}.${m[2]}`;
}

function statScopeLabel(scope) {
    if (!scope) return '';
    return scope.startsWith('p:') ? `${patchDisplay(scope.slice(2))} 패치` : `${scope.slice(2)}`;
}

// ★★ 범위 드롭다운은 **패치만** 올린다 (2026-09-08 사용자 요청).
//   서버는 일별 범위(`d:2026-09-08`, 최근 7일)를 그대로 집계하고 응답에도 담는다 —
//   **고르는 자리에서만** 뺀다. 다시 보이게 하려면 이 filter 한 줄이면 된다.
//   ★ 지금 보고 있는 범위가 일별이면 그 하나는 남긴다. 안 남기면 select 가 값을 잃고
//     **엉뚱한 패치가 골라진 것처럼** 보인다 (기본값은 pickStatScope 가 항상 패치로 준다).
//   쓰는 곳 셋: 통계 표(#stats-scope) · 챔피언 상세 툴바(#lx-scope) · 조합 페이지
function scopeOptionsHtml(scopes, cur) {
    return (scopes || [])
        .filter(s => s.startsWith('p:') || s === cur)
        .map(s => `<option value="${s}"${s === cur ? ' selected' : ''}>${statScopeLabel(s)}</option>`)
        .join('');
}

// ============================================================
//  도감 — 아이템 · 룬 · 소환사 주문 (2026-08-16 신설)
//
//    왼쪽 목록 + 오른쪽 상세. 골격은 스킨 탭과 같다.
//    데이터는 build_codex_data.js 가 만든 codex_data.js 한 파일이다 (런타임 의존 0).
//
//    ★ 설명 안의 <passive>·<magicDamage> 같은 태그는 **챔피언 스킬 툴팁과 같은 계열**이라
//      TOOLTIP_STYLE_CSS 를 그대로 끼워 넣는다. 색표를 두 벌 두면 어긋난다.
// ============================================================
let codexDataPromise = null;
function loadCodexData() {
    if (codexDataPromise) return codexDataPromise;
    // ★ 도감 묶음은 두 개다 — codex_data.js(본체) + rune_graphs.js(룬 각주).
    //   각주 파일을 못 받아도 도감은 떠야 하므로 **본체만 있으면 성공**으로 친다.
    const tags = Array.from(document.querySelectorAll('script.lazy-codex-data[data-src]'));
    if (!tags.length) return Promise.reject(new Error('codex_data.js 태그가 없습니다.'));

    codexDataPromise = Promise.all(tags.map(tag => new Promise(done => {
        const s = document.createElement('script');
        s.async = false;
        s.src = tag.dataset.src;      // ?v=mtime 은 server.js 가 붙여 놨다
        s.onload = done;
        s.onerror = done;             // 각주가 없으면 그 자리만 안 붙는다
        document.head.appendChild(s);
    }))).then(() => {
        if (typeof codexData === 'undefined') throw new Error('도감 데이터를 받지 못했습니다.');
        return codexData;
    });
    codexDataPromise.catch(() => { codexDataPromise = null; });
    return codexDataPromise;
}

// ★★ 아이템 등급은 게임 bin 의 `epicness` 다 (2026-08-16 정정. build_codex_data.js 가 `ep` 로 담는다).
//   예전엔 DD 의 `depth` 를 등급이라 보고 `기본/중급/완성` 이라 적었는데 **둘 다 틀렸다** —
//   `depth` 는 재료를 몇 겹 쌓았나라서 **무한의 대검(3500G, 전설급)이 depth 2 로 거인의
//   허리띠(900G, 서사급)와 같은 칸**에 들어갔고, 실제로 "중급" 으로 찍히고 있었다.
//   이름도 우리가 지어낸 것이고 라이엇 공식 한국어는 stringtable 의 `shop_group_*` 에 있다.
// ★ 값을 합치지 않고 라이엇이 나눈 그대로 5칸이다. 7번은 영약 3 + 신발 업그레이드 7 이
//   섞여 있어 공식 이름이 없다 — 그 칸만 우리가 이름을 붙여야 한다.
//   ★ `상위` 로 뒀다 (stringtable 의 `shop_group_superior`). 처음엔 `기타` 였는데
//     **아래 분류 줄 마지막 칸도 `기타` 라 위아래로 같은 이름이 나란히 붙었다.**
// ★ 2026-09-08: **시작 → 기본** 순으로 뒤집었다 (사용자 요청). `order` 는 목록 정렬용이고
//   아래 CODEX_DEPTH_CATS 의 버튼 순서와 **짝이다** — 한쪽만 바꾸면 버튼 차례와 목록 차례가 어긋난다.
const CODEX_EPICNESS = {
    0: { name: '기본', order: 1 },      // 장화·롱소드·B.F. 대검 … (bin 에 필드가 아예 없다)
    1: { name: '시작', order: 0 },      // 도란템·물약·와드·장신구
    4: { name: '서사급', order: 2 },
    5: { name: '전설급', order: 3 },
    7: { name: '상위', order: 4 }       // 영약 3 + 신발 업그레이드 7
};
// 처음 보는 값이 와도 목록에서 사라지지 않게 맨 뒤 칸으로 흘려보낸다
const epInfo = ep => CODEX_EPICNESS[ep] || { name: '상위', order: 4 };

// 왼쪽 목록 위 분류 버튼. **등급과 계열 두 줄이고 서로 AND 로 걸린다** (2026-08-16).
//   ★ 소모품·장신구는 계열로 갈라 봐야 뜻이 없어서(스탯이 아니라 쓰는 물건이다)
//     "소모품" 으로 따로 뺐다. 예전엔 "기타" 안에 장신구·와드와 섞여 있었다.
//   ★ 태그는 아이템 하나에 여러 개 붙으므로 **계열 분류는 겹친다.**
//     공격 + 방어에 같이 나오는 아이템이 있고 합계가 215를 넘는 게 정상이다.
//     겹치지 않는 건 등급 쪽뿐이다 (epicness 는 아이템당 하나다).
//   ★ 마지막 칸은 `ep === 7` 이 아니라 **"앞 네 칸에 안 걸리는 전부"** 로 잡는다.
//     라이엇이 새 등급 값을 쓰기 시작해도 그 아이템이 목록에서 통째로 사라지지 않는다.
const CODEX_DEPTH_CATS = [
    { key: 'all', name: '전체', test: () => true },
    { key: '1', name: '시작', test: it => it.ep === 1 },   // ★ 시작이 기본보다 앞 (2026-09-08, 위 CODEX_EPICNESS 와 짝)
    { key: '0', name: '기본', test: it => it.ep === 0 },
    { key: '4', name: '서사급', test: it => it.ep === 4 },
    { key: '5', name: '전설급', test: it => it.ep === 5 },
    { key: 'etc', name: '상위', test: it => ![0, 1, 4, 5].includes(it.ep) }
];

// ★★★ 예전 "분류" 7칸(공격·주문·방어·신발·소모품·장신구·기타)을 걷어냈다 (2026-08-25).
//   **묶는 기준도 칸 이름도 우리가 지어낸 것**이었다 — 라이엇에 대응하는 이름이 아예 없었다.
//   지금은 둘 다 라이엇 것으로 바꿨다:
//     · 역할군(`CODEX_ROLES`)   게임 bin `mItemAttributes` + stringtable `shop_filter_*_tooltip`
//     · 스탯(`CODEX_STATS`)     DD `tags` + stringtable `stats_filter_*`
//   **라이엇 인게임 상점이 정확히 이 두 축으로 나눈다** — 위가 "유형:", 왼쪽이 스탯 목록이다.

// ★ 역할군. bin `mItemAttributes` 의 **비트 플래그**이고 아이템 하나가 여럿에 들어간다(정상).
//   이름은 stringtable `shop_filter_*_tooltip` 그대로다. 순서도 비트 순(라이엇이 정한 순서).
//   ★ 어느 비트가 무엇인지는 전설급만 보면 갈린다 — 근거는 build_codex_data.js 의 `rolesOf` 주석.
const CODEX_ROLES = [
    { key: 'all', name: '전체', bit: 0 },
    { key: '1', name: '전사', bit: 1 },
    { key: '2', name: '원거리 딜러', bit: 2 },
    { key: '4', name: '암살자', bit: 4 },
    { key: '8', name: '탱커', bit: 8 },
    { key: '16', name: '마법사', bit: 16 },
    { key: '32', name: '서포터', bit: 32 }
];

// ★ 스탯. 인게임 상점 **왼쪽 세로 목록**이고 이름은 stringtable `stats_filter_*` 그대로다.
//   ★ `tags` 는 DD 것이고 **bin `mCategories` 와 215개 전부 같다**(2026-08-25 전수 확인).
//   ★ 태그↔칸 연결은 우리가 잇는다 — 열다섯 중 열은 1:1 이고 다섯만 둘씩 묶인다
//     (스킬 가속·마나·체력·마법 저항력·이동 속도). 라이엇이 그 대응표를 데이터로 주지는 않는다.
//   ★ 순서는 인게임 상점 차례를 따랐다 (공격 → 주문 → 방어 → 유틸).
//   ★ 남는 태그 열하나(Lane·Active·Vision·Consumable·Tenacity·Jungle·GoldPer·Slow·Aura·
//     Trinket·Stealth)는 스탯이 아니라 성격 태그라 목록에 없다 — 인게임 상점에도 없다.
//   ★★ 순서와 칸 수는 **인게임 화면을 보고 맞췄다** (2026-08-25, 사용자 확인).
//     `스킬 가속` 은 마법 저항력 **뒤**고, 마지막 셋이 `스킬 가속 · 이동 속도 ·
//     생명력 흡수 및 모든 피해 흡혈` 이다. 열넷이고 **`생명력 흡수 및 주문 흡혈` 칸은 없다** —
//     stringtable 에 `stats_filter_spellvamp` 키가 있긴 하지만 협곡 상점 목록에는 안 쓴다.
//     그래서 `SpellVamp` 태그는 `모든 피해 흡혈` 칸이 같이 받는다 (이름 그대로다).
const CODEX_STATS = [
    { key: 'physical_damage', name: '공격력', tags: ['Damage'] },
    { key: 'critical_strike', name: '치명타', tags: ['CriticalStrike'] },
    { key: 'attack_speed', name: '공격 속도', tags: ['AttackSpeed'] },
    { key: 'on_hit', name: '적중 시 효과', tags: ['OnHit'] },
    { key: 'armor_penetration', name: '방어구 관통력', tags: ['ArmorPenetration'] },
    { key: 'ability_power', name: '주문력', tags: ['SpellDamage'] },
    { key: 'magic_penetration', name: '마법 관통력', tags: ['MagicPenetration'] },
    { key: 'mana', name: '마나 및 재생', tags: ['Mana', 'ManaRegen'] },
    { key: 'health', name: '체력 및 재생', tags: ['Health', 'HealthRegen'] },
    { key: 'armor', name: '방어력', tags: ['Armor'] },
    { key: 'magic_resistance', name: '마법 저항력', tags: ['SpellBlock', 'MagicResist'] },
    { key: 'ability_haste', name: '스킬 가속', tags: ['AbilityHaste', 'CooldownReduction'] },
    { key: 'movespeed', name: '이동 속도', tags: ['NonbootsMovement', 'Boots'] },
    { key: 'vamp', name: '생명력 흡수 및 모든 피해 흡혈', tags: ['LifeSteal', 'SpellVamp'] }
];

// ★★ 도감 4칸 (2026-08-27). 헤더 드롭다운과 **같은 차례**로 도감·챔피언 페이지 머리에 깐다.
//   - 이력은 **덮어쓴다**(replaceState) — 주소 규칙의 "메뉴 진입만 이력을 쌓는다" 그대로다.
//     헤더 드롭다운으로 들어오는 건 메뉴 진입이라 각 show* 가 pushState 한다
//   - 클릭은 아래 위임 리스너 하나가 받는다 (도감·챔피언 어느 페이지에서 눌러도 같은 길)
const CODEX_NAV = [
    { key: 'champions', name: '챔피언',      href: '/champions',   navId: 'nav-champions' },
    { key: 'item',      name: '아이템',      href: '/codex/item',  navId: 'nav-codex-item' },
    { key: 'rune',      name: '룬',          href: '/codex/rune',  navId: 'nav-codex-rune' },
    { key: 'spell',     name: '소환사 주문', href: '/codex/spell', navId: 'nav-codex-spell' }
];

// 탭마다 마지막으로 고른 항목 — 탭이 페이지가 됐어도(2026-08-27) 돌아오면 보던 걸 다시 연다.
// ★ showCodex 안에 두면 페이지를 다시 그릴 때마다 비므로 여기(모듈 자리)에 있어야 한다
const codexLastPick = {};

function codexTabsHtml(active) {
    return `<div class="codex-tabs">${CODEX_NAV.map(t =>
        `<button class="codex-tab${t.key === active ? ' active' : ''}" data-codex="${t.key}">${t.name}</button>`).join('')}</div>`;
}

function goCodexTab(key) {
    const t = CODEX_NAV.find(x => x.key === key);
    if (!t) return;
    // 주소를 먼저 맞춘다 — 그래야 아래 show* 가 자기 pushState 를 건너뛰어 이력이 안 쌓인다
    if (window.location.pathname !== t.href) window.history.replaceState({ page: 'codex' }, '', t.href);
    if (key === 'champions') showChampions();
    else showCodex(key);
    setActiveNav(t.navId);
}

document.addEventListener('click', (e) => {
    const b = e.target.closest('.codex-tab[data-codex]');
    if (b) goCodexTab(b.dataset.codex);
});

const CODEX_TABS = [
    { key: 'item', name: '아이템' },
    { key: 'rune', name: '룬' },
    { key: 'spell', name: '소환사 주문' }
];

// ★★ 도감 채택률 (주문 2026-08-26 · 아이템·룬 2026-09-01). 도감에서 **유일하게 런타임 API 를
//   부르는 자리**다. 도감은 "codex_data.js 한 파일 · 런타임 의존 0" 이 원칙인데, 통계는 매시간
//   바뀌어서 파일에 구울 수가 없다. 그래서 여기만 예외다 — **실패해도 화면은 그대로**고
//   상세에서 그 칸만 안 나온다 (아래 catch 가 조용히 넘긴다).
//   ★ 탭마다 한 번씩만 받는다. 그 탭에 들어갈 때 부르고 그 뒤로는 캐시를 쓴다.
//   ★ 서버가 무엇을 세는지는 `usagePayload` 주석 참고 (챔피언 픽 합계가 분모라 합이 200%·600%).
//   ★★ 응답 필드 이름이 셋 다 다르다 (`spells`/`items`/`runes`) — 받아서 `map` 으로 통일해 둔다.
const USAGE_API = {
    spell: ['/api/spell-usage', 'spells'],
    item: ['/api/item-usage', 'items'],
    rune: ['/api/rune-usage', 'runes']
};
const usageData = {};
const usageTried = {};
async function ensureUsage(kind, onLoad) {
    if (usageTried[kind]) return;
    usageTried[kind] = true;
    try {
        // 챔피언 아이콘·한글 이름이 필요하다. 이미 받아 뒀으면 재요청하지 않는다.
        await fetchChampionMap();
        const [url, field] = USAGE_API[kind];
        const res = await fetch(url);
        const j = await res.json();
        if (j && j.ready && j.picks) {
            usageData[kind] = { picks: j.picks, scope: j.scope, map: j[field] || {} };
            if (onLoad) onLoad();
        }
    } catch (e) {
        // 곁가지라 조용히 넘긴다 — 상세의 나머지는 그대로 나온다
    }
}

// 아이콘 주소
const codexItemIcon = id => `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png`;
const codexSpellIcon = f => `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/spell/${f}`;
// 룬·계열·파편은 CD 경로다. 소문자 변환은 스킨 탭이 쓰던 그 함수가 한다.
const codexPerkIcon = p => cdAssetUrl(p);

// ★★ 룬 설명의 레벨 스케일 수치 뒤에 각주를 단다 (2026-08-21).
//   챔피언 스킬 각주와 **같은 drawGraph** 를 쓴다 — 그래서 생김새·조작이 똑같다.
//   값은 rune_graphs.js (build_rune_graphs.js 가 롤위키에서 만든다).
//   ★ 자리는 `a`(문장에 그대로 있는 문자열)로 찾는다. 패치로 문장이 바뀌면 **조용히 안 붙는다** —
//     엉뚱한 자리에 붙는 것보다 낫고, 빌드 스크립트가 그때 경고를 찍는다.
function withRuneGraphs(id, html) {
    return withGraphNotes((typeof runeGraphs !== 'undefined' && runeGraphs[id]) || [], html);
}

// ★ 각주를 끼우는 알맹이. **룬(rune_graphs.js)과 소환사 주문(codex_data 의 `g`)이 같이 쓴다**
//   — 둘 다 `{a: 붙일 문자열, t: 제목, c: 색, v: 1~18레벨 값}` 꼴이라 로직이 같다
//   (2026-08-26에 함수로 뺐다. 표를 두 벌 두면 어긋난다).
function withGraphNotes(list, html) {
    if (!list.length || typeof drawGraph !== 'function') return html;

    // ★ 자리를 **원문 기준으로 먼저 다 찾아 두고 뒤에서부터** 끼운다.
    //   앞에서부터 끼우면 각주 HTML 길이만큼 뒤쪽 자리가 밀린다.
    const spots = [];
    list.forEach(g => {
        const at = html.indexOf(g.a);
        if (at >= 0) spots.push({ end: at + g.a.length, g });
    });
    spots.sort((a, b) => a.end - b.end);
    spots.forEach((s, i) => { s.no = i + 1; });          // 번호는 읽는 순서대로
    spots.slice().reverse().forEach(s => {
        html = html.slice(0, s.end) + drawGraph(String(s.no), s.g.c, s.g.v, s.g.t) + html.slice(s.end);
    });
    return html;
}

async function showCodex(target) {
    // ★ 주소에 탭까지 담는다 (2026-08-27) — 아이템·룬·소환사 주문이 각각 헤더 메뉴가 됐다
    const wantTab = CODEX_TABS.some(t => t.key === target) ? target : 'item';
    if (!window.location.pathname.startsWith('/codex')) {
        window.history.pushState({ page: 'codex' }, '', '/codex/' + wantTab);
    }
    hideAllContainers();
    const box = document.getElementById('codex-container');
    box.style.display = 'block';
    // ★ 아이템↔룬↔주문끼리 옮길 때도 등장 모션이 돌게 (2026-08-31, 사용자 요청).
    //   컨테이너가 이미 떠 있으면 위 display 토글이 같은 프레임에 합쳐져 fadeIn 이 재시작을 안 한다 —
    //   animation 을 껐다가 reflow 로 확정한 뒤 되살려 강제로 다시 돌린다 (챔피언↔3종은 원래 나온다)
    box.style.animation = 'none';
    void box.offsetWidth;
    box.style.animation = '';
    box.innerHTML = skelCodexHtml();

    let D;
    try {
        D = await loadCodexData();
    } catch (e) {
        box.innerHTML = `<div class="codex-empty">도감 데이터를 불러오지 못했습니다.</div>`;
        return;
    }

    let curTab = wantTab;
    let curRole = 'all';    // 아이템 역할군 (전사·원거리 딜러·암살자·탱커·마법사·서포터 — bin mItemAttributes)
    let curStat = 'all';    // 아이템 스탯 (인게임 상점 왼쪽 목록 — DD tags)
    let curDepth = 'all';   // 아이템 등급 (기본·시작·서사급·전설급·상위)
    let curStyle = 'all';   // 룬 계열 (정밀·지배·마법·영감·결의·파편)
    let runeView = 'tree';  // 룬 탭 보기: 'tree'(인게임 자리) | 'list'(평평한 목록)
    let query = '';
    let selected = codexLastPick[wantTab] || null;   // 지금 고른 항목 id (탭마다 따로 기억한다)
    // ★ 파편은 같은 id 가 두 칸에 있어서(적응형 1·2줄 / 체력 증가 2·3줄) id 만으로는
    //   어느 칸을 눌렀는지 모른다. 켜지는 건 **누른 칸 하나**여야 해서 칸 열쇠를 따로 든다.

    // ★ TOOLTIP_STYLE_CSS 를 여기 끼운다. style.css 로 못 옮기는 이유는 그 상수 주석 참고.
    box.innerHTML = `
        <style>${TOOLTIP_STYLE_CSS}</style>
        <!-- ★ 제목("도감" + 개수)은 뺐다 (2026-08-27, 요청) — 4칸 줄이 곧 제목 노릇을 한다.
             그래서 챔피언 탭과 줄 높이가 같아져 탭을 옮겨도 화면이 안 튄다 -->
        ${codexTabsHtml(curTab)}
        <div class="codex-body">
            <div class="codex-left">
                <input type="text" class="codex-search" id="codex-search" placeholder="이름 검색 (초성 · 별명)">
                <div class="codex-cats" id="codex-cats"></div>
                <!-- ★ 아이템 탭만 왼쪽에 스탯 목록이 붙는다 (인게임 상점과 같은 자리).
                     룬·주문 탭에서는 statbar 를 숨겨 목록이 폭을 다 쓴다. -->
                <!-- ★ 폰 전용 스탯 줄 접기 (2026-08-31, 260830 디자인 8-5). 데스크톱·룬·주문 탭에선 CSS 가 숨긴다 -->
                <button type="button" class="codex-statbar-toggle" id="codex-statbar-toggle">스탯 필터 ▾</button>
                <div class="codex-left-body">
                    <div class="codex-statbar" id="codex-statbar"></div>
                    <div class="codex-list" id="codex-list"></div>
                </div>
            </div>
            <div class="codex-detail" id="codex-detail"></div>
        </div>
    `;

    // ★ 폰 스탯 줄 접기 토글 (2026-08-31). 접힘이 기본 — CSS 가 .is-open 없는 statbar 를 숨긴다
    document.getElementById('codex-statbar-toggle').addEventListener('click', function () {
        const open = document.getElementById('codex-statbar').classList.toggle('is-open');
        this.textContent = open ? '스탯 필터 ▴' : '스탯 필터 ▾';
    });

    // ── 탭별 항목 목록을 한 모양으로 맞춘다
    function entries() {
        if (curTab === 'item') {
            return Object.keys(D.items).map(id => {
                const it = D.items[id];
                // ★ 등급을 같이 적는다. 목록이 [등급 → 가격] 순이라 등급이 넘어가는 자리에서
                //   가격이 되돌아가는데(1,300 다음에 400), 등급이 안 보이면 정렬이 깨진 것처럼 읽힌다.
                return {
                    id, name: it.n, icon: codexItemIcon(id),
                    sub: `${epInfo(it.ep).name} · ${it.g.toLocaleString()} G`,
                    raw: it, sort: [epInfo(it.ep).order, it.g]
                };
            });
        }
        if (curTab === 'rune') {
            // ★★ 정렬이 가나다순이 아니라 **인게임 자리 순서**다 (계열 → 줄 → 줄 안의 자리).
            //   codex_data 의 `styles[].sl` 이 CD perkstyles 슬롯 배열 그대로라 그걸 따라 담기만 하면 된다.
            //   이름순으로 세우면 20슬롯 중 17개가 클라와 어긋난다
            //   (정밀 핵심룬이 "기민한 발놀림 / 정복자 / 집중 공격 / 치명적 속도" 로 나왔다).
            const list = [];
            Object.keys(D.styles).sort((a, b) => a - b).forEach(st => {
                (D.styles[st].sl || []).forEach((row, sl) => row.forEach((pid, col) => {
                    const r = D.runes[pid];
                    if (!r) return;
                    list.push({
                        id: String(pid), name: r.n, icon: codexPerkIcon(r.i),
                        // 핵심 룬은 목록에서도 한눈에 갈리게 딱지를 붙인다 (아이콘 금테는 CSS)
                        sub: sl === 0 ? `${D.styles[st].n} · <span class="codex-key-tag">핵심 룬</span>` : D.styles[st].n,
                        raw: r, keystone: sl === 0, sort: [Number(st), sl * 10 + col]
                    });
                }));
            });
            // 스탯 파편도 같은 목록에 붙인다 (룬 페이지의 일부다).
            // ★★ **격자 칸마다 한 항목이다** (2026-09-01, 사용자 요청). 5008(적응형)은 1·2줄,
            //   5001(체력 증가)은 2·3줄에 걸쳐 있는데, 예전엔 목록에 한 번만 넣고 상세에서 두 줄을
            //   한꺼번에 보여줬다 — **한 칸을 눌러도 다른 칸 값이 같이 나와** 고를 수가 없었다.
            //   지금은 id 가 `5008:0` 꼴이고 채택률 카드도 그 줄 하나뿐이다.
            //   ★ 원래 id 는 `rid` 에 남긴다 — 아이콘·룬 그래프(rune_graphs)가 그 키로 찾는다.
            //   ★ 파편 칸이 9개라 계열 버튼의 '파편' 개수도 7 → 9 가 된다 (칸 수라 맞는 값이다).
            D.shardRows.forEach((row, ri) => row.forEach((pid, ci) => {
                const sh = D.shards[pid];
                if (!sh) return;
                list.push({
                    id: `${pid}:${ri}`, rid: String(pid), srow: ri,
                    name: sh.n, icon: codexPerkIcon(sh.i), sub: `스탯 파편 · ${ri + 1}번째 줄`,
                    raw: sh, shard: true, sort: [99999, ri * 10 + ci]
                });
            }));
            return list;
        }
        // ★ 주문은 부제를 안 붙인다. 9개뿐이라 목록에서 고를 때 쿨타임이 필요 없고,
        //   오른쪽 상세에 뱃지로 이미 크게 나온다.
        return Object.keys(D.spells).map(id => {
            const s = D.spells[id];
            return { id, name: s.n, icon: codexSpellIcon(s.i), sub: '', raw: s, sort: [Number(id), 0] };
        });
    }

    // ★ 검색은 챔피언·랭킹과 같은 헬퍼를 쓴다 (초성 · 영타). 표를 두 벌 두면 어긋난다.
    //   아이템은 여기에 **라이엇이 넣어 둔 별명(colloq)** 까지 더한다 — "인피"·"똥신" 같은 것들.
    // ★★ 공백을 지운 판을 **같이** 담는다 (2026-08-25). 안 그러면 초성 검색이 통째로 죽는다 —
    //   `getChosung('무한의 대검')` 이 `ㅁㅎㅇ ㄷㄱ` 라 공백까지 쳐야 걸렸다.
    //   도감 항목은 **아이템 184/215 · 룬 46/62 · 파편 6/7 이 이름에 공백이 있다.**
    //   챔피언 검색(`champSearchKey`)은 원래 `name.replace(/\s+/g,'')` 로 지우고 있었고
    //   **도감만 그 규칙에서 빠져 있었다.**
    //   ★ 원본도 남긴다 — `무한의 대검` 처럼 공백째로 치는 사람이 있다. 지운 판만 두면 그게 죽는다.
    function matches(e, cands) {
        if (!cands.length) return true;
        const flat = e.name.replace(/\s+/g, '');
        const hay = (e.name + '|' + getChosung(e.name)
            + '|' + flat + '|' + getChosung(flat)
            + '|' + (e.raw.c || '')).toLowerCase();
        return cands.some(c => hay.includes(c));
    }

    // 룬 계열 버튼. 계열 id 순이 곧 인게임 순서다 (정밀 8000 · 지배 8100 · 마법 8200 ·
    // 영감 8300 · 결의 8400). 스탯 파편은 계열이 없어서 맨 뒤에 따로 붙인다.
    function runeStyleCats() {
        return [
            { key: 'all', name: '전체' },
            ...Object.keys(D.styles).sort((a, b) => a - b).map(id => ({ key: id, name: D.styles[id].n })),
            { key: 'shard', name: '파편' }
        ];
    }

    // 줄 하나를 그린다. group 이 다르면 서로 독립이고 **AND 로 겹쳐서 걸린다.**
    function catRowHtml(label, list, cur, group, extra) {
        return `
        <div class="codex-cat-row">
            <span class="codex-cat-label">${label}</span>
            <div class="codex-cat-btns">
                ${list.map(c => `<button class="codex-cat${c.key === cur ? ' active' : ''}" data-group="${group}" data-key="${c.key}">${c.name}</button>`).join('')}
            </div>
            ${extra || ''}
        </div>`;
    }

    // 룬 탭만 갖는 보기 토글. 기본은 트리(인게임 자리)다.
    // ★ 검색 중에는 트리로 못 그린다 — 걸러낸 결과를 자리에 앉힐 방법이 없어서 목록으로 되돌린다.
    function runeViewToggleHtml() {
        return `
        <div class="codex-view-toggle" data-tooltip="검색 중에는 목록으로 보여줍니다">
            ${[['tree', '트리'], ['list', '목록']].map(([k, n]) =>
            `<button class="codex-view-btn${runeView === k ? ' active' : ''}" data-view="${k}">${n}</button>`).join('')}
        </div>`;
    }

    function renderCats() {
        const el = document.getElementById('codex-cats');
        let html = '';
        if (curTab === 'item') {
            html = catRowHtml('등급', CODEX_DEPTH_CATS, curDepth, 'depth')
                + catRowHtml('유형', CODEX_ROLES, curRole, 'role');
        } else if (curTab === 'rune') {
            html = catRowHtml('계열', runeStyleCats(), curStyle, 'style', runeViewToggleHtml());
        }
        el.innerHTML = html;                       // 주문 탭은 거를 게 없어서 빈 줄이다
        el.style.display = html ? 'block' : 'none';

        el.querySelectorAll('.codex-cat').forEach(b => b.addEventListener('click', () => {
            const g = b.dataset.group, k = b.dataset.key;
            if (g === 'depth') curDepth = k;
            else if (g === 'role') curRole = k;
            else curStyle = k;
            renderCats(); renderList();
        }));

        el.querySelectorAll('.codex-view-btn').forEach(b => b.addEventListener('click', () => {
            runeView = b.dataset.view;
            renderCats(); renderList();
        }));

        renderStatBar();
    }

    // ★ 인게임 상점 왼쪽의 스탯 목록. **아이템 탭에서만** 나온다.
    //   ★ 개수를 같이 적는다 — 0 개인 칸을 눌러 빈 목록을 보게 되는 걸 막는다.
    //     개수는 **등급·유형 필터가 걸린 뒤 기준**이라 필터를 바꾸면 같이 바뀐다.
    function renderStatBar() {
        const el = document.getElementById('codex-statbar');
        if (!el) return;
        // ★ 탭을 몸통과 **통에도** 적어 둔다 — CSS 가 룬·주문 탭의 칸 폭을 줄이는 데 쓴다.
        //   ★★ 통(`#codex-container`)에도 붙이는 이유: 상세만 줄이면 남는 폭이 오른쪽에
        //     그대로 남아 **화면 전체가 왼쪽으로 치우친다.** 통의 max-width 를 같이 줄이면
        //     `margin: auto` 가 살아나서 검색창·탭 줄까지 한꺼번에 가운데로 모인다.
        //   여기가 탭을 보는 유일한 자리다.
        el.closest('.codex-body')?.setAttribute('data-tab', curTab);
        document.getElementById('codex-container')?.setAttribute('data-tab', curTab);
        if (curTab !== 'item') { el.style.display = 'none'; el.innerHTML = ''; return; }
        el.style.display = '';

        // 스탯을 뺀 나머지 조건만 걸어 둔 모집단에서 센다
        const dep = CODEX_DEPTH_CATS.find(c => c.key === curDepth) || CODEX_DEPTH_CATS[0];
        const roleBit = (CODEX_ROLES.find(r => r.key === curRole) || {}).bit || 0;
        const pool = Object.values(D.items).filter(it => dep.test(it) && (!roleBit || (it.ra & roleBit)));
        const countOf = (tags) => pool.filter(it => tags.some(t => it.g2.includes(t))).length;

        const rows = [{ key: 'all', name: '전체', n: pool.length }]
            .concat(CODEX_STATS.map(s => ({ key: s.key, name: s.name, n: countOf(s.tags) })));

        el.innerHTML = `
            <div class="codex-statbar-label">스탯</div>
            ${rows.map(r => `
                <button class="codex-stat${r.key === curStat ? ' active' : ''}${r.n ? '' : ' is-empty'}" data-stat="${r.key}">
                    <span class="codex-stat-name">${r.name}</span><span class="codex-stat-n">${r.n}</span>
                </button>`).join('')}`;

        el.querySelectorAll('.codex-stat').forEach(b => b.addEventListener('click', () => {
            // ★ 누른 칸을 다시 누르면 풀린다 — 세로 목록이라 '전체' 로 되돌아가기가 번거롭다
            curStat = (curStat === b.dataset.stat) ? 'all' : b.dataset.stat;
            renderStatBar(); renderList();
        }));
    }

    function visible() {
        const cands = query.trim() ? koCandidates(query.trim().toLowerCase()) : [];
        const dep = CODEX_DEPTH_CATS.find(c => c.key === curDepth) || CODEX_DEPTH_CATS[0];
        // ★ 역할군은 bin 비트, 스탯은 DD 태그다. 셋(등급·유형·스탯)을 AND 로 건다.
        const roleBit = (CODEX_ROLES.find(r => r.key === curRole) || {}).bit || 0;
        const statTags = (CODEX_STATS.find(s => s.key === curStat) || {}).tags || null;
        return entries()
            .filter(e => curTab !== 'item' || (
                dep.test(e.raw)
                && (!roleBit || (e.raw.ra & roleBit))
                && (!statTags || statTags.some(t => e.raw.g2.includes(t)))
            ))
            // 룬은 계열 하나. 'shard' 는 스탯 파편만 (계열이 없는 항목이다)
            .filter(e => curTab !== 'rune' || curStyle === 'all'
                || (curStyle === 'shard' ? !!e.shard : (!e.shard && String(e.raw.st) === curStyle)))
            .filter(e => matches(e, cands))
            .sort((a, b) => (a.sort[0] - b.sort[0]) || (a.sort[1] - b.sort[1]) || a.name.localeCompare(b.name, 'ko'));
    }

    // ── 룬 트리. 인게임 룬 페이지와 **같은 자리**에 놓는다.
    //   ★ 자리 정보는 codex_data 의 `styles[].sl`(줄별 id 배열)과 `shardRows`(3x3) 다.
    //     둘 다 CD perkstyles.json 의 슬롯 배열 그대로라 순서를 손대지 않는다.
    //   ★ 파편은 같은 id 가 두 칸에 나온다 (적응형 1·2줄 / 체력 증가 2·3줄) — 인게임 그대로다.
    function runeTreeHtml() {
        const styleIds = Object.keys(D.styles).sort((a, b) => a - b);
        const want = (curStyle === 'all') ? styleIds : (curStyle === 'shard' ? [] : [curStyle]);
        let html = want.map(st => {
            const S = D.styles[st];
            if (!S) return '';
            return `
            <div class="codex-rune-tree">
                <div class="codex-rune-head">
                    <img class="codex-rune-head-icon" src="${codexPerkIcon(S.i)}" alt="">
                    <span>${S.n}</span>
                </div>
                ${(S.sl || []).map((row, i) => `
                <div class="codex-rune-row${i === 0 ? ' is-key' : ''}">
                    ${row.map(pid => runeNodeHtml(String(pid), D.runes[pid], i === 0)).join('')}
                </div>`).join('')}
            </div>`;
        }).join('');

        // 파편은 계열이 없어서 맨 뒤에 붙인다 ('파편' 버튼을 누르면 이것만 나온다)
        if (curStyle === 'all' || curStyle === 'shard') {
            html += `
            <div class="codex-rune-tree">
                <div class="codex-rune-head"><span>스탯 파편</span></div>
                ${D.shardRows.map((row, ri) => `
                <div class="codex-rune-row">
                    ${row.map(pid => runeNodeHtml(`${pid}:${ri}`, D.shards[pid], false)).join('')}
                </div>`).join('')}
            </div>`;
        }
        return html;
    }

    // ★ 파편도 칸마다 id 가 달라서(`5008:0`) 켜는 규칙이 룬과 같아졌다 (2026-09-01).
    //   예전엔 id 가 같은 칸이 둘이라 `activeShardCell()` 로 어느 칸을 켤지 따로 정해야 했다.
    function runeNodeHtml(id, r, key) {
        if (!r) return '';
        const on = id === selected;
        return `
        <div class="codex-rune-node${on ? ' active' : ''}${key ? ' is-key' : ''}" data-id="${id}">
            <img class="codex-rune-icon" src="${codexPerkIcon(r.i)}" alt="" loading="lazy">
            <span class="codex-rune-label">${r.n}</span>
        </div>`;
    }

    // keepScroll — 목록 내용이 바뀌지 않는 경우(고른 항목만 달라질 때)만 true.
    //   ★ 탭·검색·분류를 바꿀 땐 맨 위로 되돌려야 한다. 같은 <div> 를 재사용하므로
    //     scrollTop 이 그대로 남아서, 룬 탭으로 옮기면 **아이템 탭에서 보던 위치**가
    //     유지되고 고른 항목(맨 위)이 화면 밖에 있게 된다.
    function renderList(keepScroll) {
        const list = visible();

        const el = document.getElementById('codex-list');
        const keep = keepScroll ? el.scrollTop : 0;
        // ★ 트리는 룬 탭 · 트리 보기 · **검색어가 없을 때**만이다 (걸러낸 결과는 자리에 못 앉힌다)
        const treeOn = curTab === 'rune' && runeView === 'tree' && !query.trim();
        el.classList.toggle('is-tree', treeOn);
        if (!list.length) {
            el.innerHTML = `<div class="codex-none">결과가 없습니다.</div>`;
            return;
        }
        // 고른 게 목록에서 사라졌으면 첫 항목으로 옮긴다 (상세가 빈 채로 남지 않게)
        if (!selected || !list.some(e => e.id === selected)) selected = list[0].id;

        if (treeOn) {
            el.innerHTML = runeTreeHtml();
            el.scrollTop = keep;
            renderDetail();
            return;
        }

        el.innerHTML = list.map(e => `
            <div class="codex-item${e.id === selected ? ' active' : ''}${e.keystone ? ' is-keystone' : ''}" data-id="${e.id}">
                <img class="codex-item-img${curTab === 'rune' ? ' codex-item-img-round' : ''}" src="${e.icon}" alt="" loading="lazy">
                <div class="codex-item-body">
                    <div class="codex-item-name">${e.name}</div>
                    ${e.sub ? `<div class="codex-item-sub">${e.sub}</div>` : ''}
                </div>
            </div>`).join('');

        // ★ 이름을 onclick 문자열에 박지 않는다 — 아포스트로피 든 이름에서 깨진다
        //   (랭킹 표에서 겪은 것과 같다). data-id + 위임으로 처리한다.
        el.scrollTop = keep;
        renderDetail();
    }

    document.getElementById('codex-list').addEventListener('click', (ev) => {
        // 목록 줄과 트리 노드가 같은 위임을 탄다 (트리도 같은 <div> 안에 그려진다)
        const row = ev.target.closest('.codex-item, .codex-rune-node');
        if (!row) return;
        selected = row.dataset.id;
        codexLastPick[curTab] = selected;
        document.querySelectorAll('.codex-item, .codex-rune-node').forEach(r =>
            r.classList.toggle('active', r.dataset.id === selected));
        renderDetail();
    });

    // ── 오른쪽 상세
    let lastDetailId = null;
    function renderDetail() {
        const el = document.getElementById('codex-detail');
        const e = visible().find(x => x.id === selected);
        if (!e) { el.innerHTML = ''; return; }
        // ★ 그 탭에 들어왔을 때만 채택률을 받는다 (탭마다 한 번씩 — 안쪽 가드).
        //   받고 나면 지금 보고 있는 상세를 다시 그려 칸이 채워진다.
        //   ★ 탭 키(item/rune/spell)가 곧 채택률 종류다. 받는 사이에 탭을 옮겼으면 안 그린다.
        const usageTab = curTab;
        ensureUsage(usageTab, () => { if (curTab === usageTab) renderDetail(); });
        el.innerHTML = curTab === 'item' ? itemDetailHtml(e)
            : curTab === 'rune' ? runeDetailHtml(e)
                : spellDetailHtml(e);

        // ★★ 고른 항목이 **바뀔 때만** 상세 스크롤을 맨 위로 되돌린다 (2026-09-01, 사용자 요청).
        //   같은 <div> 를 재사용해서 scrollTop 이 남는다 — 긴 아이템을 내려 보고 다음 것을 고르면
        //   중간부터 보였다 (목록 쪽 renderList 의 keepScroll 과 같은 함정).
        //   ★ 무조건 0 으로 두면 안 된다 — 채택률이 도착해 **다시 그릴 때 스크롤이 튄다.**
        if (lastDetailId !== selected) { el.scrollTop = 0; lastDetailId = selected; }

        // 조합식 아이콘을 누르면 그 아이템으로 옮겨간다 (트리 노드도 같은 동작)
        el.querySelectorAll('.codex-recipe-item, .codex-tree-node[data-id]').forEach(b => b.addEventListener('click', () => {
            const id = b.dataset.id;
            if (!D.items[id]) return;
            // 등급·분류·검색 때문에 목록에 없을 수 있으니 전부 풀어 준다
            curRole = 'all';
            curStat = 'all';
            curDepth = 'all';
            query = '';
            document.getElementById('codex-search').value = '';
            selected = id;
            codexLastPick.item = id;
            renderCats(); renderList();
            // ★★ 목록이 통째로 새로 그려졌으니 고른 자리로 데려간다 — **목록 상자 안에서만** 움직인다.
            //   예전엔 `scrollIntoView({block:'center'})` 였는데, 그건 **스크롤되는 조상을 전부**
            //   움직여서 페이지까지 같이 튀었다 (2026-09-08 실측: window.scrollY 300 → 133).
            //   조합식을 눌렀을 때 보던 자리가 흔들리던 게 이것이다.
            //   ★ rect 차이로 재는 이유: offsetTop 은 offsetParent 기준이라 상자에 position 이
            //     없으면 엉뚱한 값이 나온다. 두 rect 의 차이는 그런 전제가 필요 없다.
            const lst = document.getElementById('codex-list');
            const cur = lst.querySelector('.codex-item.active');
            if (cur) {
                lst.scrollTop += cur.getBoundingClientRect().top - lst.getBoundingClientRect().top
                    - (lst.clientHeight - cur.offsetHeight) / 2;
            }
        }));
    }

    function recipeRow(label, ids) {
        if (!ids.length) return '';
        return `
        <div class="codex-recipe">
            <span class="codex-recipe-label">${label}</span>
            <div class="codex-recipe-list">
                ${ids.map(id => `
                    <div class="codex-recipe-item" data-id="${id}" title="${D.items[id]?.n || ''}">
                        <img src="${codexItemIcon(id)}" alt="">
                        <span>${D.items[id]?.n || ''}</span>
                    </div>`).join('')}
            </div>
        </div>`;
    }

    // 조합식 트리 — f(DD from)를 재귀로 따라간다. 재료 215개가 표 안에서 하나도 안 빠지는
    // 것을 빌드 때 확인해 뒀으므로(brokenFrom 0) 추가 데이터 없이 끝까지 그려진다.
    // 뿌리(지금 보는 아이템)는 data-id 를 안 붙여 클릭 대상에서 뺀다 — 눌러 봐야 제자리다.
    function recipeTreeNode(id, depth) {
        const it = D.items[id];
        if (!it) return '';
        const kids = depth < 6 ? it.f : [];
        return `
            <li>
                <div class="codex-tree-node${depth ? '' : ' is-root'}"${depth ? ` data-id="${id}"` : ''} title="${it.n}">
                    <img src="${codexItemIcon(id)}" alt="" loading="lazy">
                    <span class="codex-tree-gold">${it.g.toLocaleString()}</span>
                </div>
                ${kids.length ? `<ul>${kids.map(f => recipeTreeNode(f, depth + 1)).join('')}</ul>` : ''}
            </li>`;
    }

    function recipeTreeRow(rootId) {
        // ★ 조합식만 라벨을 **위에** 둔다 (2026-09-08) — 왼쪽에 두면 라벨 몫 86px 때문에
        //   나무가 눌려서 여섯 칸짜리(삼위일체·굶주린 히드라 등 4종)가 오른쪽으로 잘렸다.
        return `
        <div class="codex-recipe codex-recipe-tree">
            <span class="codex-recipe-label">조합식</span>
            <div class="codex-tree"><ul>${recipeTreeNode(rootId, 0)}</ul></div>
        </div>`;
    }

    // ★★ 아이템 본문의 **줄 간격만** 손본다 (2026-09-08 사용자 요청). 글자·태그·색은 원문 그대로다.
    //   DD 원문은 이렇게 생겼다:
    //     <stats>…</stats><br><br><passive>서리</passive><br>스킬로 적에게…
    //   ① `<stats>` 는 이미 **블록**(아래 여백 12px)이라 그 뒤의 `<br>` 둘은 **빈 줄 두 개**가 된다.
    //      스탯 상자와 첫 효과 사이가 60px 가까이 벌어지던 원인이다. 존야는 `<br>` 이 **넷**이다.
    //   ② 끝의 `<br>` 도 같은 이유로 상자 아래에 빈 줄을 남긴다 (장화처럼 효과가 없는 아이템).
    //   ★ 문단 사이(`효과1<br><br>효과2`)의 `<br>` 은 **안 건드린다** — 그건 진짜 문단 나눔이다.
    //     라벨 앞이라고 무조건 지우면 효과 두 개가 한 덩어리로 붙는다.
    //   ★ 라벨(`<passive>` 등)을 인라인으로 되돌리는 건 CSS 쪽이다 (style.css 의 `.codex-desc passive`).
    //     블록으로 두면 **라벨 뒤 `<br>` 과 겹쳐 줄이 두 번 바뀌고**, 문장 한가운데 쓰인 라벨
    //     (암흑의 인장의 「영광」 5자리)은 문장을 세 토막으로 끊는다.
    const itemDescHtml = (d) => (d || '').trim()
        ? d.replace(/<\/stats>(?:\s*<br\s*\/?>)+/gi, '</stats>')
            .replace(/(?:\s*<br\s*\/?>)+\s*(?=<\/mainText>|$)/gi, '')
        : '<span class="codex-dim">설명이 없습니다.</span>';

    function itemDetailHtml(e) {
        const it = e.raw;
        // 재료값 합계 대비 조합 비용 — "얼마를 더 내는가" 가 궁금한 자리다
        const partsCost = it.f.reduce((a, id) => a + (D.items[id]?.g || 0), 0);
        const combine = it.g - partsCost;
        return `
        <div class="codex-detail-head">
            <img class="codex-detail-img" src="${codexItemIcon(e.id)}" alt="">
            <div>
                <div class="codex-detail-name">${it.n}</div>
                <div class="codex-detail-meta">
                    <span class="codex-gold">${it.g.toLocaleString()} G</span>
                    ${it.f.length ? `<span class="codex-dim">(조합비 ${combine.toLocaleString()})</span>` : ''}
                    <span class="codex-dim">판매 ${it.s.toLocaleString()}</span>
                    <span class="codex-badge">${epInfo(it.ep).name}</span>
                    ${it.rc ? `<span class="codex-badge">${it.rc} 전용</span>` : ''}
                </div>
                ${it.p ? `<div class="codex-plain">${it.p}</div>` : ''}
            </div>
        </div>
        <!-- ★★ dt 는 **수치가 든 인게임 문장**이다 (2026-09-08). DD 의 d 는 계산식으로 정해지는
             값을 0 으로 찍거나 통째로 빼서 "0의 추가 마법 피해" 가 나왔다.
             빌드가 다 못 채운 아이템은 dt 가 없고 그때만 d 로 물러난다 (주문의 dt 와 같은 규약).
             ★ 이 주석은 템플릿 문자열 안이다 — 백틱을 쓰면 문자열이 거기서 끊긴다 (또 걸렸다) -->
        <div class="codex-desc">${itemDescHtml(it.dt || it.d)}</div>
        ${it.f.length ? recipeTreeRow(e.id) : ''}
        ${recipeRow('재료', it.f)}
        ${recipeRow('상위 아이템', it.t)}
        ${usageCardHtml('item', String(e.id), { note: ITEM_USAGE_NOTE })}`;
    }

    function runeDetailHtml(e) {
        const r = e.raw;
        const styleName = e.shard ? '스탯 파편' : (D.styles[r.st]?.n || '');
        // ★ 파편은 두 줄에 걸친 것이 있다 (적응형 1·2줄 / 체력 증가 2·3줄) — 있는 줄을 다 적는다
        // ★ 파편은 격자 칸 하나가 곧 한 항목이다 (2026-09-01) — 걸쳐 있는 줄을 다 적던 것을
        //   자기 줄 하나로 바꿨다. `srow` 는 0부터라 화면에는 +1 해서 적는다.
        const slotName = e.shard ? `${e.srow + 1}번째 줄`
            : (r.sl === 0 ? '핵심 룬' : `${r.sl}번째 줄`);
        return `
        <div class="codex-detail-head">
            <img class="codex-detail-img codex-detail-img-round" src="${codexPerkIcon(r.i)}" alt="">
            <div>
                <div class="codex-detail-name">${r.n}</div>
                <div class="codex-detail-meta">
                    ${!e.shard && D.styles[r.st] ? `<img class="codex-style-icon" src="${codexPerkIcon(D.styles[r.st].i)}" alt="">` : ''}
                    <span>${styleName}</span>
                    <span class="codex-badge">${slotName}</span>
                </div>
                ${r.s ? `<div class="codex-plain is-plain">${r.s}</div>` : ''}
            </div>
        </div>
        <div class="codex-desc is-plain">${r.d ? withRuneGraphs(e.rid || e.id, r.d) : '<span class="codex-dim">설명이 없습니다.</span>'}</div>
        ${usageCardHtml('rune', String(e.id), e.shard ? { label: `${e.srow + 1}번째 줄 채택률` } : {})}`;
    }

    // ★★ 사거리 20000 이상은 **"표시할 값 없음" 더미**다 — 스킬 탭이 쓰는 그 규칙과 같다.
    //   `audit_skill_meta.js` 가 "협곡이 약 15000 유닛이라 그보다 크면 맵 전체" 로 경계를 잡는다.
    //   순간이동이 DD·bin 둘 다 25000 이라 **기계 대조로는 불일치 0** 이 나오는 자리다
    //   (docs/스킬데이터.md 의 그 함정). 실제로는 맵 어디든 아군 구조물·와드로 간다.
    const spellRangeText = (r) => Number(r) >= 20000 ? '전역' : (r === '0' ? '자신' : r);

    function spellDetailHtml(e) {
        const s = e.raw;
        // ★ `no` = 주요 모드 중 **못 쓰는 곳** (build_codex_data.js 의 MAIN_MODES).
        //   지금은 강타(칼바람)·순간이동(칼바람·U.R.F.·돌격! 넥서스) 둘뿐이고
        //   나머지 일곱은 필드 자체가 없어 아무것도 안 뜬다 — 다 쓸 수 있다는 뜻이다.
        //   ★ 아레나는 협곡 주문 9개가 전부 못 써서(별도 주문 체계) 목록에서 뺐다.
        return `
        <div class="codex-detail-head">
            <img class="codex-detail-img" src="${codexSpellIcon(s.i)}" alt="">
            <div>
                <div class="codex-detail-name">${s.n}</div>
                <div class="codex-detail-meta">
                    <span class="codex-badge">재사용 ${s.cd}초</span>
                    <span class="codex-badge">사거리 ${spellRangeText(s.r)}</span>
                    <span class="codex-dim">소환사 레벨 ${s.lv} 해금</span>
                </div>
                ${s.no ? `<div class="codex-plain">${s.no.join(' · ')}에서는 쓸 수 없습니다</div>` : ''}
            </div>
        </div>
        <div class="codex-desc">${withGraphNotes(s.g || [], s.dt || s.d)}</div>
        ${(s.up || []).map(u => `
            <div class="codex-upgrade">
                <div class="codex-upgrade-head">
                    <span class="codex-upgrade-name">${u.n}</span>
                    ${u.w ? `<span class="codex-dim">${u.w}</span>` : ''}
                </div>
                <div class="codex-desc">${withGraphNotes(u.g || [], u.d)}</div>
            </div>`).join('')}
        ${usageCardHtml('spell', String(e.id))}`;
    }

    // ★★ 아이템만 채택률의 뜻이 다르다 (2026-09-01) — 집계가 세는 건 **경기가 끝났을 때 6칸에
    //   남아 있던** 아이템이라 "산 비율" 이 아니다. 그래서 롱소드 같은 기본 재료도 12% 가 나온다
    //   (미완성으로 끝난 판). 안 적으면 오류처럼 보이는 자리라 헤더 아래 한 줄로 밝힌다.
    const ITEM_USAGE_NOTE = '경기가 끝났을 때 아이템 창에 남아 있던 비율 · 기본 재료도 값이 있다';

    // ★★ 승률만 표본 가드를 건다 (2026-09-01). 채택률은 분모가 전체 픽이라 표본이 몇 판이든
    //   뜻이 있지만, 승률은 3판짜리에서 33% 같은 값이 나온다 — 칼리스타의 칠흑의 창(16.17 에
    //   4판)처럼 거의 안 쓰이는 아이템이 도감 목록 맨 위에 있어서 실제로 걸리는 자리다.
    //   값은 패치 영향 페이지의 `PI_MIN_GAMES` 와 같은 100 이다 (같은 정신이라 맞춰 둔다).
    const USAGE_WR_MIN = 100;

    // ★ 채택률 칸. 데이터가 아직 없거나 실패했으면 **아무것도 안 그린다** (칸이 통째로 없다).
    //   ★★ 세 탭이 같은 함수를 쓴다 (2026-09-01). 다른 건 셋뿐이다 —
    //     `label`(파편은 줄마다 카드가 하나라 "1번째 줄 채택률") · `note`(아이템의 뜻 한 줄) ·
    //     키(파편만 `id:줄`).
    function usageCardHtml(kind, key, opt = {}) {
        const U = usageData[kind];
        const u = U && U.map[key];
        if (!u || !u.games) return '';
        const pct = (u.games / U.picks * 100).toFixed(1);
        const wr = u.games >= USAGE_WR_MIN ? (u.wins / u.games * 100).toFixed(1) : null;
        const champs = (u.champs || []).map(x => {
            const eng = championIdMap[x.c];
            if (!eng) return '';                       // 신챔 등 아직 표에 없는 경우
            const kor = (window.korChampMap || {})[eng] || eng;
            return `
                <div class="codex-usage-champ" title="${kor} ${Math.round(x.r * 100)}%">
                    <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${eng}.png" alt="" loading="lazy">
                    <span class="codex-usage-name">${kor}</span>
                    <span class="codex-usage-rate">${Math.round(x.r * 100)}%</span>
                </div>`;
        }).join('');

        return `
        <div class="codex-usage">
            <!-- ★ 채택률·승률은 **같은 꼴**이다 (2026-09-08 사용자 요청) — 이름은 12px 흐림,
                 값은 13px 밝음. 예전엔 승률만 .codex-dim 한 덩어리라 **크기를 안 정해서
                 상속값 16px** 로 혼자 커 보였다. 이름·값을 짝(.codex-usage-pair)으로 묶어야
                 머리줄 gap 이 「채택률 7.8%」 안쪽까지 벌리지 않는다
                 ★★ 이 주석은 템플릿 문자열 안이다 — 백틱을 쓰면 문자열이 거기서 끊긴다 -->
            <div class="codex-usage-head">
                <span class="codex-usage-pair">
                    <span class="codex-usage-label">${opt.label || '채택률'}</span>
                    <span class="codex-usage-big">${pct}%</span>
                </span>
                <span class="codex-usage-pair">
                    <span class="codex-usage-label">승률</span>
                    ${wr ? `<span class="codex-usage-big">${wr}%</span>`
                         : `<span class="codex-usage-na">표본 부족</span>`}
                </span>
                <span class="codex-usage-scope">마스터+ · ${patchDisplay(U.scope.replace('p:', ''))} 패치</span>
            </div>
            ${opt.note ? `<div class="codex-usage-note">${opt.note}</div>` : ''}
            <!-- ★ 라인별이 먼저, 챔피언 TOP5 가 뒤다 (2026-09-08 사용자 요청) -->
            ${laneHtml(u)}
            ${champs ? `
                <div class="codex-usage-sub">채택률 TOP5</div>
                <div class="codex-usage-champs">${champs}</div>` : ''}
        </div>`;
    }

    // ★ 라인별 채택률. 분모가 **그 라인의 픽 합계**라 "탑에서 순간이동 46%" 로 읽힌다
    //   (전체 픽으로 나누면 라인 하나가 5분의 1이라 값이 찌그러진다 — 서버 주석 참고).
    //   ★ 0% 라인도 남긴다 — "강타는 정글만 100%, 나머지 0%" 가 곧 정보다.
    //   ★ 라인 아이콘은 통계 탭과 같은 표(STAT_LANE_ICON)를 쓴다. 두 벌 두면 어긋난다.
    function laneHtml(u) {
        if (!u.pos || !Object.keys(u.pos).length) return '';
        const rows = STAT_POS.map(p => {
            const r = u.pos[p.code];
            if (r == null) return '';
            const pct = Math.round(r * 100);
            return `
                <div class="codex-lane-row">
                    <img class="codex-lane-icon" src="${STAT_LANE_ICON[p.key]}" alt="" title="${p.name}">
                    <span class="codex-lane-name">${p.name}</span>
                    <span class="codex-lane-bar"><i style="width:${pct}%"></i></span>
                    <span class="codex-lane-pct${pct ? '' : ' is-zero'}">${pct}%</span>
                </div>`;
        }).join('');
        if (!rows.trim()) return '';
        return `
            <div class="codex-usage-sub">라인별 채택률</div>
            <div class="codex-lanes">${rows}</div>`;
    }

    // ── 컨트롤
    // ★ 탭 줄(4칸)은 위 goCodexTab 위임 리스너가 받는다 (2026-08-27). 챔피언 칸이 같은 줄에 있어
    //   페이지 자체가 바뀔 수 있으므로, 예전처럼 이 페이지 안에서만 갈아 끼우지 않는다

    document.getElementById('codex-search').addEventListener('input', (ev) => {
        query = ev.target.value;
        renderList();
    });

    renderCats();
    renderList();
}

// ============================================================
//  박제된 패치 (2026-08-16 신설)
//    은퇴한 패치의 집계는 DB 가 아니라 `public/stats_archive/<scope>.js` 에 있다.
//    DB 에 두면 인덱스까지 패치당 3.32MB 인데 파일은 345KB(brotli 25KB)라
//    1년 26패치면 Atlas 84MB 를 통째로 아낀다. 자세한 건 CLAUDE.md 참고.
//
//    ★ 서버는 `archived: true` 만 알려 준다 — "scope 목록에는 있는데 행이 없다" 가
//      그 표식이고, `statscopes` 행은 DB 에 남아 있어 드롭다운과 분모는 그대로 온다.
// ============================================================
window.statsArchive = window.statsArchive || {};
const statsArchivePromises = {};

function loadStatsArchive(scope, version) {
    if (window.statsArchive[scope]) return Promise.resolve(window.statsArchive[scope]);
    if (statsArchivePromises[scope]) return statsArchivePromises[scope];

    // p:16.16 -> /stats_archive/p_16.16.js  (콜론은 주소에 두기 나쁘다)
    // ?v= 는 마지막 집계 시각이다. 박제본은 안 바뀌지만 다시 만들었을 때를 위해 붙인다.
    const url = `/stats_archive/${scope.replace(/:/g, '_')}.js?v=${version || 0}`;
    statsArchivePromises[scope] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.async = false;
        s.src = url;
        s.onload = () => window.statsArchive[scope]
            ? resolve(window.statsArchive[scope])
            : reject(new Error('박제 파일에 ' + scope + ' 가 없습니다.'));
        s.onerror = () => reject(new Error('박제된 통계를 받지 못했습니다: ' + url));
        document.head.appendChild(s);
    });
    statsArchivePromises[scope].catch(() => { delete statsArchivePromises[scope]; });
    return statsArchivePromises[scope];
}

// ★ 배열로 눕힌 걸 되돌린다. 자리 뜻은 build_stats_archive.js 주석과 **반드시 같아야 한다**
//   — 순서를 바꾸면 양쪽을 같이 고칠 것.
const ARCHIVE_KB = ['5-7', '8-10'];
// ★ build_stats_archive.js 의 TYPE_LIST 와 **자리가 같아야 한다.** 새 type 은 맨 뒤에.
const ARCHIVE_TYPE = ['rune', 'keystone', 'spell', 'shard', 'all', 'item',
    'skillord', 'skillpri', 'start', 'core', 'item4', 'item5', 'item6', 'tlall',   // 타임라인 8종은 2026-08-26 에 맨 뒤에 붙였다
    'skillord6', 'skillord10', 'early', 'earlyset', 'boots', 'set2', 'set4', 'set5', 'item1', 'item2', 'item3', 'perk',   // 같은 날 밤 12종 더
    'skilllv', 'skillord11'];   // 레벨별 스킬 · 11레벨 순서 (2026-09-09)

function expandStatsArchive(a) {
    // champstats 행 — API 의 rows 와 **같은 모양**이라 renderStatsTable() 은 안 바뀐다
    const rows = a.r.map(x => ({
        kb: ARCHIVE_KB[x[0]], champ: x[1], pos: x[2],
        games: x[3], wins: x[4], bans: x[5], banGames: x[6],
        kills: x[7], deaths: x[8], assists: x[9]
    }));

    // champbuilds 행 — 챔피언별로 미리 갈라 둔다 (줄을 펼칠 때마다 1만 행을 훑지 않도록)
    const builds = {};
    a.b.forEach(x => {
        const champ = x[0];
        (builds[champ] || (builds[champ] = [])).push({
            pos: x[1], type: ARCHIVE_TYPE[x[2]], games: x[3], wins: x[4], key: x.slice(5)
        });
    });

    // 상성 행 — 2026-08-21에 더했다. 옛 박제 파일에는 없으므로 없으면 빈 표다.
    const matchups = {};
    (a.m || []).forEach(x => {
        const champ = x[1];
        // fpos·rel 은 2026-08-26 밤에 뒤에 붙었다 — 옛 파일(5칸)은 같은 라인 적으로 읽는다
        (matchups[champ] || (matchups[champ] = [])).push({ pos: x[0], foe: x[2], games: x[3], wins: x[4], fpos: x[5] == null ? x[0] : x[5], rel: x[6] || 0 });
    });
    return { rows, builds, matchups };
}

// 박제된 패치의 상성. API 응답과 **같은 모양**이라 renderMatchupPanel 은 안 바뀐다.
function archivedMatchupsFor(scope, champ) {
    const cache = window.statsArchiveExpanded?.[scope];
    const rows = cache?.matchups?.[champ] || [];
    // 옛 박제 파일(상성 없음)이면 "박제라 없다" 로 알려 준다 — 빈 표보다 낫다
    if (!cache?.matchups) return { archived: true, scope, champ, rows: [] };
    return { scope, champ, rows };
}

// 박제된 패치의 룬 빌드. API 를 안 부르고 이미 받아 둔 파일에서 꺼낸다.
function archivedBuildsFor(scope, champ) {
    const cache = window.statsArchiveExpanded?.[scope];
    const list = cache?.builds[champ] || [];
    // 분모도 라인별이다 (API 응답과 같은 모양이라 renderBuildPanel 은 안 바뀐다)
    const totals = {}, totalWins = {};
    list.filter(r => r.type === 'all').forEach(r => {
        const pos = r.pos == null ? -1 : r.pos;
        totals[pos] = r.games;
        totalWins[pos] = r.wins;
    });
    return {
        scope, champ,
        total: totals[-1] || 0,
        wins: totalWins[-1] || 0,
        totals, totalWins,
        rows: list.filter(r => r.type !== 'all')
    };
}

// ============================================================
//  룬 빌드 패널 (2026-08-16 신설)
//    통계 탭에서 챔피언 줄을 누르면 아래로 펼쳐진다.
//    서버의 /api/champion-builds 가 그 챔피언 것만 내려준다.
// ============================================================

// perk_data.js 지연 로드. 통계 탭을 열기만 한 사람에게는 안 받는다.
//   챔피언 데이터(loadChampionData)와 따로 두는 이유: 저건 gzip 142KB 라 챔피언 탭에서
//   한 번에 받는 게 맞지만, 이건 12KB 고 쓰이는 곳이 여기 하나뿐이다.
let perkDataPromise = null;
function loadPerkData() {
    if (perkDataPromise) return perkDataPromise;
    // ★ 묶음이 둘이다 — perk_data.js(룬)와 item_names.js(아이템 이름).
    //   이름 표를 못 받아도 패널은 떠야 하므로(아이콘만 나온다) 실패도 성공으로 친다.
    const tags = Array.from(document.querySelectorAll('script.lazy-perk-data[data-src]'));
    if (!tags.length) return Promise.reject(new Error('perk_data.js 태그가 없습니다.'));

    perkDataPromise = Promise.all(tags.map(tag => new Promise((done, fail) => {
        const s = document.createElement('script');
        s.async = false;
        s.src = tag.dataset.src;      // ?v=mtime 은 server.js 가 이미 붙여 놨다
        s.onload = done;
        s.onerror = () => (tag.dataset.src.includes('perk_data')
            ? fail(new Error('룬 데이터를 받지 못했습니다.'))
            : done());
        document.head.appendChild(s);
    })));
    perkDataPromise.catch(() => { perkDataPromise = null; });
    return perkDataPromise;
}

// 최종 아이템. 이름 표(item_names.js)를 못 받았으면 아이콘만 나오게 둔다.
const itemNameOf = id => (typeof itemNames !== 'undefined' && itemNames[id]) || '';
const itemIconOf = id => `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png`;

// 룬·계열은 한 표에서 같이 찾는다 (계열 id 도 그림이 있어야 해서다)
const perkName = id => (perkData.perks[id] || perkData.styles[id] || [''])[0] || '';
const perkIcon = id => {
    const e = perkData.perks[id] || perkData.styles[id];
    return e ? cdAssetUrl(e[1]) : '';      // 소문자 변환은 스킨 탭이 쓰던 그 함수가 한다
};
const spellName = id => (perkData.spells[id] || [''])[0] || '';
const spellIcon = id => {
    const e = perkData.spells[id];
    return e ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/spell/${e[1]}` : '';
};

// ★ 집계 키의 보조 룬 2개는 **id 순으로 정렬돼 있다** — 라이엇이 주는 순서가 일정하지
//   않아서 같은 룬 페이지가 두 조합으로 갈리기 때문이다 (server.js 의 buildOneBuildScope).
//   그런데 id 순서와 슬롯 순서는 다르므로(어긋나는 쌍 139개) 그리기 전에 되돌린다.
//   안 그러면 영감 룬이 "환급 → 삼중 물약" 처럼 인게임과 거꾸로 나온다.
function perksBySlot(styleId, ids) {
    const slots = perkData.slots[styleId] || [];
    const at = id => {
        const i = slots.findIndex(s => s.includes(id));
        return i < 0 ? 99 : i;
    };
    return [...ids].sort((a, b) => at(a) - at(b));
}

// 표본이 이 아래면 흐리게 둔다. 표의 STAT_MIN_GAMES 와 같은 뜻이지만 여기는
// 조합 하나의 판수라 훨씬 작을 수밖에 없어서 따로 잡는다.
const BUILD_MIN_GAMES = 5;

// laneNote — 라인 필터가 켜져 있을 때 넘어온다. 아래 "라인 무관" 안내에 쓴다.
// ★★ 두 번째 인자는 표에서 켜 둔 라인이다 ('all' 또는 '0'~'4').
//   2026-08-18부터 룬 집계가 라인별로 갈려서, 표의 라인 필터와 패널이 같은 것을 본다.
//   (예전에는 라인 무관 합산 하나뿐이라 "필터와 무관합니다" 라고 변명하고 있었다)
// ==========================================
//  라인 상성 패널 (2026-08-21 신설)
//    "같은 라인에서 마주친 상대" 별 승률이다. `/api/champion-matchups` 가 그 챔피언의
//    모든 라인 줄을 주고 여기서 **펼친 줄의 라인**만 골라 쓴다 (룬 패널과 같은 규칙).
//
//  ★ 서버는 5판 이상인 칸만 저장한다(`MATCHUP_MIN`). 그래도 5판짜리 승률은 잡음이라
//    화면은 **10판 이상만 순위에 올리고**, 그것도 없으면 있는 대로 보여주되 흐리게 둔다.
//    비워 두면 고장으로 보인다 — 룬 패널의 "전부 1판이면 한 줄은 남긴다" 와 같은 판단이다.
// ==========================================
const MATCHUP_SHOW_MIN = 10;
// ★ 서버 집계가 이 판수 미만인 조합을 아예 저장하지 않는다 (server.js MATCHUP_MIN)
const MATCHUP_MIN_HINT = 5;   // 순위에 올릴 최소 표본
const MATCHUP_SIDE_N = 5;      // 한쪽에 몇 명씩

// ══════════════════════════════════════════════════════════════════════
//  챔피언 통계 상세 페이지 — lolalytics 챔피언 빌드 페이지를 그대로 옮긴 판 (2026-08-26 밤, 사용자 요청)
//
//  ★★ 색·크기·순서는 그쪽 DOM 에서 읽은 값이다 (눈대중 아님): 탭 바 활성 rgb(58,126,147) / 비활성 rgb(33,71,83) ·
//    글자 12px · 라벨 회색 #bbb · 상자 테두리 #333 · 챔피언 아이콘 37px · 승률 초록/빨강 · 픽률 연보라.
//    자리 순서도 그쪽과 같다 (★ 탭 줄·빌드 상자는 2026-08-27 사용자 요청으로 뺐다): 헤더 → 추이 그래프 4개 → 상성(적 5줄 · 아군 4줄) →
//    소환사 주문 → 시작 아이템/세트 → 초반 아이템/세트 → 세트(2~5개) → 신발·1~5번째·인기·승률·전체 아이템 →
//    스킬 우선순위(레벨 탭) → 룬 표(전체 / 승률 최고 페이지 / 인기 페이지).
//  ★ 그쪽의 오른쪽 아래 상자들(Secure/Yield · 사분면 · Best on · Leaderboard)은 **넣지 않는다** (사용자 지시).
//  ★★ 16.16 처럼 타임라인(`tlall`)이 없는 패치는 아이템 로그·스킬 로그 칸을 **통째로 안 그린다** (사용자 지시).
//    빌드 상자엔 주문·룬만, 아래엔 상성·주문·최종 아이템·룬 표만 남는다.
//  ★ 화면 함수: showChampStatPage → lxHeader / lxTrend / lxMatchups / lxLowerRows / lxSkillBox / lxRuneBox
// ══════════════════════════════════════════════════════════════════════
const LX_ROW_MAX = 18;          // 한 줄에 그릴 카드 수 (그쪽은 12장 + 오른쪽 상자, 우리는 그 자리까지 카드)
const LX_WIN_MIN_SHARE = 0.1;   // "승률 최고" 를 고를 때 1위 판수의 이 비율 이상인 후보만 (1판짜리 100% 방지)

// 챔피언 스킬 아이콘 (P·Q·W·E·R) — DD champion json 한 번. 전적 카드의 `champDetailCache` 는 패시브가 없어 따로 둔다.
async function loadChampSpellIcons(eng) {
    window.csSpellIcons = window.csSpellIcons || {};
    if (window.csSpellIcons[eng]) return window.csSpellIcons[eng];
    try {
        const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion/${eng}.json`);
        const d = (await res.json()).data[eng];
        const base = `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/`;
        const out = { P: base + 'passive/' + d.passive.image.full };
        'QWER'.split('').forEach((k, i) => { if (d.spells[i]) out[k] = base + 'spell/' + d.spells[i].image.full; });
        window.csSpellIcons[eng] = out;
        return out;
    } catch (e) { return null; }
}

// 승률 색 — 그쪽은 50% 기준 초록/빨강. 표본 5판 미만은 회색
// ★ 순서 목록에 몇 줄까지 그릴지. 집계가 칸마다 상위 12개만 담으므로(BUILD_TOP_N) 이 위로 올려도 안 늘어난다
const LX_SEQ_MAX = 12;
const lxWr = (w, g) => (g < BUILD_MIN_GAMES ? 'lx-dim' : (w / g >= 0.5 ? 'lx-green' : 'lx-red'));
const lxPct = (a, b) => (b ? (a / b * 100) : 0).toFixed(2);
const lxSigned = v => (v >= 0 ? '+' : '') + v.toFixed(2);
const lxDeltaCls = v => (v >= 0 ? 'lx-green' : 'lx-red');

// 두 칸 탭 바 (그쪽의 "Highest Win Build | Most Common Build"). data-group 으로 묶고 data-val 로 고른다
function lxTabBar(group, tabs, active) {
    return `<div class="lx-tabbar" data-group="${group}">${tabs.map(t =>
        `<button class="lx-tabbtn${t.v === active ? ' active' : ''}" data-val="${t.v}">${t.label}</button>`).join('')}</div>`;
}

// ★ 카드 줄 — 왼쪽 라벨 칸(제목 + 지표 이름 세로) + 카드 나열. 그쪽 Counter/Summoner Spells/Items 줄 전부 이 모양이다.
//   라벨의 첫 칸 높이 = 카드 윗부분(아이콘) 높이 (`--lx-top`), 지표 줄은 16px 씩.
//   cards[i] = { icons: [url] | top: html, name?, dim?, title?, vals: [{ v, cls }] }
function lxRow(label, cards, opts = {}) {
    const topH = opts.topH || 41;
    const head = `
        <div class="lx-row-label">
            <div class="lx-row-head">${label.icon ? `<img src="${label.icon}" alt="">` : ''}<span>${label.title}</span></div>
            ${label.metrics.map(m => `<div class="lx-row-k ${m.cls || ''}">${m.t || m}</div>`).join('')}
        </div>`;
    // ★ `c.attr` 은 카드에 그대로 붙는 속성 문자열이다 (2026-09-02) — 상성 카드에 `data-foe` 를
    //   심어 vs 비교 페이지로 보내려고 열었다. 다른 호출부는 안 넘기므로 마크업이 안 바뀐다.
    const body = cards.length ? cards.map(c => `
        <div class="lx-card${c.dim ? ' is-dim' : ''}${c.cls ? ' ' + c.cls : ''}"${c.title ? ` title="${c.title}"` : ''}${c.attr || ''}>
            <div class="lx-card-top${opts.stack ? ' is-stack' : ''}">${c.top || (c.icons || []).map(u => `<img src="${u}" alt="" loading="lazy">`).join('')}</div>
            ${c.vals.map(v => `<div class="lx-v ${v.cls || ''}">${v.v}</div>`).join('')}
        </div>`).join('') : `<div class="lx-none">${opts.empty || '표본 없음'}</div>`;
    return `<div class="lx-row${opts.cls ? ' ' + opts.cls : ''}" style="--lx-top:${topH}px">${head}<div class="lx-cards">${body}</div></div>`;
}

// ============================================================
//  챔피언 vs 챔피언 비교 — /versus/<A>/<B>[/<pos>-<fpos>-<rel>] (2026-09-02, 로드맵 A-2)
//
//   ★★ **두 챔피언이 같은 판에 있었던 모든 관계**를 다룬다 (2026-09-02 확장, 사용자 요청
//     "맞라인 아니어도 누르면 비교되게"). `champmatchups` 가 한 판의 나머지 9명을 전부 담고 있어서
//     관계가 여럿이다 — 리신 vs 야스오는 6개다 (정글 vs 미드 189판 · 정글+미드 아군 104판 · …).
//     표본 최다 관계를 기본으로 열고 나머지는 칩으로 고른다. 주소 4번째 칸이 `pos-fpos-rel` 이다.
//
//   ★★ 빌드 비교는 `/api/versus-build` 가 **원본에서 그때그때 센 값**이다 (집계에 없는 자료 —
//     그쪽 주석 참고). 그걸 **그 챔피언의 평소 빌드(`/api/champion-builds`)와 나란히** 놓는다.
//     "에클립스 87.2%" 만으로는 뜻이 없고 "평소 82.1% → +5.1" 이라야 읽힌다.
//   ★ 표본 컷은 없다 (사용자 결정) — 5판짜리 관계도 그린다. 대신 표본을 크게 적고
//     `MATCHUP_SHOW_MIN` 미만이면 흐리게 해서 얇다는 걸 눈으로 알 수 있게 한다.
//   ★ 픽률 분모가 둘이다 — 스킬 두 칸(선마·순서)은 `tlall`, 나머지는 `all` 이다 (집계와 같은 규칙).

// ★ 한국어 조사 — 받침이 있으면 을/이, 없으면 를/가. 챔피언 이름이 둘 다라서(그레이브즈를 · 리 신을)
//   그냥 붙이면 어색하다. 마지막 글자의 종성만 보면 된다 (한글이 아니면 받침 있는 쪽으로).
function josa(w, withBatchim, without) {
    const s = String(w || "");
    const c = s.charCodeAt(s.length - 1);
    const ko = c >= 0xAC00 && c <= 0xD7A3;
    return s + (!ko || (c - 0xAC00) % 28 !== 0 ? withBatchim : without);
}

async function showVersusPage(engA, engB, relKey) {
    hideAllContainers();
    setActiveNav('nav-stats-live');
    const box = document.getElementById('stats-container');
    box.style.display = 'block';
    box.innerHTML = `<div class="lx-page">${skelLxHtml(false)}</div>`;

    await fetchChampionMap();
    const idOf = (name) => Number(Object.keys(championIdMap)
        .find(k => String(championIdMap[k]).toLowerCase() === String(name || '').toLowerCase()));
    const a = idOf(engA), b = idOf(engB);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        box.innerHTML = `<div class="stats-empty">알 수 없는 챔피언입니다. <a href="/stats" class="stat-back">← 통계로</a></div>`;
        return;
    }

    let data, mdata;
    try {
        const res = await fetch(`/api/champion-stats${window.statScope ? `?scope=${encodeURIComponent(window.statScope)}` : ''}`);
        data = await res.json();
        if (!data.ready) throw new Error('not ready');
        window.statScope = data.scope;
        mdata = data.archived
            ? archivedMatchupsFor(data.scope, a)
            : await fetch(`/api/champion-matchups?scope=${encodeURIComponent(data.scope)}&champ=${a}`).then(r => r.ok ? r.json() : null);
    } catch (e) {
        box.innerHTML = `<div class="stats-empty">통계를 불러오지 못했습니다. <a href="/stats" class="stat-back">← 통계로</a></div>`;
        return;
    }

    const engOf = id => championIdMap[id];
    const korOf = id => (window.korChampMap || {})[championIdMap[id]] || championIdMap[id] || id;
    const patch = patchDisplay(String(data.scope || '').replace('p:', ''));
    const posName = c => (STAT_POS.find(p => p.code === c) || {}).name || '';
    const posKey = c => (STAT_POS.find(p => p.code === c) || {}).key || '';

    // 그 라인에서의 평소 승률 — 맞대결 값을 읽는 기준선이다
    const laneWr = {};
    (data.rows || []).forEach(r => { if (r.pos >= 0 && r.games) laneWr[`${r.champ}|${r.pos}`] = r.wins / r.games * 100; });

    // ★ 두 챔피언 사이의 관계 전부 (적·아군 · 라인 조합). 표본 순으로 칩이 된다
    const rels = ((mdata && mdata.rows) || [])
        .filter(r => r.foe === b && r.games)
        .map(r => ({ pos: r.pos, fpos: r.fpos == null ? r.pos : r.fpos, rel: r.rel || 0, games: r.games, wins: r.wins }))
        .sort((x, y) => y.games - x.games);
    const keyOf = r => `${r.pos}-${r.fpos}-${r.rel}`;
    const cur = rels.find(r => keyOf(r) === relKey) || rels[0] || null;

    const selOpts = (sel) => Object.keys(championIdMap)
        .map(k => ({ id: Number(k), eng: championIdMap[k], kor: korOf(Number(k)) }))
        .filter(x => x.eng)
        .sort((x, y) => String(x.kor).localeCompare(String(y.kor), 'ko'))
        .map(x => `<option value="${x.eng}"${x.id === sel ? ' selected' : ''}>${x.kor}</option>`).join('');

    const relLabel = r => r.rel
        ? `${posName(r.pos)}+${posName(r.fpos)} 아군`
        : `${posName(r.pos)} vs ${posName(r.fpos)}`;

    const chips = rels.map(r => `
        <button class="versus-chip${cur && keyOf(r) === keyOf(cur) ? ' active' : ''}" data-rel="${keyOf(r)}">
            ${r.rel ? '<span class="versus-chip-ally">아군</span>' : ''}
            <img src="${STAT_LANE_ICON[posKey(r.pos)]}" alt="">
            <span>${posName(r.pos)}</span>
            <span class="versus-chip-x">${r.rel ? '+' : 'vs'}</span>
            <img src="${STAT_LANE_ICON[posKey(r.fpos)]}" alt="">
            <span>${posName(r.fpos)}</span>
            <span class="versus-chip-n">${r.games.toLocaleString()}판</span>
        </button>`).join('');

    const head = `
        <div class="versus-head">
            <a href="/stats/${engOf(a)}" class="stat-back" data-back>← ${korOf(a)} 통계</a>
            <span class="versus-scope">마스터+ · ${patch} 패치</span>
        </div>
        <div class="versus-pick">
            <select class="stats-select versus-select" id="versus-a">${selOpts(a)}</select>
            <span class="versus-vs">VS</span>
            <select class="stats-select versus-select" id="versus-b">${selOpts(b)}</select>
            <button class="versus-swap" id="versus-swap" title="자리 바꾸기">⇄</button>
        </div>
        <div class="versus-faces">
            <div class="versus-face"><img src="${champIconUrl(engOf(a))}" alt=""><span>${korOf(a)}</span></div>
            <div class="versus-face"><img src="${champIconUrl(engOf(b))}" alt=""><span>${korOf(b)}</span></div>
        </div>`;

    if (!cur) {
        // 함께 나온 판이 아예 없을 때 — 자주 만나는 상대를 대신 깔아 되돌아갈 길을 준다
        const others = ((mdata && mdata.rows) || [])
            .filter(r => (r.rel || 0) === 0 && r.games >= MATCHUP_SHOW_MIN)
            .sort((x, y) => y.games - x.games).slice(0, 12)
            .map(r => `
                <div class="versus-alt" data-foe="${engOf(r.foe)}" title="${korOf(r.foe)} · ${r.games}판">
                    <img src="${champIconUrl(engOf(r.foe))}" alt="" loading="lazy">
                    <span>${korOf(r.foe)}</span>
                </div>`).join('');
        box.innerHTML = `<div class="lx-page">${head}
            <div class="versus-none">
                <div class="versus-none-title">${patch} 패치에 두 챔피언이 <b>같은 판에 나온 기록</b>이 없습니다.</div>
                <div class="versus-none-sub">표본 ${MATCHUP_MIN_HINT}판 미만인 조합은 집계에 담기지 않습니다.</div>
                ${others ? `<div class="versus-alt-title">${korOf(a)} 가 자주 만나는 상대</div>
                    <div class="versus-alts">${others}</div>` : ''}
            </div></div>`;
        bindVersus(box, a, b, engOf, null);
        return;
    }

    // ── 고른 관계의 승률 카드
    const wrA = cur.wins / cur.games * 100;
    const baseA = laneWr[`${a}|${cur.pos}`];
    const baseB = laneWr[`${b}|${cur.fpos}`];
    const dim = cur.games < MATCHUP_SHOW_MIN;
    const wrCard = `
        <div class="versus-lane${dim ? ' is-dim' : ''}">
            <div class="versus-lane-head">
                <img src="${STAT_LANE_ICON[posKey(cur.pos)]}" alt="">
                <span>${relLabel(cur)}</span>
                <span class="versus-games">${cur.games.toLocaleString()}판</span>
            </div>
            <div class="versus-bar"><i class="versus-bar-a" style="width:${wrA.toFixed(1)}%"></i></div>
            <div class="versus-wr">
                <span class="versus-wr-a${wrA >= 50 ? ' is-win' : ''}">${wrA.toFixed(1)}%</span>
                <span class="versus-wr-b${wrA < 50 ? ' is-win' : ''}">${(100 - wrA).toFixed(1)}%</span>
            </div>
            <div class="versus-base">
                <span>${korOf(a)} 평소 ${baseA != null ? baseA.toFixed(1) + '%' : '—'}</span>
                <span>${korOf(b)} 평소 ${baseB != null ? baseB.toFixed(1) + '%' : '—'}</span>
            </div>
        </div>`;

    box.innerHTML = `<div class="lx-page">${head}
        ${rels.length > 1 ? `<div class="versus-chips">${chips}</div>` : ''}
        ${wrCard}
        <p class="versus-foot">
            ${cur.rel ? '같은 팀으로 나온 판' : '적으로 만난 판'}만 셉니다. 왼쪽이 ${korOf(a)}, 오른쪽이 ${korOf(b)}의 승률입니다.
            <b>평소</b>는 상대를 가리지 않은 그 라인 승률이라, 맞대결 값이 평소보다 높으면 유리한 쪽입니다.
            ${MATCHUP_SHOW_MIN}판 미만은 흐리게 그립니다 — 표본이 얇으면 승률이 크게 흔들립니다.
        </p>
        <div id="versus-build">${skelLxHtml(false)}</div>
    </div>`;
    bindVersus(box, a, b, engOf, cur);

    // ── 빌드 비교 — **통계 상세와 같은 컴포넌트로** 그린다 (2026-09-02, 사용자 지적).
    //   `/api/versus-build` 가 champbuilds 와 같은 모양으로 오므로 `lxBuildData` 에 그대로 넣으면
    //   룬 페이지·시작/초반 아이템·세트·신발·1~5번째·스킬 순서까지 **한 칸도 안 빠지고** 나온다.
    //   세 번째 인자(평소 빌드)를 주면 모든 줄에 "평소 대비" 칸이 하나 더 붙는다.
    try {
        await loadPerkData();
        const [vb, baseBuilds, icons] = await Promise.all([
            fetch(`/api/versus-build?a=${a}&b=${b}&pos=${cur.pos}&fpos=${cur.fpos}&rel=${cur.rel}&scope=${encodeURIComponent(data.scope)}`)
                .then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`/api/champion-builds?scope=${encodeURIComponent(data.scope)}&champ=${a}`)
                .then(r => r.ok ? r.json() : null).catch(() => null),
            loadChampSpellIcons(engOf(a))
        ]);
        const el = document.getElementById('versus-build');
        if (!el) return;
        if (!vb || !vb.ready || !vb.total) { el.innerHTML = `<div class="lx-none">이 관계의 빌드 표본이 아직 없습니다.</div>`; return;}
        // 통계 상세와 같은 ctx — 그쪽 컴포넌트가 c.B 와 c.skillIcons 만 본다
        const vctx = { B: lxBuildData(vb, cur.pos, baseBuilds), skillIcons: icons, pos: cur.pos };
        el.innerHTML = `<div class="versus-build-head">
                <span class="versus-build-title">${cur.rel ? josa(korOf(b), '과', '와') + ' 같은 팀일 때' : josa(korOf(b), '을', '를') + ' 만났을 때'} ${korOf(a)} 빌드</span>
                <span class="versus-build-n">${(vb.total || 0).toLocaleString()}판 기준 · 평소 대비 칸은 상대를 가리지 않은 같은 라인 채택률과의 차이입니다</span>
            </div>` + lxLowerRows(vctx) + lxSkillBox(vctx) + lxRuneBox(vctx);
        lxBindTabs(el, vctx);
    } catch (e) {
        const el = document.getElementById('versus-build');
        if (el) el.innerHTML = '';
    }
}

// 관계 칩·선택기·되돌아가기 배선 (두 갈래에서 같이 쓴다)
function bindVersus(box, a, b, engOf, cur) {
    const go = (na, nb, rk) => {
        const url = `/versus/${na}/${nb}${rk ? '/' + rk : ''}`;
        window.history.replaceState({ page: 'versus', a: na, b: nb, rel: rk }, '', url);
        showVersusPage(na, nb, rk || null);
    };
    const selA = document.getElementById('versus-a');
    const selB = document.getElementById('versus-b');
    if (selA) selA.addEventListener('change', (e) => go(e.target.value, engOf(b)));
    if (selB) selB.addEventListener('change', (e) => go(engOf(a), e.target.value));
    const sw = document.getElementById('versus-swap');
    // ★ 자리를 바꾸면 관계도 뒤집는다 (pos 와 fpos 를 맞바꾼다) — 안 그러면 없는 관계를 가리킨다
    if (sw) sw.addEventListener('click', () => go(engOf(b), engOf(a), cur ? `${cur.fpos}-${cur.pos}-${cur.rel}` : null));
    box.querySelectorAll('.versus-alt').forEach(el => el.addEventListener('click', () => go(engOf(a), el.dataset.foe)));
    box.querySelectorAll('.versus-chip').forEach(el => el.addEventListener('click', () => go(engOf(a), engOf(b), el.dataset.rel)));
    const back = box.querySelector('[data-back]');
    if (back) back.addEventListener('click', (e) => {
        e.preventDefault();
        window.history.pushState({ page: 'stats', champ: engOf(a) }, '', `/stats/${engOf(a)}`);
        showChampStatPage(engOf(a));
    });
}


// ── 페이지 본체 ───────────────────────────────────────────────────────
async function showChampStatPage(engId, laneKey) {
    hideAllContainers();
    setActiveNav('nav-stats-live');
    const box = document.getElementById('stats-container');
    box.style.display = 'block';
    box.innerHTML = `<div class="lx-page">${skelLxHtml()}</div>`;

    await fetchChampionMap();
    const champ = Number(Object.keys(championIdMap)
        .find(k => String(championIdMap[k]).toLowerCase() === String(engId).toLowerCase()));
    if (!Number.isFinite(champ)) {
        box.innerHTML = `<div class="stats-empty">알 수 없는 챔피언입니다.</div>`;
        return;
    }
    const eng = championIdMap[champ];

    let data;
    const iconsP = loadChampSpellIcons(eng);
    try {
        const res = await fetch(`/api/champion-stats${window.statScope ? `?scope=${encodeURIComponent(window.statScope)}` : ''}`);
        data = await res.json();
        // ★ 박제된 패치는 행이 DB 가 아니라 정적 파일에 있다 — showStats() 와 같은 처리다
        if (data.archived) {
            const a = await loadStatsArchive(data.scope, data.updatedAt);
            const ex = expandStatsArchive(a);
            window.statsArchiveExpanded = window.statsArchiveExpanded || {};
            window.statsArchiveExpanded[data.scope] = ex;
            data.rows = ex.rows;
            if (!Object.keys(data.totals || {}).length) {
                data.totals = {};
                a.t.forEach(t => { data.totals[ARCHIVE_KB[t[0]]] = t[1]; });
            }
        }
    } catch (e) {
        box.innerHTML = `<div class="stats-empty">통계를 불러오지 못했습니다.</div>`;
        return;
    }
    window.statScope = data.scope;

    const kor = window.korChampMap[eng] || engId;
    const total = (data.totals && (data.totals.all ?? Object.values(data.totals)[0])) || 0;
    const patch = patchDisplay(String(data.scope || '').replace('p:', ''));

    // ★ 표와 같은 방식으로 줄을 만든다 (`pos: -1` 전체 · 0~4 라인별)
    const mine = (data.rows || []).filter(r => r.champ === champ);
    const all = mine.find(r => r.pos === -1) || mine[0];
    if (!all || !all.games) {
        box.innerHTML = `<div class="stats-empty">${kor} 의 표본이 없습니다. <a href="/stats" class="stat-back">← 통계로</a></div>`;
        return;
    }
    const byLane = mine.filter(r => r.pos >= 0 && r.games).sort((a, b) => a.pos - b.pos);
    const byGames = [...byLane].sort((a, b) => b.games - a.games);
    const wantPos = laneKey ? (STAT_POS.find(p => p.key === laneKey)?.code ?? -1) : -1;
    const main = byLane.find(r => r.pos === wantPos) || byGames[0] || all;
    const curKey = STAT_POS.find(p => p.code === main.pos)?.key;
    const laneName = STAT_POS.find(p => p.code === main.pos)?.name || '';
    const laneRate = all.games ? main.games / all.games * 100 : 0;

    const wr = main.games ? main.wins / main.games * 100 : 0;
    const pick = total ? main.games / total * 100 : 0;
    const ban = total ? (all.bans || 0) / total * 100 : 0;

    // 라인별 평균 승률(판수 가중, 30판 이상) 과 챔피언x라인 승률 표 — 헤더의 Game Avg WR 와 상성의 Delta 2 가 쓴다
    const laneAvg = {}, laneWr = {};
    STAT_POS.forEach(p => {
        const pool = (data.rows || []).filter(r => r.pos === p.code && r.games >= STAT_MIN_GAMES);
        const g = pool.reduce((a, r) => a + r.games, 0);
        laneAvg[p.code] = g ? pool.reduce((a, r) => a + r.wins, 0) / g * 100 : 50;
    });
    (data.rows || []).forEach(r => { if (r.pos >= 0 && r.games) laneWr[`${r.champ}|${r.pos}`] = r.wins / r.games * 100; });
    const avgWr = laneAvg[main.pos] ?? 50;
    const delta = wr - avgWr;

    const tierInfo = computeLaneTiers(data.rows || [], total);
    const myTier = tierInfo.get(`${champ}|${main.pos}`);
    const sameLane = [...tierInfo.entries()].filter(([k]) => k.endsWith(`|${main.pos}`)).map(([, v]) => v.score).sort((a, b) => b - a);
    const rank = myTier ? sameLane.indexOf(myTier.score) + 1 : 0;

    const skillIcons = await iconsP;
    const ctx = { champ, eng, kor, pos: main.pos, laneName, curKey, patch, total, main, all, byLane, laneRate,
        wr, pick, ban, avgWr, delta, laneAvg, laneWr, myTier, rank, sameLane, skillIcons, data, engId };

    box.innerHTML = `
    <div class="lx-page">
        ${lxHeader(ctx)}
        <div id="lx-body">${skelLxHtml(false)}</div>
    </div>`;

    // 라인 전환 — 주소는 바꾸되 이력은 안 쌓는다 (replaceState). 버전 전환도 같은 함수로 다시 그린다
    box.querySelectorAll('.lx-lane:not([disabled])').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.lane;
        window.history.replaceState({ page: 'stats', champ: engId, lane: k }, '', `/stats/${engId}/${k}`);
        showChampStatPage(engId, k);
    }));
    const sel = box.querySelector('#lx-scope');
    if (sel) sel.addEventListener('change', () => { window.statScope = sel.value; showChampStatPage(engId, laneKey); });

    // ── 빌드·상성·추이
    const body = document.getElementById('lx-body');
    try {
        await loadPerkData();
        let builds, matchups;
        if (data.archived) {
            builds = archivedBuildsFor(data.scope, champ);
            matchups = archivedMatchupsFor(data.scope, champ);
        } else {
            [builds, matchups] = await Promise.all([
                fetch(`/api/champion-builds?scope=${encodeURIComponent(data.scope)}&champ=${champ}`).then(r => r.ok ? r.json() : null),
                fetch(`/api/champion-matchups?scope=${encodeURIComponent(data.scope)}&champ=${champ}`).then(r => r.ok ? r.json() : null).catch(() => null)
            ]);
        }
        const trendP = fetch(`/api/champion-trend?champ=${champ}&pos=${main.pos}`).then(r => r.ok ? r.json() : null).catch(() => null);

        const B = lxBuildData(builds, main.pos);
        ctx.B = B;
        ctx.M = lxMatchupData(matchups, ctx);
        // ★ 탭 줄과 빌드 상자(승률 최고 / 가장 많이 쓰는 빌드)는 2026-08-27 에 뺐다 (사용자 요청) — 헤더 바로 아래가 추이 그래프다
        body.innerHTML = `<div id="lx-trend"></div>` + lxMatchups(ctx) + lxLowerRows(ctx) + lxSkillBox(ctx) + lxRuneBox(ctx);
        lxBindTabs(body, ctx);
        // ★ 상성 카드를 누르면 맞대결 비교로 (2026-09-02, 로드맵 A-2). 위임 하나라 탭을 바꿔
        //   카드가 다시 그려져도 살아 있다 — `lxMatchupRows` 가 같은 라인 적 카드에만 data-foe 를 심는다.
        const muBox = document.getElementById('lx-counters');
        if (muBox) muBox.addEventListener('click', (ev) => {
            const card = ev.target.closest('.lx-card[data-foe]');
            if (!card) return;
            // data-rel 은 `<상대 라인>-<적0/아군1>` 이라 내 라인을 앞에 붙여 관계 키를 만든다
            const rk = `${ctx.pos}-${card.dataset.rel}`;
            const url = `/versus/${engId}/${card.dataset.foe}/${rk}`;
            window.history.pushState({ page: 'versus', a: engId, b: card.dataset.foe, rel: rk }, '', url);
            showVersusPage(engId, card.dataset.foe, rk);
        });
        const trend = await trendP;
        document.getElementById('lx-trend').innerHTML = lxTrend(ctx, trend);
    } catch (e) {
        console.error(e);
        body.innerHTML = `<div class="build-empty">빌드를 불러오지 못했습니다.</div>`;
    }
}

// ── 헤더 ─────────────────────────────────────────────────────────────
function lxHeader(c) {
    const stat = (val, label, cls, tip) => `<div class="lx-stat"${tip ? ` title="${tip}"` : ''}><div class="lx-stat-v ${cls || ''}">${val}</div><div class="lx-stat-k">${label}</div></div>`;
    const tierCls = c.myTier ? tierClass(c.myTier.tier) : '';
    const R = 30, C = 2 * Math.PI * R;
    const scopes = scopeOptionsHtml(c.data.scopes, c.data.scope);
    const desc = `<b>${c.kor}</b> ${c.laneName}은 마스터+ 솔로랭크 ${c.patch} 패치에서 승률 <b>${c.wr.toFixed(1)}%</b>`
        + (c.rank ? `, 같은 라인 ${c.sameLane.length}명 중 <b>${c.rank}위</b>로 <b>${c.myTier.tier === 'OP' ? 'OP' : c.myTier.tier + ' 티어'}</b>입니다 (점수 ${c.myTier.score.toFixed(1)}).` : '입니다.')
        + ` 라인 평균 승률(${c.avgWr.toFixed(2)}%)보다 ${Math.abs(c.delta).toFixed(2)}%p ${c.delta >= 0 ? '높' : '낮'}습니다.`
        + ` 아래는 ${c.kor}의 빌드 · 룬 · 상성을 자세히 나눈 것입니다.`;
    return `
    <div class="lx-toolbar">
        <img class="lx-toolbar-portrait" src="${champIconUrl(c.eng)}" alt="">
        ${STAT_POS.map(p => {
            const r = c.byLane.find(x => x.pos === p.code);
            const rate = r && c.all.games ? r.games / c.all.games * 100 : 0;
            return `<button class="lx-lane${r && r.pos === c.pos ? ' active' : ''}${r ? '' : ' is-none'}" data-lane="${p.key}"${r ? '' : ' disabled'} title="${p.name}">
                <img src="${STAT_LANE_ICON[p.key]}" alt=""><span>${p.name}</span><b>${rate.toFixed(1)}%</b></button>`;
        }).join('')}
        <label class="lx-chip lx-chip-select">패치<select id="lx-scope">${scopes}</select></label>
        <span class="lx-chip"><b>랭크</b>솔로/듀오</span>
        <span class="lx-chip"><b>마스터+</b>KR</span>
        <span class="lx-toolbar-note">${c.laneName} 평균 승률 ${c.avgWr.toFixed(2)}%<br>전체 ${c.total.toLocaleString()}판</span>
    </div>
    <div class="lx-crumb"><a href="/stats">챔피언 통계</a> / ${c.kor} 빌드</div>
    <div class="lx-hero">
        <div class="lx-hero-left">
            <div class="lx-portrait-wrap">
                <img class="lx-portrait" src="${champIconUrl(c.eng)}" alt="">
                ${c.curKey ? `<span class="lx-badge lx-badge-lane"><img src="${STAT_LANE_ICON[c.curKey]}" alt=""></span>` : ''}
                ${c.myTier ? `<span class="lx-badge lx-badge-tier ${tierCls}">${c.myTier.tier}</span>` : ''}
            </div>
            <div class="lx-donut" title="${c.kor} 판 중 ${c.laneName} 비율">
                <svg viewBox="0 0 80 80" width="80" height="80">
                    <circle cx="40" cy="40" r="${R}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="10"/>
                    <circle cx="40" cy="40" r="${R}" fill="none" stroke="#a78bfa" stroke-width="10" stroke-dasharray="${(C * c.laneRate / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 40 40)"/>
                </svg>
                <span>${c.laneRate.toFixed(0)}%</span>
            </div>
        </div>
        <div class="lx-hero-main">
            <h1 class="lx-title">${c.kor} 빌드, 룬 &amp; 상성 — ${c.laneName} ${c.kor}</h1>
            ${c.skillIcons ? `<div class="lx-skills">${['P', 'Q', 'W', 'E', 'R'].map(k => c.skillIcons[k]
                ? `<span class="lx-skill"><img src="${c.skillIcons[k]}" alt=""><i>${k}</i></span>` : '').join('')}</div>` : ''}
            <p class="lx-desc">${desc}</p>
            <div class="lx-statrow">
                ${stat(c.wr.toFixed(1) + '%', '승률', lxDeltaCls(c.delta))}
                ${stat(lxSigned(c.delta) + '%', '승률 델타', lxDeltaCls(c.delta), '라인 평균 승률과의 차이')}
                ${stat(c.avgWr.toFixed(2) + '%', '라인 평균 승률', '', `${c.laneName} 표본 ${STAT_MIN_GAMES}판 이상 챔피언의 판수 가중 평균`)}
                ${stat(c.pick.toFixed(2) + '%', '픽률')}
            </div>
            <div class="lx-statrow">
                ${stat(c.myTier ? `<span class="${tierCls}">${c.myTier.tier}</span>` : '-', '티어', '', c.myTier ? `점수 ${c.myTier.score.toFixed(2)} — 승률·픽률·밴률 합산, 라인 안에서 매김` : '')}
                ${stat(c.rank ? `${c.rank} / ${c.sameLane.length}` : '-', '순위', '', '같은 라인 안에서 티어 점수 순')}
                ${stat(c.ban.toFixed(2) + '%', '밴률')}
                ${stat(c.main.games.toLocaleString(), '표본 수')}
            </div>
        </div>
    </div>`;
}

// ── 빌드 자료 정리 ─────────────────────────────────────────────────────
//   B.rows(type) = 그 라인의 줄들(판수 내림차순, 1판짜리 제외 — 전부 1판이면 한 줄), B.pick(type, mode) = 대표 하나
//   B.total = all 분모, B.tl = tlall 분모 (타임라인 있는 판). tl 이 0 이면 그 패치는 로그가 없는 것이다.
// ★★ `baseBuilds` 를 주면 **평소 대비 차이** 칸이 모든 줄에 붙는다 (2026-09-02, vs 비교 페이지).
//   통계 상세는 안 넘기므로 예전 그대로 세 칸이다 — 같은 컴포넌트를 두 화면이 쓰는 이유가 이것이다.
function lxBuildData(builds, pos, baseBuilds) {
    const rowsAll = (builds && builds.rows) || [];
    const totals = (builds && builds.totals) || {};
    const total = totals[pos] || 0;
    const of = type => rowsAll.filter(r => r.type === type && (r.pos == null ? -1 : r.pos) === pos);
    const rows = type => {
        const list = of(type).sort((a, b) => b.games - a.games);
        const kept = list.filter(r => r.games >= 2);
        return kept.length ? kept : list.slice(0, 1);
    };
    const tl = (of('tlall')[0] || {}).games || 0;
    // ★ mode 'win' = 1위 판수의 10% 이상(최소 5판)인 후보 중 승률 최고. 아니면 100% 1판짜리가 뽑힌다
    const pick = (type, mode) => {
        const list = rows(type);
        if (!list.length) return null;
        if (mode !== 'win') return list[0];
        const floor = Math.max(BUILD_MIN_GAMES, list[0].games * LX_WIN_MIN_SHARE);
        const cand = list.filter(r => r.games >= floor);
        return (cand.length ? cand : list).sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games)[0];
    };
    const sorted = (type, mode, n) => {
        const list = rows(type);
        if (mode === 'win') {
            const floor = Math.max(BUILD_MIN_GAMES, (list[0]?.games || 0) * LX_WIN_MIN_SHARE);
            return list.filter(r => r.games >= floor).sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games).slice(0, n);
        }
        return list.slice(0, n);
    };
    // 평소 값 표 — `type|key` → 채택률(%). 분모는 그쪽 all/tlall 이다 (여기 분모와 다르다)
    let base = null;
    if (baseBuilds && baseBuilds.rows) {
        const bT = (baseBuilds.totals || {})[pos] || 0;
        const bTl = (baseBuilds.rows.find(r => r.type === "tlall" && (r.pos == null ? -1 : r.pos) === pos) || {}).games || 0;
        base = {};
        baseBuilds.rows.forEach(r => {
            if ((r.pos == null ? -1 : r.pos) !== pos) return;
            const d = LX_TL_TYPES.has(r.type) ? bTl : bT;
            if (d) base[`${r.type}|${(r.key || []).join(",")}`] = r.games / d * 100;
        });
    }
    return { rows, pick, sorted, total, tl, base, rebuilding: builds && builds.rebuilding, archived: builds && builds.archived, has: !!builds };
}

// 픽률 분모: 타임라인 type 은 tl, 나머지는 total
const LX_TL_TYPES = new Set(['skillord', 'skillord6', 'skillord10', 'skillpri', 'start', 'early', 'earlyset', 'boots', 'core', 'set2', 'set4', 'set5', 'item1', 'item2', 'item3', 'item4', 'item5', 'item6', 'skilllv', 'skillord11']);
function lxDenom(B, type) { return LX_TL_TYPES.has(type) ? B.tl : B.total; }

// 3칸 값 (승률 · 픽률 · 판수) — 카드 줄 공통
function lxVals3(B, type, r) {
    const vals = [
        { v: lxPct(r.wins, r.games) + '%', cls: lxWr(r.wins, r.games) },
        { v: lxPct(r.games, lxDenom(B, type)) + '%', cls: 'lx-lav' },
        { v: r.games, cls: 'lx-gray' }
    ];
    // ★ vs 비교에서만 붙는 칸 — 평소 채택률 대비 차이 (통계 상세는 B.base 가 없어 그대로 세 칸)
    if (B.base) {
        const b0 = B.base[`${type}|${(r.key || []).join(",")}`];
        const cur = lxDenom(B, type) ? r.games / lxDenom(B, type) * 100 : 0;
        const d = b0 == null ? null : cur - b0;
        vals.push({ v: d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(1), cls: d == null ? 'lx-gray' : (d >= 0 ? 'lx-green' : 'lx-red') });
    }
    return vals;
}
const LX_M3 = [{ t: '승률', cls: 'lx-green' }, { t: '픽률', cls: 'lx-lav' }, { t: '표본 수', cls: 'lx-gray' }];
// ★ vs 비교면 머리글도 한 칸 는다 (lxVals3 과 짝이라 한쪽만 고치면 어긋난다)
const lxM3 = B => (B && B.base) ? [...LX_M3, { t: '평소 대비', cls: 'lx-yellow' }] : LX_M3;

// 스킬 배지 (아이콘 + 글자)
function lxSkill(c, n, small) {
    const L = 'QWER'[n - 1] || '';
    const u = c.skillIcons && c.skillIcons[L];
    return `<span class="lx-skl${small ? ' is-sm' : ''}">${u ? `<img src="${u}" alt="">` : ''}<i>${L}</i></span>`;
}

// ── 추이 그래프 4개 (승률 · 픽률 · 판수 · 밴률, 최근 7일) ────────────────
function lxTrend(c, trend) {
    const days = (trend && trend.days) || [];
    // ★ 수요일 = 패치 경계. 눈금선과 날짜 글자 둘 다 이 날에만 그린다.
    //   new Date('2026-09-09') 는 UTC 자정으로 읽히는데 한국은 +9 라 같은 날 09시다 — 하루 안 밀린다.
    const isWed = d => new Date(d.day).getDay() === 3;
    const graph = (title, cls, vals, fmt) => {
        const W = 244, H = 150, L = 34, R = 8, T = 30, Bm = 26;
        if (days.length < 2) return `<div class="lx-graph"><div class="lx-graph-t ${cls}">${title}</div><div class="lx-none">최근 7일 표본이 아직 없습니다</div></div>`;
        let lo = Math.min(...vals), hi = Math.max(...vals);
        if (hi === lo) { hi += 1; lo -= 1; }
        const pad = (hi - lo) * 0.15; lo -= pad; hi += pad; if (lo < 0 && Math.min(...vals) >= 0) lo = 0;
        const x = i => L + (i / (days.length - 1)) * (W - L - R);
        const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - Bm);
        const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        const ticks = [0, 0.5, 1].map(f => lo + (hi - lo) * f);
        return `
        <div class="lx-graph">
            <div class="lx-graph-t ${cls}">${title}</div>
            <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
                ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="#222"/><text x="${L - 4}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#bbb">${fmt(t)}</text>`).join('')}
                <!-- 수요일 세로 점선 — 위 눈금선 다음, 꺾은선 앞에 그려야 선 뒤로 깔린다.
                     y2 는 H-16 = 아래 날짜 글자의 윗변이라 눈금과 날짜가 이어져 보인다. -->
                ${days.map((d, i) => (isWed(d)
            ? `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${T}" y2="${H - 16}" class="lx-wed"/>` : '')).join('')}
                <polyline points="${pts}" fill="none" class="lx-line ${cls}" stroke-width="1.5"/>
                ${vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" class="lx-dot ${cls}"><title>${days[i].day} · ${fmt(v)}</title></circle>`).join('')}
                <!-- ★★ 날짜는 **수요일만** 적는다 (2026-09-09 사용자 요청). 날이 열흘을 넘으면
                     매일 적을 때 글자가 서로 겹쳐 못 읽는다. 수요일인 이유는 패치가 수요일에 오기
                     때문 — 눈금이 곧 패치 경계다.
                     ★ new Date('2026-09-09') 는 UTC 자정으로 읽히는데 한국은 +9 라 같은 날 09시다.
                       그래서 getDay() 가 날짜를 안 넘긴다 (하루 밀리지 않는다).
                     ★★ 이 주석은 템플릿 문자열 안이다 — 백틱을 쓰면 문자열이 거기서 끊긴다
                        (이번 세션에서 세 번째다: 도감 채택률·도감 dt·여기) -->
                ${days.map((d, i) => (isWed(d)
            ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="8" fill="#bbb">${d.day.slice(5)}</text>` : '')).join('')}
            </svg>
        </div>`;
    };
    const wrV = days.map(d => d.games ? d.wins / d.games * 100 : 0);
    const pkV = days.map(d => d.total ? d.games / d.total * 100 : 0);
    const gV = days.map(d => d.games);
    const bV = days.map(d => d.total ? d.bans / d.total * 100 : 0);
    const p1 = v => v.toFixed(1);
    return `
    <div class="lx-legend"><b>범례:</b><span class="lx-legend-on">마스터+</span><span>솔로/듀오</span><span>KR</span><span class="lx-legend-on">최근 7일</span><span>일별</span></div>
    <div class="lx-graphs">
        ${graph(`${c.kor} 승률`, 'lx-green', wrV, p1)}
        ${graph(`${c.kor} 픽률`, 'lx-blue', pkV, p1)}
        ${graph(`${c.kor} 밴률`, 'lx-red', bV, p1)}
        ${graph(`${c.kor} 표본 수`, 'lx-white', gV, v => Math.round(v).toLocaleString())}
    </div>`;
}

// ── 상성 자료 정리 ──────────────────────────────────────────────────
//   M.counter[L] = 적 L라인 상대들, M.synergy[L] = 아군 L라인 (내 라인 제외). 값: wr · delta1 · delta2 · pick · games
//   delta1 = 승률 − 내 라인 승률. delta2 = 거기서 상대(아군) 챔피언 자체의 강함까지 뺀 것
//   (적: + (상대 승률 − 그 라인 평균) / 아군: − (아군 승률 − 그 라인 평균)) — 그쪽의 Delta 2 자리
function lxMatchupData(mdata, c) {
    const out = { archived: !!(mdata && mdata.archived), counter: {}, synergy: {}, n: 0 };
    const rows = (mdata && mdata.rows) || [];
    const mine = rows.filter(r => r.pos === c.pos);
    const myWr = c.main.games ? c.main.wins / c.main.games * 100 : 0;
    const enrich = (r, ally) => {
        const w = r.wins / r.games * 100;
        const fw = c.laneWr[`${r.foe}|${r.fpos}`];
        const adj = fw == null ? 0 : (fw - (c.laneAvg[r.fpos] ?? 50));
        return { ...r, wr: w, d1: w - myWr, d2: w - myWr + (ally ? -adj : adj), pick: c.main.games ? r.games / c.main.games * 100 : 0 };
    };
    STAT_POS.forEach(p => {
        out.counter[p.code] = mine.filter(r => (r.rel || 0) === 0 && (r.fpos == null ? r.pos : r.fpos) === p.code).map(r => enrich(r, false));
        if (p.code !== c.pos) out.synergy[p.code] = mine.filter(r => r.rel === 1 && r.fpos === p.code).map(r => enrich(r, true));
    });
    out.n = mine.length;
    return out;
}

function lxMatchups(c) {
    const M = c.M;
    const inner = M.archived
        ? `<div class="lx-none">박제된 패치라 상성 통계가 없습니다.</div>`
        : (!M.n ? `<div class="lx-none">${c.laneName} 상성 표본이 없습니다.</div>` : `<div id="lx-mu-rows">${lxMatchupRows(c, 'counter', 'common')}</div>`);
    return `
    <div class="lx-box" id="lx-counters">
        <div class="lx-mu-tabs">
            <div class="lx-mu-tabrow"><span class="lx-mu-tablabel">상성</span>
                ${lxTabBar('mu-counter', [{ v: 'common', label: '자주 만나는 상대' }, { v: 'strong', label: '강한 상대 (간단)' }, { v: 'weak', label: '약한 상대 (간단)' }, { v: 'strong2', label: '강한 상대 (상세)' }, { v: 'weak2', label: '약한 상대 (상세)' }], 'common')}</div>
            <div class="lx-mu-tabrow"><span class="lx-mu-tablabel">시너지</span>
                ${lxTabBar('mu-synergy', [{ v: 'common', label: '자주 만나는 아군' }, { v: 'strong', label: '좋은 시너지 (간단)' }, { v: 'weak', label: '나쁜 시너지 (간단)' }, { v: 'strong2', label: '좋은 시너지 (상세)' }, { v: 'weak2', label: '나쁜 시너지 (상세)' }], '')}</div>
        </div>
        ${inner}
        <div class="lx-foot">간단보정 = 그 상대(아군)와 만났을 때 승률 − 이 챔피언의 라인 승률 · 상세보정 = 거기서 상대(아군) 챔피언 자체의 강함(그 라인 평균 대비)을 뺀 값 · 픽률 = 이 라인 판 중 만난 비율 · ${MATCHUP_SHOW_MIN}판 미만은 흐리게</div>
    </div>`;
}

function lxMatchupRows(c, group, sort) {
    const M = c.M;
    const sorters = {
        common: (a, b) => b.games - a.games,
        // ★ (간단) = 간단보정(d1) 순, (상세) = 상세보정(d2) 순 (2026-08-27, 사용자 요청 — "델타" 라는 말을 뺐다).
        //   d1 은 승률 − 라인 승률이라 승률 순과 같은 순서다
        strong: (a, b) => b.d1 - a.d1 || b.games - a.games,
        weak: (a, b) => a.d1 - b.d1 || b.games - a.games,
        strong2: (a, b) => b.d2 - a.d2 || b.games - a.games,
        weak2: (a, b) => a.d2 - b.d2 || b.games - a.games
    };
    const src = group === 'counter' ? M.counter : M.synergy;
    const metrics = [{ t: '승률', cls: 'lx-green' }, { t: '간단보정', cls: 'lx-yellow' }, { t: '상세보정', cls: 'lx-yellow' }, { t: '픽률', cls: 'lx-lav' }, { t: '표본 수', cls: 'lx-gray' }];
    return STAT_POS.filter(p => src[p.code]).map(p => {
        const list = [...src[p.code]].sort(sorters[sort] || sorters.common).slice(0, LX_ROW_MAX);
        const cards = list.map(r => {
            const eng = championIdMap[r.foe];
            const name = (window.korChampMap && window.korChampMap[eng]) || eng || r.foe;
            return {
                icons: [champIconUrl(eng)], dim: r.games < MATCHUP_SHOW_MIN,
                // ★★ 카드를 **전부** 누를 수 있다 (2026-09-02, 사용자 요청 "맞라인 아니어도").
                //   아군 시너지 카드도 vs 페이지가 다루므로(관계 칩) `rel` 을 같이 넘긴다.
                attr: eng ? ` data-foe="${eng}" data-rel="${p.code}-${group === 'counter' ? 0 : 1}"` : '',
                cls: eng ? 'is-link' : '',
                title: `${name} · ${r.games}판 · 승률 ${r.wr.toFixed(2)}% · 눌러서 비교`,
                vals: [
                    { v: r.wr.toFixed(2), cls: lxWr(r.wins, r.games) },
                    { v: lxSigned(r.d1), cls: lxDeltaCls(r.d1) },
                    { v: lxSigned(r.d2), cls: lxDeltaCls(r.d2) },
                    { v: r.pick.toFixed(2), cls: 'lx-lav' },
                    { v: r.games, cls: 'lx-gray' }
                ]
            };
        });
        return lxRow({ icon: STAT_LANE_ICON[p.key], title: group === 'counter' ? '상대' : '아군', metrics }, cards, { empty: `${p.name} 표본 없음` });
    }).join('');
}

// ── 아래 카드 줄들 (주문 · 시작 · 초반 · 세트 · 신발/1~5번째/인기/승률/전체) ───────
function lxLowerRows(c) {
    const B = c.B;
    if (!B.has || !B.total) return '';
    const hasTl = B.tl > 0;
    // ★ key 가 비면 「신발 없음」이다 (2026-09-09) — 신발을 안 사고 끝낸 판을 세는 줄이라
    //   아이콘이 없다. 다른 type 은 빈 key 가 안 온다 (신발만 그렇게 담는다).
    const itemCards = (type, list) => list.map(r => (r.key.length
        ? { icons: [itemIconOf(r.key[0])], title: itemNameOf(r.key[0]), vals: lxVals3(B, type, r) }
        : { top: '<span class="lx-noitem">없음</span>', title: '신발을 사지 않은 판', vals: lxVals3(B, type, r) }));
    const setCards = (type, list) => list.map(r => ({ icons: r.key.map(itemIconOf), title: r.key.map(itemNameOf).join(' › '), vals: lxVals3(B, type, r) }));
    const box = (id, tabbar, rowsHtml) => `<div class="lx-box" id="${id}">${tabbar || ''}<div class="lx-box-rows">${rowsHtml}</div></div>`;

    // 소환사 주문 (아이콘 두 개를 세로로 쌓는다 — 그쪽과 같다)
    const spells = box('lx-spells', '', lxRow({ title: '소환사 주문', metrics: lxM3(B) },
        B.rows('spell').slice(0, LX_ROW_MAX).map(r => ({ icons: r.key.map(spellIcon), title: r.key.map(spellName).join(' + '), vals: lxVals3(B, 'spell', r) })),
        { stack: true, topH: 80 }));

    // 최종 아이템 셋 — 인기(픽 순) · 승률(승률 순, 표본 하한) · 전체
    const fin = B.rows('item');
    const floor = Math.max(BUILD_MIN_GAMES, (fin[0]?.games || 0) * LX_WIN_MIN_SHARE);
    const finalRows = lxRow({ title: '인기 아이템', metrics: lxM3(B) }, itemCards('item', fin.slice(0, LX_ROW_MAX)))
        + lxRow({ title: '승률 아이템', metrics: lxM3(B) }, itemCards('item', fin.filter(r => r.games >= floor).sort((a, b) => b.wins / b.games - a.wins / a.games).slice(0, LX_ROW_MAX)));
    // ★ '전체 아이템' 줄은 **타임라인 없는 패치(16.16)에서만** 뺀다 (2026-08-27, 사용자 요청) — 16.17 은 그쪽과 같이 다 보여준다
    const allItemsRow = hasTl ? lxRow({ title: '전체 아이템', metrics: lxM3(B) }, itemCards('item', fin.slice(0, 60))) : '';

    if (!hasTl) {
        return spells + box('lx-items', '', finalRows);
    }

    // ★ 각주로 구간을 밝힌다 (2026-09-09 사용자 요청 "몇 분 이전에 산 것들인지").
    //   ★★ 90초는 server.js 의 `TL_START_SEC` 이다 — 거길 바꾸면 이 글도 같이 바꿀 것.
    //     (10분은 `TL_EARLY_SEC`. 초반 아이템 상자는 뺐지만 구간 설명엔 남는다)
    const starting = box('lx-start',
        lxTabBar('start', [{ v: 'item', label: '시작 아이템' }, { v: 'set', label: '시작 아이템 세트' }], 'set'),
        `<div id="lx-start-body">${lxStartBody(c, 'set')}</div>`
        + `<div class="lx-foot">경기 시작 <b>90초(1분 30초)</b> 안에 산 것 · 물약과 와드는 빼고 센다</div>`);
    // ★ 초반 아이템(10분) 상자는 2026-09-09 에 뺐다 (사용자 요청). 집계(early·earlyset)는 그대로 둔다 —
    //   시작 아이템 줄이 그 자료를 쓰고, 되살리려면 여기 상자만 다시 만들면 된다.
    const sets = box('lx-sets',
        lxTabBar('sets', [{ v: 'set2', label: '아이템 2개' }, { v: 'core', label: '아이템 3개' }, { v: 'set4', label: '아이템 4개' }, { v: 'set5', label: '아이템 5개' }], 'core'),
        `<div id="lx-sets-body">${lxRow({ title: '세트', metrics: lxM3(B) }, setCards('core', B.rows('core').slice(0, 12)), { empty: '타임라인 표본을 모으는 중' })}</div>`);
    // ★★ 코어별 줄 — **몇 번째로 완성한 아이템인가**를 칸마다 나눠 픽률순으로 세운다
    //   (2026-09-09 사용자 요청: 「승률 아이템 아래에 코어별로 쭈루룩 · 코어템별 승률·픽률」).
    //   ★ `item1`~`item6` 은 집계의 `nth(0..5)` — **완성 아이템만** 순서대로 센 것이라 곧 1~6코어다.
    //     `B.rows()` 가 판수(=픽) 순으로 주므로 정렬을 따로 안 한다.
    //   ★ 6코어를 새로 넣었다 (2026-09-09). 데이터는 원래 있었는데 줄만 5개까지 그리고 있었다.
    //   ★★ 자리는 **승률 아이템 바로 아래**다 — 「인기 → 승률 → 코어별 → 전체」 순.
    //     맨 아래가 '전체 아이템'(60칸)인 건 그 줄이 제일 길어서다.
    const coreRows = ['item1', 'item2', 'item3', 'item4', 'item5', 'item6']
        .map((t, i) => lxRow({ title: `${i + 1}코어`, metrics: lxM3(B) },
            itemCards(t, B.rows(t).slice(0, LX_ROW_MAX)), { empty: '타임라인 표본을 모으는 중' })).join('');

    // ★ 각주 (2026-09-09 사용자 결정 "A로 하고 구매 순서 기준이라고 써놔") — 코어 줄이 무엇을
    //   세는지 밝힌다. 판 아이템도 그 자리에 남는다 (`ITEM_SOLD` 를 안 담으므로).
    //   실측: 코어로 센 아이템이 최종 6칸에 없는 사람이 5.58% 인데 그 대부분은 판 게 아니라
    //   **변신**이다 (마나무네→무라마나 12,661 · 대천사→포옹 6,714). 진짜 판 건 1.25% 쯤.
    const items = box('lx-items', '',
        lxRow({ title: '신발', metrics: lxM3(B) }, itemCards('boots', B.rows('boots').slice(0, LX_ROW_MAX)), { empty: '타임라인 표본을 모으는 중' })
        + finalRows
        + coreRows
        + allItemsRow
        + `<div class="lx-foot">신발 · 인기 · 승률 · 전체 아이템은 <b>경기가 끝났을 때 들고 있던 6칸</b> 기준 · 1~6코어는 <b>구매 순서</b> 기준이라 중간에 팔았거나 모습이 바뀐 아이템(마나무네→무라마나)도 그 자리에 남는다</div>`);
    return spells + starting + sets + items;
}

function lxStartBody(c, v) {
    const B = c.B;
    if (v === 'set') {
        return lxRow({ title: '시작 세트', metrics: lxM3(B) }, B.rows('start').slice(0, 12).map(r => ({ icons: r.key.map(itemIconOf), title: r.key.map(itemNameOf).join(' + '), vals: lxVals3(B, 'start', r) })), { empty: '타임라인 표본을 모으는 중' });
    }
    // 낱개 — 세트를 펼쳐서 아이템마다 합친다
    const agg = new Map();
    B.rows('start').forEach(r => r.key.forEach(id => { const cur = agg.get(id) || { key: [id], games: 0, wins: 0 }; cur.games += r.games; cur.wins += r.wins; agg.set(id, cur); }));
    const list = [...agg.values()].sort((a, b) => b.games - a.games).slice(0, LX_ROW_MAX);
    return lxRow({ title: '시작 아이템', metrics: lxM3(B) }, list.map(r => ({ icons: [itemIconOf(r.key[0])], title: itemNameOf(r.key[0]), vals: lxVals3(B, 'start', r) })), { empty: '타임라인 표본을 모으는 중' });
}
function lxEarlyBody(c, v) {
    const B = c.B;
    const type = v === 'set' ? 'earlyset' : 'early';
    return lxRow({ title: v === 'set' ? '초반 세트' : '초반 아이템', metrics: lxM3(B) }, B.rows(type).slice(0, v === 'set' ? 12 : LX_ROW_MAX).map(r => ({ icons: r.key.map(itemIconOf), title: r.key.map(itemNameOf).join(' + '), vals: lxVals3(B, type, r) })), { empty: '타임라인 표본을 모으는 중' });
}

// ── 스킬 우선순위 상자 (전체 / 6 / 10 / 15레벨) ──────────────────────
function lxSkillBox(c) {
    const B = c.B;
    if (!B.has || !B.total || !B.tl) return '';   // ★ 타임라인(스킬 로그)이 없는 패치(16.16)는 상자째 안 그린다
    // ★★ 2026-09-09 개편 (사용자 요청, lolalytics 하단 스킬 구역 모양):
    //   ① 탭 위에 있던 「스킬 우선순위 + 4x18 격자」(lxSkillBuild)를 뺐다 — 그 내용이 아래
    //      「스킬 순서」 탭 안으로 들어왔다 (왼쪽 선마 순서 · 오른쪽 1~6레벨 표).
    //   ② 탭은 셋이다: 스킬 순서 · 11레벨 · 16레벨. R 을 찍는 6·11·16 이 기준점이라
    //      첫 탭이 6레벨까지를 표로 보여주고, 나머지 둘이 그 뒤 순서를 이어 받는다.
    return `<div class="lx-box" id="lx-skills">
        ${lxTabBar('skill', [{ v: 'skillpri', label: '스킬 순서' }, { v: 'skillord11', label: '11레벨' }, { v: 'skillord', label: '16레벨' }], 'skillpri')}
        <div class="lx-box-rows" id="lx-skill-body">${lxSkillBody(c, 'skillpri')}</div>
    </div>`;
}
// (lxSkillBuild — 탭 위에 있던 「스킬 우선순위 + 4x18 격자」는 2026-09-09 에 뺐다.
//  우선순위는 「스킬 순서」 탭 왼쪽으로 옮겼고, 격자는 같은 내용을 표가 대신한다.
//  되살리려면 git log 에서 이 자리 함수를 꺼내 lxSkillBox 안에서 부르면 된다)
// ★★ 레벨별 스킬 표 — 줄이 레벨, 열이 Q·W·E·R, 칸마다 승률·픽률·판수 (2026-09-09).
//   사용자가 가리킨 lolalytics 하단 스킬 구역의 오른쪽 판이 이 모양이다.
//   ★ `maxLv` 를 주면 그 레벨까지만 (스킬 순서 탭은 6레벨까지 — R 첫 포인트가 거기다).
//   ★ 안 찍은 칸은 「-」로 비워 둔다 (0% 를 적으면 표가 숫자로 꽉 차서 오히려 안 읽힌다).
//   ★ 픽률 분모는 다른 줄과 같은 `B.tl`(타임라인이 있는 판)이라 한 레벨의 합이 100% 근처가 된다
//     — 그 레벨까지 못 가고 끝난 판이 있어 딱 100 은 아니다.
function lxSkillLvTable(c, maxLv) {
    const B = c.B;
    const byLv = new Map();
    B.rows('skilllv').forEach(r => {
        const [lv, slot] = r.key;
        if (maxLv && lv > maxLv) return;
        if (!byLv.has(lv)) byLv.set(lv, {});
        byLv.get(lv)[slot] = r;
    });
    const lvs = [...byLv.keys()].sort((a, b) => a - b);
    if (!lvs.length) return `<div class="lx-none">타임라인 표본을 모으는 중</div>`;
    const cell = r => r
        ? `<td><b class="${lxWr(r.wins, r.games)}">${lxPct(r.wins, r.games)}%</b><span class="lx-lav">${lxPct(r.games, B.tl)}%</span><i>${r.games.toLocaleString()}</i></td>`
        : `<td class="is-none">-</td>`;
    return `<table class="lx-skt">
        <thead><tr><th>레벨</th>${[1, 2, 3, 4].map(n => `<th>${lxSkill(c, n, true)}</th>`).join('')}</tr></thead>
        <tbody>${lvs.map(lv =>
        `<tr><th>${lv}</th>${[1, 2, 3, 4].map(n => cell(byLv.get(lv)[n])).join('')}</tr>`).join('')}</tbody>
    </table>`;
}

function lxSkillBody(c, type) {
    const B = c.B;
    // ★★ 「스킬 순서」 탭 — 왼쪽 선마 순서, 오른쪽 1~6레벨 표 (2026-09-09 사용자 요청).
    //   lolalytics 하단 스킬 구역과 같은 배치다. 예전엔 우선순위를 가로 카드 줄로 그렸는데,
    //   좌우로 나누면 "무슨 순서로 선마하나" 와 "레벨마다 뭘 찍나" 를 한 화면에서 대조할 수 있다.
    //   ★ 오른쪽 표를 6레벨까지만 자르는 건 **R 첫 포인트가 6레벨**이라서다 — 그 뒤는 11·16레벨 탭이 받는다.
    if (type === 'skillpri') {
        const pri = B.rows('skillpri');
        // ★★ 왼쪽도 **표**다 (2026-09-09 사용자 요청) — 맨 윗줄에 승률·픽률·표본 수 이름을 달고
        //   그 아래로 값이 열을 맞춰 선다. 오른쪽 레벨 표와 **같은 `.lx-skt`** 를 쓰므로
        //   머리 높이·줄 높이가 저절로 같다 (줄 높이는 CSS 에서 60px 로 못 박아 뒀다).
        const left = pri.length
            ? `<table class="lx-skt lx-pri-tb">
                <thead><tr><th></th><th>승률</th><th>픽률</th><th>표본 수</th></tr></thead>
                <tbody>${pri.slice(0, 8).map(r => `
                    <tr>
                        <th class="lx-pri-ord">${r.key.map(n => lxSkill(c, n)).join('<span class="lx-arrow">›</span>')}</th>
                        <td><b class="${lxWr(r.wins, r.games)}">${lxPct(r.wins, r.games)}%</b></td>
                        <td><span class="lx-lav">${lxPct(r.games, B.tl)}%</span></td>
                        <td><i>${r.games.toLocaleString()}</i></td>
                    </tr>`).join('')}</tbody>
            </table>`
            : `<div class="lx-none">타임라인 표본을 모으는 중</div>`;
        return `<div class="lx-sk2">
            <div class="lx-sk2-col">${left}</div>
            <div class="lx-sk2-col">${lxSkillLvTable(c, 6)}</div>
        </div>`;
    }
    // ★★ 레벨별 — 「1레벨에 뭘 찍었나」를 레벨마다 한 줄로 (2026-09-09 사용자 요청).
    //   집계 key 가 `[레벨, 슬롯]` 이라 레벨로 묶고 그 안에서 픽률순으로 세운다.
    //   ★ 픽률 분모는 **어느 줄이나 `B.tl`(타임라인이 있는 판) 하나다** — 줄들끼리 견줄 수 있게 하려고
    //     일부러 통일해 뒀다 (2026-09-09 사용자 결정, 한 번 「도달자 수」로 바꿨다가 되돌렸다).
    //   ★★ 그래서 **11·16레벨 탭은 픽률 합이 100% 에 한참 못 미친다** — 그 레벨까지 간 사람이
    //     리 신 정글 기준 11,993명 중 3,909명(16레벨)뿐이라 합이 30% 쯤이다. 버그가 아니다.
    //     같은 이유로 **그 탭의 승률도 통째로 높다** (도달자 66.49% vs 챔피언 전체 50.70%) —
    //     레벨이 높다는 게 곧 이기고 있었다는 뜻이라서다. 근거는 CLAUDE.md 9/9 절에.
    //   ★ 모양은 **표**다 (2026-09-09, 사용자가 lolalytics 하단 스킬 구역을 가리켰다) —
    //     줄이 레벨, 열이 Q·W·E·R, 칸마다 승률·픽률·판수. 줄마다 카드를 늘어놓는 것보다
    //     "같은 레벨에서 뭘 골랐나" 와 "레벨이 오르며 어떻게 바뀌나" 가 한눈에 보인다.
    //   ★ 안 찍은 칸은 「-」로 비워 둔다 (0% 를 적으면 표가 숫자로 꽉 차서 오히려 안 읽힌다)

    // 레벨별 스킬 순서 — 세로로 한 줄씩 (순서 + 승률·픽률·판수)
    const list = B.rows(type).slice(0, LX_SEQ_MAX);   // ★ 12 = 집계가 칸마다 담는 상한(BUILD_TOP_N) 과 같다
    if (!list.length) return `<div class="lx-none">타임라인 표본을 모으는 중</div>`;
    return `<div class="lx-seq-list">${list.map(r => `
        <div class="lx-seq">
            <!-- ★ 글자 칸 대신 **스킬 아이콘**이다 (2026-09-09 사용자 요청). 아이콘 우하단의 작은
                 QWER 딱지는 lxSkill 이 원래 붙이는 것이라 무엇을 찍었는지 그대로 읽힌다.
                 ★ 몇 레벨인지는 **자리 순서**가 말해 준다 — 툴팁(title)은 안 붙인다 (같은 요청) -->
            <div class="lx-seq-cells">${r.key.map(n => lxSkill(c, n, true)).join('')}</div>
            <div class="lx-seq-vals"><span class="${lxWr(r.wins, r.games)}">${lxPct(r.wins, r.games)}%</span><span class="lx-lav">${lxPct(r.games, B.tl)}%</span><span class="lx-gray">${r.games.toLocaleString()}판</span></div>
        </div>`).join('')}</div>`;
}

// ── 룬 상자 (전체 / 승률 최고 룬 페이지 / 인기 룬 페이지) ───────────────
function lxRuneBox(c) {
    const B = c.B;
    if (!B.has || !B.total) return '';
    return `<div class="lx-box" id="lx-runes">
        ${lxTabBar('rune', [{ v: 'all', label: '전체' }, { v: 'win', label: '승률 최고' }, { v: 'common', label: '픽률 최고' }, { v: 'combo', label: '조합별 승률' }], 'all')}
        <div id="lx-rune-body">${lxRuneBody(c, 'all')}</div>
    </div>`;
}
// ★ 룬 표 — 계열 5개 + 파편을 인게임 배치로, 룬마다 픽률(위)·승률(아래).
//   탭: 전체 = 다 밝게 / 승률 최고 · 픽률 최고 = **줄마다 그 값이 가장 높은 칸만 밝게**, 나머지는 어둡게 (2026-08-27, 사용자 요청).
//   승률 최고는 표본이 얇은 칸이 100% 로 튀지 않게 "그 줄 1위 판수의 10% 이상(최소 5판)" 인 칸 중에서 고른다.
function lxRuneBody(c, v) {
    const B = c.B;
    // ★ 조합별 승률 — 서버가 저장한 룬 페이지 조합(판수 상위 12개, 2판 이상)을 픽률 순으로 (2026-08-27, 사용자 요청).
    //   승률 최고 탭이 "이 12개 중 최고" 인 이유가 여기서 보인다. 파편은 조합 키에 없어서 안 그린다.
    if (v === 'combo') {
        const list = B.rows('rune');
        if (!list.length) return `<div class="lx-none">표본 없음</div>`;
        const img = (id, cls) => `<img class="build-perk ${cls || ''}" src="${perkIcon(id)}" alt="" title="${perkName(id)}" loading="lazy">`;
        return `<div class="lx-combos">
            <div class="lx-combo lx-combo-head"><span class="lx-combo-page">룬 페이지 (픽률 순)</span><span>픽률</span><span>승률</span><span>표본 수</span></div>
            ${list.map(r => {
                const [ps, ks, m1, m2, m3, ss, s1, s2] = r.key;
                const sec = perksBySlot(ss, [s1, s2]);
                return `<div class="lx-combo">
                    <span class="lx-combo-page build-runes">
                        <img class="build-style" src="${perkIcon(ps)}" alt="" title="${perkName(ps)}">${img(ks, 'build-perk-key')}${[m1, m2, m3].map(x => img(x)).join('')}
                        <span class="build-div"></span>
                        <img class="build-style" src="${perkIcon(ss)}" alt="" title="${perkName(ss)}">${sec.map(x => img(x)).join('')}
                    </span>
                    <span class="lx-lav">${lxPct(r.games, B.total)}%</span>
                    <span class="${lxWr(r.wins, r.games)}">${lxPct(r.wins, r.games)}%</span>
                    <span class="lx-gray">${r.games}</span>
                </div>`;
            }).join('')}
        </div>`;
    }
    // ★ 룬은 key [id], 파편은 key [id, 줄] (2026-08-27 — 적응형·체력이 두 줄에 있어 id 로만 세면 픽률이 100% 를 넘었다).
    //   줄 번호 있는 줄이 아직 없으면(재집계 전) 옛 id 값으로 물러난다
    const perk = {}, perkRow = [{}, {}, {}];
    B.rows('perk').forEach(r => { if (r.key.length > 1) perkRow[r.key[1]][r.key[0]] = r; else perk[r.key[0]] = r; });
    if (!Object.keys(perk).length) return `<div class="lx-none">룬별 통계는 다음 집계부터 나옵니다.</div>`;

    // ★★ 최고 탭은 "줄마다 최고" 가 아니라 **실제로 같이 찍힌 룬 페이지 하나**다 (2026-08-27, 사용자 지적).
    //   룬은 마구 찍는 게 아니라 핵심 룬 1 + 주 계열 줄마다 1 (=4) + 부 계열 한 곳에서 2 = **6개**가 한 페이지고,
    //   줄마다 최고를 따로 뽑으면 실제로 존재하지 않는 조합이 된다. 그래서 `rune` 조합 집계에서
    //   승률 최고(표본 하한 있음) / 픽률 최고 페이지 하나를 골라 그 6칸만 밝힌다. 파편은 그 페이지와 같은 기준으로 고른 `shard` 조합 3개.
    // ★ 표본 하한 없이 고른다 (2026-08-27 사용자 지시) — 조합 줄(판수 2 이상, 상위 12개) 중 승률/판수 최고 그대로
    const pickPage = type => {
        const list = B.rows(type);
        if (!list.length) return null;
        return v === 'win' ? [...list].sort((x, y) => y.wins / y.games - x.wins / x.games || y.games - x.games)[0] : list[0];
    };
    const page = v === 'all' ? null : pickPage('rune');
    const shardPick = v === 'all' ? null : pickPage('shard');
    const bright = new Set(page ? [page.key[1], page.key[2], page.key[3], page.key[4], page.key[6], page.key[7]] : []);
    const shards = (shardPick && shardPick.key) || [];
    const cell = (id, on, ri) => {
        const r = (ri != null && perkRow[ri][id]) || perk[id];
        const dim = v !== 'all' && !on;
        return `<div class="lx-pk${r ? '' : ' is-none'}${dim ? ' is-dim' : ''}${v !== 'all' && on ? ' is-best' : ''}">
            <img src="${perkIcon(id)}" alt="" title="${perkName(id)}" loading="lazy">
            <div class="lx-v lx-lav">${r ? lxPct(r.games, B.total) : '-'}</div>
            <div class="lx-v ${r ? lxWr(r.wins, r.games) : 'lx-dim'}">${r ? lxPct(r.wins, r.games) : '-'}</div>
        </div>`;
    };
    // 파편은 자리로 켠다 — 같은 파편이 두 줄에 있어 id 로 켜면 두 칸이 켜진다
    const rowHtml = (row, cls, ri) => `<div class="lx-pk-row${cls}">${row.map(id => cell(id, ri == null ? bright.has(id) : shards[ri] === id, ri)).join('')}</div>`;
    const pageLine = '';   // 표 위 '승률 최고 룬 페이지 — …' 줄은 2026-08-27 에 뺐다 (사용자 지시)
    const styles = Object.keys(perkData.slots || {}).map(Number).sort((a, b) => a - b);
    return pageLine + `<div class="lx-pk-trees">
        ${styles.map(sid => `<div class="lx-pk-tree">
            <div class="lx-pk-title"><img src="${perkIcon(sid)}" alt="">${perkName(sid)}</div>
            ${(perkData.slots[sid] || []).map((row, i) => rowHtml(row, i === 0 ? ' is-key' : '', null)).join('')}
        </div>`).join('')}
        <div class="lx-pk-tree lx-pk-shards">
            <div class="lx-pk-title">스탯 파편</div>
            ${(perkData.shardRows || []).map((row, ri) => rowHtml(row, ' is-shard', ri)).join('')}
        </div>
    </div>`;
}

// ── 탭 바 동작 — 그룹마다 몸통을 다시 그린다 ─────────────────────────
function lxBindTabs(root, c) {
    const handlers = {
        'mu-counter': v => { root.querySelectorAll('[data-group="mu-synergy"] .lx-tabbtn').forEach(b => b.classList.remove('active')); const el = document.getElementById('lx-mu-rows'); if (el) el.innerHTML = lxMatchupRows(c, 'counter', v); },
        'mu-synergy': v => { root.querySelectorAll('[data-group="mu-counter"] .lx-tabbtn').forEach(b => b.classList.remove('active')); const el = document.getElementById('lx-mu-rows'); if (el) el.innerHTML = lxMatchupRows(c, 'synergy', v); },
        'start': v => { document.getElementById('lx-start-body').innerHTML = lxStartBody(c, v); },
        'early': v => { document.getElementById('lx-early-body').innerHTML = lxEarlyBody(c, v); },
        'sets': v => {
            const B = c.B;
            document.getElementById('lx-sets-body').innerHTML = lxRow({ title: '세트', metrics: lxM3(B) },
                B.rows(v).slice(0, 12).map(r => ({ icons: r.key.map(itemIconOf), title: r.key.map(itemNameOf).join(' › '), vals: lxVals3(B, v, r) })), { empty: '타임라인 표본을 모으는 중' });
        },
        'skill': v => { document.getElementById('lx-skill-body').innerHTML = lxSkillBody(c, v); },
        'rune': v => { document.getElementById('lx-rune-body').innerHTML = lxRuneBody(c, v); }
    };
    root.addEventListener('click', (e) => {
        const btn = e.target.closest('.lx-tabbtn');
        if (!btn) return;
        const bar = btn.closest('.lx-tabbar');
        const group = bar.dataset.group;
        bar.querySelectorAll('.lx-tabbtn').forEach(b => b.classList.toggle('active', b === btn));
        if (handlers[group]) handlers[group](btn.dataset.val);
    });
}


// ==========================================
//  패치 영향 페이지 (2026-09-01, 로드맵 A-3) — /stats/patch
//    패치를 고르면 그 패치에서 실제로 바뀐 챔피언이 초상화로 뜨고,
//    초상화를 누르면 직전 패치 대비 승률·픽률·밴률 비교(합계 + 일별 그래프)가 열린다.
//    · 바뀐 챔피언 목록 = public/patch_changes.js (build_patch_changes.js 가 패치 때 만든다. 지연 로드)
//    · 통계 = /api/patch-impact (champstats 패치 scope 두 개 + 일별 scope. 집계 추가 0)
//    ★ 직전 패치의 일별 자료가 보관 기간(42일) 밖이면 그 구간은 점선(패치 전체 평균)만 나온다 —
//      16.17 페이지의 16.16 쪽이 그렇다. 다음 패치부터는 양쪽 다 꺾은선이 나온다.
// ==========================================
const PI_MIN_GAMES = 100;   // 승률 ▲▼ 를 믿고 보여줄 최소 표본 (양쪽 패치 각각 · 2026-09-01 사용자 결정)

let patchChangesPromise = null;
function loadPatchChanges() {
    if (patchChangesPromise) return patchChangesPromise;
    const tag = document.querySelector('script.lazy-patch-changes[data-src]');
    if (!tag) return Promise.reject(new Error('patch_changes.js 태그가 없습니다.'));
    patchChangesPromise = new Promise((done, fail) => {
        const s = document.createElement('script');
        s.async = false;
        s.src = tag.dataset.src;      // ?v=mtime 은 server.js 가 붙여 놨다 (도감과 같은 규약)
        s.onload = done;
        s.onerror = fail;
        document.head.appendChild(s);
    }).then(() => {
        if (typeof patchChanges === 'undefined') throw new Error('바뀐 챔피언 목록을 받지 못했습니다.');
        return patchChanges;
    });
    patchChangesPromise.catch(() => { patchChangesPromise = null; });
    return patchChangesPromise;
}

let piVer = null;      // 고른 패치 (patch_changes 의 키 — 내부 표기 16.x)
let piChamp = null;    // 고른 챔피언 (영문 키)

async function showPatchImpact() {
    if (window.location.pathname !== '/stats/patch') window.history.pushState({ page: 'patch-impact' }, '', '/stats/patch');
    hideAllContainers();
    setActiveNav('nav-stats-patch');
    const box = document.getElementById('patch-impact-container');
    box.style.display = 'block';
    box.innerHTML = `<div class="pi-head"><h1 class="ranking-title">패치 영향</h1></div>
        <div class="skel" style="height:140px;border-radius:12px;margin-bottom:16px"></div>
        <div class="skel" style="height:300px;border-radius:12px"></div>`;

    let pc = null;
    try { [pc] = await Promise.all([loadPatchChanges(), fetchChampionMap()]); } catch (e) { }
    // ★ 그리는 사이에 다른 화면으로 옮겼으면 버린다 (느린 응답이 새 화면을 덮지 않게)
    if (window.location.pathname !== '/stats/patch') return;
    if (!pc || !Object.keys(pc).length) {
        box.innerHTML = `<div class="pi-head"><h1 class="ranking-title">패치 영향</h1></div>
            <div class="stats-empty">바뀐 챔피언 목록을 불러오지 못했습니다.</div>`;
        return;
    }
    const versions = Object.keys(pc);   // build_patch_changes.js 가 내림차순으로 적는다
    if (!versions.includes(piVer)) piVer = versions[0];
    if (piChamp && !pc[piVer].champs[piChamp]) piChamp = null;
    renderPatchImpactPage(box, pc);
}

function piFlagLabel(flags) {
    if (flags.includes('n')) return '신규';
    const parts = [];
    if (flags.includes('v') || flags.includes('t')) parts.push('스킬');
    if (flags.includes('s')) parts.push('기본 스탯');
    if (!parts.length) return '아이콘만';
    return parts.join(' · ');
}

function renderPatchImpactPage(box, pc) {
    const versions = Object.keys(pc);
    const entry = pc[piVer];
    const opts = versions.map(v =>
        `<option value="${v}"${v === piVer ? ' selected' : ''}>${patchDisplay(v)} 패치</option>`).join('');

    // 초상화 정렬: 신규 → 스킬·스탯 변경 → 아이콘만(흐림). 같은 무리 안에서는 한글 이름순
    const items = Object.entries(entry.champs).map(([eng, flags]) => ({
        eng, flags,
        name: window.korChampMap[eng] || eng,
        rank: flags.includes('n') ? 0 : flags === 'i' ? 2 : 1
    })).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'ko'));

    const grid = items.map(it => `
        <button class="pi-champ${it.rank === 2 ? ' is-icon' : ''}${it.eng === piChamp ? ' on' : ''}" data-champ="${it.eng}" type="button">
            <img src="${champIconUrl(it.eng)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <span class="pi-champ-name">${it.name}</span>
            <span class="pi-champ-tag">${piFlagLabel(it.flags)}</span>
        </button>`).join('');

    box.innerHTML = `
        <div class="pi-head">
            <h1 class="ranking-title">패치 영향</h1>
            <select class="stats-select" id="pi-ver">${opts}</select>
        </div>
        <p class="pi-sub">이 패치에서 실제로 데이터가 바뀐 챔피언입니다. 초상화를 누르면 직전 패치와의 승률·픽률·밴률 비교가 열립니다.
            <span class="pi-sub-dim">마스터+ 솔로랭크 · ${entry.date} 반영</span></p>
        <div class="pi-grid">${grid}</div>
        <div id="pi-detail"></div>`;

    box.querySelector('#pi-ver').addEventListener('change', (e) => {
        piVer = e.target.value;
        piChamp = null;
        renderPatchImpactPage(box, pc);
    });
    box.querySelector('.pi-grid').addEventListener('click', (e) => {
        const btn = e.target.closest('.pi-champ[data-champ]');
        if (!btn) return;
        piChamp = btn.dataset.champ;
        box.querySelectorAll('.pi-champ.on').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        loadPatchImpactDetail(pc);
    });
    if (piChamp) loadPatchImpactDetail(pc);
}

async function loadPatchImpactDetail(pc) {
    const el = document.getElementById('pi-detail');
    if (!el || !piChamp) return;
    const eng = piChamp, ver = piVer;
    el.innerHTML = `<div class="skel" style="height:280px;border-radius:12px"></div>`;

    // 영문 키 → 숫자 id (championIdMap 은 id → 영문 키라 뒤집어 찾는다)
    const champId = Number(Object.keys(championIdMap).find(k => championIdMap[k] === eng));
    if (!Number.isFinite(champId)) {
        el.innerHTML = `<div class="stats-empty">챔피언 정보를 찾지 못했습니다.</div>`;
        return;
    }

    let d = null;
    try {
        d = await (await fetch(`/api/patch-impact?champ=${champId}&scope=${encodeURIComponent('p:' + ver)}`)).json();
    } catch (e) { }
    // ★ 느린 응답이 새 선택을 덮지 않게 — 그 사이 챔피언·패치·화면을 바꿨으면 버린다
    if (piChamp !== eng || piVer !== ver || window.location.pathname !== '/stats/patch') return;
    const now = document.getElementById('pi-detail');
    if (!now) return;
    if (!d || !d.ready) {
        now.innerHTML = `<div class="stats-empty">통계를 불러오지 못했습니다.</div>`;
        return;
    }
    now.innerHTML = piDetailHtml(d, pc, eng);
    now.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function piDetailHtml(d, pc, eng) {
    const name = window.korChampMap[eng] || eng;
    const versions = Object.keys(pc);
    const idx = versions.indexOf(piVer);
    const nextDate = idx > 0 ? pc[versions[idx - 1]].date : null;              // 다음 패치 시작일 = 이 패치 구간의 끝
    const prevVer = versions[idx + 1] || null;
    const fromDate = (prevVer && pc[prevVer].date) || pc[piVer].date;          // 직전 패치 시작일부터 (기록이 없으면 이 패치부터)
    const boundary = pc[piVer].date;

    const days = (d.days || []).filter(x => x.day >= fromDate && (!nextDate || x.day < nextDate));

    const cur = d.cur, prev = d.prev;
    const rate = (num, den) => den > 0 ? num / den * 100 : null;
    const curWin = rate(cur.wins, cur.games), prevWin = prev ? rate(prev.wins, prev.games) : null;
    const curPick = rate(cur.games, cur.total), prevPick = prev ? rate(prev.games, prev.total) : null;
    const curBan = rate(cur.bans, cur.total), prevBan = prev ? rate(prev.bans, prev.total) : null;

    // ▲▼ — 승률만 표본 가드가 있다 (패치 초반 40판짜리 62% 는 내일이면 다른 숫자다)
    const deltaHtml = (c, p, guarded) => {
        if (typeof c !== 'number' || typeof p !== 'number') return '';
        if (guarded) return `<span class="pi-delta na" data-tooltip="양쪽 패치 각 ${PI_MIN_GAMES}판 이상 쌓이면 표시합니다">표본 부족</span>`;
        const diff = c - p;
        if (Math.abs(diff) < 0.05) return `<span class="pi-delta flat">—</span>`;
        return `<span class="pi-delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(1)}%p</span>`;
    };
    const winGuarded = !(cur.games >= PI_MIN_GAMES && prev && prev.games >= PI_MIN_GAMES);

    const prevLabel = d.prevScope ? patchDisplay(d.prevScope.slice(2)) : null;
    const fmtV = v => typeof v === 'number' ? v.toFixed(1) + '%' : '-';
    const mkPts = (fn) => days.map(x => {
        const v = fn(x);
        return typeof v === 'number'
            ? { day: x.day, v, tip: `${x.day.slice(5).replace('-', '.')} · ${v.toFixed(2)}% (${x.games}판)` }
            : null;
    }).filter(Boolean);

    const boxes = [
        piGraphHtml({ title: '승률', pts: mkPts(x => x.games > 0 ? x.wins / x.games * 100 : null),
            prevAvg: prevWin, prevLabel, boundary, valueHtml: `${fmtV(curWin)} ${deltaHtml(curWin, prevWin, winGuarded)}` }),
        piGraphHtml({ title: '픽률', pts: mkPts(x => x.total > 0 ? x.games / x.total * 100 : null),
            prevAvg: prevPick, prevLabel, boundary, valueHtml: `${fmtV(curPick)} ${deltaHtml(curPick, prevPick, false)}` }),
        piGraphHtml({ title: '밴률', pts: mkPts(x => x.total > 0 ? x.bans / x.total * 100 : null),
            prevAvg: prevBan, prevLabel, boundary, valueHtml: `${fmtV(curBan)} ${deltaHtml(curBan, prevBan, false)}` })
    ].join('');

    const sample = `${patchDisplay(piVer)} 패치 ${cur.games.toLocaleString()}판`
        + (prev ? ` · ${prevLabel} 패치 ${prev.games.toLocaleString()}판` : '');
    const noPrevDaily = prev && !days.some(x => x.day < boundary);

    return `<div class="pi-detail-card">
        <div class="pi-detail-head">
            <img class="pi-detail-portrait" src="${champIconUrl(eng)}" alt="">
            <div>
                <div class="pi-detail-name">${name}</div>
                <div class="pi-detail-sub">${sample}</div>
            </div>
        </div>
        ${noPrevDaily ? `<p class="pi-note">직전 패치(${prevLabel}) 구간의 일별 기록은 보관 기간이 지나 없습니다 — 점선이 그 패치의 전체 평균입니다.</p>` : ''}
        <div class="pi-boxes">${boxes}</div>
    </div>`;
}

// 그래프 한 장 — 컷라인 그래프와 같은 골격 (SVG 는 선만, 점·글자는 HTML 절대배치.
// viewBox 를 가로로 늘리므로 글자를 SVG 에 넣으면 찌그러진다 — 그 함정 그대로다)
function piGraphHtml(cfg) {
    const pts = cfg.pts || [];
    const head = `<div class="pi-box-head"><span class="pi-box-title">${cfg.title}</span><span class="pi-box-val">${cfg.valueHtml || ''}</span></div>`;
    if (!pts.length) return `<div class="pi-box">${head}<div class="pi-box-empty">이 패치의 일별 표본이 아직 없습니다.</div></div>`;

    const vals = pts.map(p => p.v).concat(typeof cfg.prevAvg === 'number' ? [cfg.prevAvg] : []);
    const vMax = Math.max(...vals), vMin = Math.min(...vals);
    const span = vMax - vMin;
    const pad = span > 0 ? span * 0.25 : Math.max(0.5, vMax * 0.1);
    const lo = Math.max(0, vMin - pad), hi = vMax + pad;
    const n = pts.length;
    const X = (i) => n === 1 ? 50 : (i / (n - 1)) * 100;
    const Y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;

    const line = n > 1
        ? `<polyline class="pi-line" points="${pts.map((p, i) => X(i).toFixed(2) + ',' + Y(p.v).toFixed(2)).join(' ')}"/>` : '';
    // 직전 패치 평균 점선 — 일별 기록이 지워진 구간을 대신하는 기준선
    const avg = typeof cfg.prevAvg === 'number'
        ? `<line class="pi-avg" x1="0" x2="100" y1="${Y(cfg.prevAvg).toFixed(2)}" y2="${Y(cfg.prevAvg).toFixed(2)}"/>` : '';
    // 패치 경계 세로선 — 경계 앞뒤에 점이 다 있을 때만 (다음 패치부터 나온다)
    let bound = '';
    if (cfg.boundary) {
        const bi = pts.findIndex(p => p.day >= cfg.boundary);
        if (bi > 0) {
            const bx = ((X(bi) + X(bi - 1)) / 2).toFixed(2);
            bound = `<line class="pi-bound" x1="${bx}" x2="${bx}" y1="0" y2="100"/>`;
        }
    }
    const dots = pts.map((p, i) =>
        `<span class="pi-dot" style="left:${X(i).toFixed(2)}%; top:${Y(p.v).toFixed(2)}%" data-tip="${p.tip}"></span>`).join('');
    const yLabels = `<span class="pi-y" style="top:${Y(vMax).toFixed(2)}%">${vMax.toFixed(1)}</span>`
        + (span > 0 ? `<span class="pi-y" style="top:${Y(vMin).toFixed(2)}%">${vMin.toFixed(1)}</span>` : '');
    const avgLabel = (typeof cfg.prevAvg === 'number' && cfg.prevLabel)
        ? `<span class="pi-avg-label" style="top:${Y(cfg.prevAvg).toFixed(2)}%">${cfg.prevLabel} 평균 ${cfg.prevAvg.toFixed(1)}%</span>` : '';

    return `<div class="pi-box">
        ${head}
        <div class="pi-plot">
            <svg class="pi-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${avg}${bound}${line}</svg>
            ${dots}${yLabels}${avgLabel}
        </div>
        <div class="pi-axis"><span>${pts[0].day.slice(5).replace('-', '.')}</span><span>${pts[n - 1].day.slice(5).replace('-', '.')}</span></div>
    </div>`;
}

// ==========================================
//  조합 페이지 (2026-09-01, 로드맵 A-1) — /stats/duo
//    아군 두 라인 짝(원딜+서폿 · 탑+정글 · 미드+정글)의 승률 표.
//    자료는 champmatchups 의 아군 짝(rel 1) — 집계 추가 0, 지난 패치 소급됨.
// ==========================================
const DUO_TABS = [
    { key: 'bot',   name: '원딜 + 서포터', a: 3, b: 4 },
    { key: 'topjg', name: '탑 + 정글',     a: 0, b: 1 },
    { key: 'midjg', name: '미드 + 정글',   a: 2, b: 1 }
];
// ★ 표본 컷 (2026-09-01 사용자 결정 30판). 30판 미만은 승률이 튀어서 표에서 아예 뺀다
//   (통계 탭 라인 필터와 같은 규칙 — 흐림이 아니라 제외).
const DUO_SHOW_MIN = 30;
let duoTab = 'bot';
let duoSort = { col: 'wr', dir: 'desc' };

async function showDuoPage(tabKey) {
    if (DUO_TABS.some(t => t.key === tabKey)) duoTab = tabKey;
    if (!window.location.pathname.startsWith('/stats/duo')) {
        window.history.pushState({ page: 'duo' }, '', '/stats/duo');
    }
    // 탭은 주소에 담되 이력은 덮어쓴다 (사이트 공통 규칙 — 기본 탭이면 /stats/duo 그대로)
    const want = duoTab === 'bot' ? '/stats/duo' : `/stats/duo/${duoTab}`;
    if (window.location.pathname !== want) window.history.replaceState({ page: 'duo' }, '', want);

    hideAllContainers();
    setActiveNav('nav-stats-duo');
    const box = document.getElementById('duo-container');
    box.style.display = 'block';
    box.innerHTML = `<div class="pi-head"><h1 class="ranking-title">조합</h1></div>${skelTableHtml(12, 52)}`;

    await fetchChampionMap();
    let d = null;
    try {
        const scopeQ = window.statScope ? `&scope=${encodeURIComponent(window.statScope)}` : '';
        d = await (await fetch(`/api/champion-duos?combo=${duoTab}${scopeQ}`)).json();
    } catch (e) { }
    if (!window.location.pathname.startsWith('/stats/duo')) return;   // 그리는 사이 다른 화면으로 갔으면 버린다
    if (!d || !d.ready) {
        box.innerHTML = `<div class="pi-head"><h1 class="ranking-title">조합</h1></div>
            <div class="stats-empty">아직 표본을 모으는 중입니다.</div>`;
        return;
    }
    window.statScope = d.scope;
    renderDuoPage(box, d);
}

function renderDuoPage(box, d) {
    const scopeOpts = scopeOptionsHtml(d.scopes, d.scope);
    const tabs = DUO_TABS.map(t =>
        `<button class="duo-tab${t.key === duoTab ? ' active' : ''}" data-tab="${t.key}" type="button">${t.name}</button>`).join('');

    const combo = DUO_TABS.find(t => t.key === duoTab);
    const rows = (d.rows || [])
        .filter(r => r.games >= DUO_SHOW_MIN)
        .map(r => ({
            a: r.champ, b: r.foe, games: r.games,
            wr: r.games > 0 ? r.wins / r.games * 100 : 0,
            pick: d.total > 0 ? r.games / d.total * 100 : 0
        }));
    const dir = duoSort.dir === 'desc' ? -1 : 1;
    rows.sort((x, y) => (x[duoSort.col] - y[duoSort.col]) * dir || y.games - x.games);

    const th = (col, label) => {
        const on = duoSort.col === col;
        return `<th class="sortable-th${on ? ' active' : ''}" data-col="${col}">${label} <span class="sort-icon">${on && duoSort.dir === 'asc' ? '▲' : '▼'}</span></th>`;
    };
    const champCell = (id) => {
        const eng = championIdMap[id];
        const name = window.korChampMap[eng] || eng || '?';
        return { eng, name };
    };
    const body = rows.length ? rows.map((r, i) => {
        const A = champCell(r.a), B = champCell(r.b);
        return `<tr>
            <td class="duo-rank">${i + 1}</td>
            <td class="duo-pair">
                <span class="duo-champ" data-eng="${A.eng}" data-lane="${combo.a}"><img src="${champIconUrl(A.eng)}" alt="" loading="lazy">${A.name}</span>
                <span class="duo-plus">+</span>
                <span class="duo-champ" data-eng="${B.eng}" data-lane="${combo.b}"><img src="${champIconUrl(B.eng)}" alt="" loading="lazy">${B.name}</span>
            </td>
            <td class="duo-num">${r.wr.toFixed(1)}%</td>
            <td class="duo-num">${r.pick.toFixed(2)}%</td>
            <td class="duo-num duo-games">${r.games.toLocaleString()}</td>
        </tr>`;
    }).join('') : `<tr><td colspan="5" class="duo-empty-row">표본 ${DUO_SHOW_MIN}판을 넘는 조합이 아직 없습니다.</td></tr>`;

    box.innerHTML = `
        <div class="pi-head">
            <h1 class="ranking-title">조합</h1>
            <select class="stats-select" id="duo-scope">${scopeOpts}</select>
        </div>
        <p class="pi-sub">같은 팀에서 함께 뛴 두 라인의 승률입니다. 표본 ${DUO_SHOW_MIN}판 이상만 싣습니다.
            <span class="pi-sub-dim">마스터+ 솔로랭크 · ${statScopeLabel(d.scope)} · ${d.total.toLocaleString()}판 · ${rows.length}쌍</span></p>
        <div class="duo-tabs">${tabs}</div>
        <div class="stats-table-wrapper">
            <table class="stats-table duo-table">
                <thead><tr>
                    <th>#</th>
                    <th style="text-align:left; padding-left:20px;">조합</th>
                    ${th('wr', '승률')}${th('pick', '픽률')}${th('games', '표본')}
                </tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>`;

    box.querySelector('#duo-scope').addEventListener('change', (e) => {
        window.statScope = e.target.value;
        showDuoPage(duoTab);
    });
    box.querySelector('.duo-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.duo-tab[data-tab]');
        if (btn && btn.dataset.tab !== duoTab) showDuoPage(btn.dataset.tab);
    });
    box.querySelector('.duo-table thead').addEventListener('click', (e) => {
        const h = e.target.closest('.sortable-th[data-col]');
        if (!h) return;
        const col = h.dataset.col;
        if (duoSort.col === col) duoSort.dir = duoSort.dir === 'desc' ? 'asc' : 'desc';
        else duoSort = { col, dir: 'desc' };
        renderDuoPage(box, d);
    });
    // 챔피언을 누르면 그 라인의 상세 페이지로 (통계 표의 줄 클릭과 같은 규약)
    box.querySelector('.duo-table tbody').addEventListener('click', (e) => {
        const c = e.target.closest('.duo-champ[data-eng]');
        if (!c || !c.dataset.eng) return;
        const lane = STAT_POS.find(p => p.code === Number(c.dataset.lane))?.key;
        const url = lane ? `/stats/${c.dataset.eng}/${lane}` : `/stats/${c.dataset.eng}`;
        window.history.pushState({ page: 'stats', champ: c.dataset.eng, lane }, '', url);
        showChampStatPage(c.dataset.eng, lane);
        setActiveNav('nav-stats-live');
    });
}

// ==========================================
//  픽률 추이 페이지 (2026-09-01) — /stats/trend
//    라인 하나를 골라 챔피언들의 일자별 픽률 꺾은선을 겹쳐 본다.
//    자료는 일별 champstats (보관 42일 — 2026-08-26 부터 쌓여 날마다 길어진다).
// ==========================================
const TREND_COLORS = ['#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#c4b5fd'];
const TREND_DEFAULT_N = 8;    // 처음에 그리는 상위 챔피언 수
const TREND_MAX_N = 10;       // 그 이상은 색도 모자라고 못 읽는다
let trendLane = 'top';
const trendSel = {};          // laneKey → [champId…] (탭마다 고른 목록을 세션 동안 기억)

async function showTrendPage(laneKey) {
    if (STAT_POS.some(p => p.key === laneKey)) trendLane = laneKey;
    if (!window.location.pathname.startsWith('/stats/trend')) {
        window.history.pushState({ page: 'trend' }, '', '/stats/trend');
    }
    const want = trendLane === 'top' ? '/stats/trend' : `/stats/trend/${trendLane}`;
    if (window.location.pathname !== want) window.history.replaceState({ page: 'trend' }, '', want);

    hideAllContainers();
    setActiveNav('nav-stats-trend');
    const box = document.getElementById('trend-container');
    box.style.display = 'block';
    box.innerHTML = `<div class="pi-head"><h1 class="ranking-title">픽률 추이</h1></div>
        <div class="skel" style="height:420px;border-radius:12px"></div>`;

    await fetchChampionMap();
    const pos = STAT_POS.find(p => p.key === trendLane).code;
    let d = null;
    try { d = await (await fetch(`/api/lane-trend?pos=${pos}`)).json(); } catch (e) { }
    if (!window.location.pathname.startsWith('/stats/trend')) return;
    if (!d || !d.ready || !d.days?.length) {
        box.innerHTML = `<div class="pi-head"><h1 class="ranking-title">픽률 추이</h1></div>
            <div class="stats-empty">아직 일별 표본을 모으는 중입니다.</div>`;
        return;
    }

    // 기본 선택 = 최근 3일 평균 픽률 상위 N (마지막 날은 수집 중이라 하루만 보면 튄다)
    const lastN = Math.min(3, d.days.length);
    const recent = (g) => {
        let games = 0, total = 0;
        for (let i = d.days.length - lastN; i < d.days.length; i++) { games += g[i]; total += d.days[i].total; }
        return total > 0 ? games / total : 0;
    };
    const ranked = d.rows.map(r => ({ c: r.c, v: recent(r.g) })).sort((a, b) => b.v - a.v);
    if (!trendSel[trendLane]) trendSel[trendLane] = ranked.slice(0, TREND_DEFAULT_N).map(r => r.c);

    renderTrendPage(box, d, ranked);
}

function renderTrendPage(box, d, ranked) {
    const sel = trendSel[trendLane];
    const nameOf = (id) => window.korChampMap[championIdMap[id]] || championIdMap[id] || '?';

    const tabs = STAT_POS.map(p =>
        `<button class="duo-tab${p.key === trendLane ? ' active' : ''}" data-lane="${p.key}" type="button">
            <img src="${STAT_LANE_ICON[p.key]}" alt="">${p.name}</button>`).join('');

    const chips = sel.map((id, i) =>
        `<button class="lt-chip" data-champ="${id}" type="button" title="빼기">
            <i style="background:${TREND_COLORS[i % TREND_COLORS.length]}"></i>${nameOf(id)} ×</button>`).join('');
    const addOpts = ranked.filter(r => !sel.includes(r.c)).map(r =>
        `<option value="${r.c}">${nameOf(r.c)} (${(r.v * 100).toFixed(1)}%)</option>`).join('');
    const addSel = sel.length >= TREND_MAX_N
        ? `<span class="lt-full">최대 ${TREND_MAX_N}명까지</span>`
        : `<select class="stats-select lt-add" id="lt-add"><option value="">+ 챔피언 추가</option>${addOpts}</select>`;

    box.innerHTML = `
        <div class="pi-head"><h1 class="ranking-title">픽률 추이</h1></div>
        <p class="pi-sub">라인을 골라 챔피언들의 일자별 픽률을 겹쳐 봅니다. 칩을 누르면 빠집니다.
            <span class="pi-sub-dim">마스터+ 솔로랭크 · ${d.days[0].day.slice(5).replace('-', '.')} ~ ${d.days[d.days.length - 1].day.slice(5).replace('-', '.')}</span></p>
        <div class="duo-tabs">${tabs}</div>
        <div class="lt-chips">${chips}${addSel}</div>
        <div class="pi-detail-card">${trendChartHtml(d, sel, nameOf)}</div>`;

    box.querySelector('.duo-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.duo-tab[data-lane]');
        if (btn && btn.dataset.lane !== trendLane) showTrendPage(btn.dataset.lane);
    });
    box.querySelector('.lt-chips').addEventListener('click', (e) => {
        const chip = e.target.closest('.lt-chip[data-champ]');
        if (!chip) return;
        trendSel[trendLane] = sel.filter(id => id !== Number(chip.dataset.champ));
        renderTrendPage(box, d, ranked);
    });
    const add = box.querySelector('#lt-add');
    if (add) add.addEventListener('change', (e) => {
        const id = Number(e.target.value);
        if (id && !sel.includes(id)) { sel.push(id); renderTrendPage(box, d, ranked); }
    });
}

// 여러 챔피언의 꺾은선을 한 판에 — 축·점·글자 규칙은 piGraphHtml 과 같다 (0 부터 시작하는 픽률 축)
function trendChartHtml(d, sel, nameOf) {
    if (!sel.length) return `<div class="pi-box-empty" style="height:300px">챔피언을 추가해 보세요.</div>`;
    const byId = {};
    d.rows.forEach(r => { byId[r.c] = r.g; });
    const series = sel.map((id, i) => ({
        id, name: nameOf(id), color: TREND_COLORS[i % TREND_COLORS.length],
        pts: d.days.map((day, j) => ({
            day: day.day,
            games: (byId[id] || [])[j] || 0,
            v: day.total > 0 ? ((byId[id] || [])[j] || 0) / day.total * 100 : 0
        }))
    }));

    const vMax = Math.max(...series.flatMap(s => s.pts.map(p => p.v)), 1);
    const hi = vMax * 1.15, lo = 0;
    const n = d.days.length;
    const X = (i) => n === 1 ? 50 : (i / (n - 1)) * 100;
    const Y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;

    const lines = series.map(s => n > 1
        ? `<polyline class="pi-line" style="stroke:${s.color}" points="${s.pts.map((p, i) => X(i).toFixed(2) + ',' + Y(p.v).toFixed(2)).join(' ')}"/>` : '').join('');
    const dots = series.map(s => s.pts.map((p, i) =>
        `<span class="pi-dot" style="left:${X(i).toFixed(2)}%; top:${Y(p.v).toFixed(2)}%; background:${s.color}"
               data-tip="${s.name} · ${p.day.slice(5).replace('-', '.')} · ${p.v.toFixed(2)}% (${p.games}판)"></span>`).join('')).join('');
    const yLabels = `<span class="pi-y" style="top:${Y(vMax).toFixed(2)}%">${vMax.toFixed(1)}</span>
        <span class="pi-y" style="top:${Y(0).toFixed(2)}%">0</span>`;

    return `<div class="lt-plot-wrap">
        <div class="pi-plot lt-plot">
            <svg class="pi-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
            ${dots}${yLabels}
        </div>
        <div class="pi-axis"><span>${d.days[0].day.slice(5).replace('-', '.')}</span><span>${d.days[n - 1].day.slice(5).replace('-', '.')}</span></div>
    </div>`;
}

async function showStats() {
    if (window.location.pathname !== '/stats') window.history.pushState({ page: 'stats' }, '', '/stats');
    hideAllContainers();
    const box = document.getElementById('stats-container');
    box.style.display = 'block';
    box.innerHTML = skelStatsPageHtml();

    await fetchChampionMap();

    let data;
    try {
        const res = await fetch(`/api/champion-stats${window.statScope ? `?scope=${encodeURIComponent(window.statScope)}` : ''}`);
        data = await res.json();
    } catch (e) {
        box.innerHTML = `<div class="stats-empty">통계를 불러오지 못했습니다.</div>`;
        return;
    }

    // ★ 박제된 패치면 행이 DB 가 아니라 정적 파일에 있다. 받아서 API 응답 모양으로
    //   되돌려 끼우면 아래 코드는 어느 쪽인지 몰라도 된다.
    if (data.archived) {
        try {
            const a = await loadStatsArchive(data.scope, data.updatedAt);
            const ex = expandStatsArchive(a);
            window.statsArchiveExpanded = window.statsArchiveExpanded || {};
            window.statsArchiveExpanded[data.scope] = ex;
            data.rows = ex.rows;
            // 분모는 DB(statscopes)가 준 값을 그대로 쓴다. 파일에도 있지만 한 군데서 오는 게 낫다.
            if (!Object.keys(data.totals || {}).length) {
                data.totals = {};
                a.t.forEach(t => { data.totals[ARCHIVE_KB[t[0]]] = t[1]; });
            }
        } catch (e) {
            box.innerHTML = `<div class="stats-empty">이 패치의 통계를 불러오지 못했습니다.</div>`;
            return;
        }
    }

    if (!data.ready || !data.rows?.length) {
        box.innerHTML = `
            <div class="stats-header">
                <h1 class="ranking-title">챔피언 통계</h1>
            </div>
            <div class="stats-empty">
                <div style="font-size:15px; color:var(--text-bright); margin-bottom:10px;">아직 표본을 모으는 중입니다.</div>
                마스터 이상 솔로랭크 경기를 모아 집계합니다.<br>
                하루 정도 지나야 첫 통계가 나옵니다.
            </div>`;
        return;
    }

    window.statScope = data.scope;
    let curLane = 'all';        // 'all' 또는 0~4
    // ★ 인원 밴드는 폐지됐다 (2026-08-21). 응답의 kb 는 항상 'all' 하나다.
    let minPick = 1;            // 픽률 커트라인(%). 입력칸이 바꾼다 — 폰은 칸이 숨어 1 고정
    let sortCol = 'tier', sortDir = 'desc';

    // ── 화면 뼈대. 표는 renderStatsTable() 이 매번 새로 그린다.
    const scopeOpts = scopeOptionsHtml(data.scopes, data.scope);

    box.innerHTML = `
        <div class="stats-header">
            <h1 class="ranking-title">챔피언 통계</h1>
            <p class="stats-sub">
                마스터 이상 솔로랭크 · <span id="stats-total"></span>
            </p>
        </div>

        <div class="stats-controls">
            <select class="stats-select" id="stats-scope">${scopeOpts}</select>
            <!-- ★ 인원 밴드(8~10명 / 5~7명) 버튼은 2026-08-21에 없앴다.
                 수집이 이미 마스터+ **5명 이상**인 판만 담으므로 그게 곧 기준이고,
                 쪼개 봐야 칸이 절반씩 얇아지기만 했다. 서버도 kb 를 'all' 하나로 쓴다. -->
        </div>

        <div class="stats-filter-container">
            <button class="stats-filter-btn all-btn active" data-lane="all">ALL</button>
            ${STAT_POS.map(p => `<button class="stats-filter-btn" data-lane="${p.code}" title="${p.name}"><img src="${STAT_LANE_ICON[p.key]}" alt="${p.name}"></button>`).join('')}
            <!-- ★ 픽률 커트라인 (2026-08-19). 이 픽률 미만 줄은 표에서 뺀다. 기본 1%.
                 폰은 입력칸을 숨기고 1% 고정이다 (style.css .stats-pickcut) -->
            <label class="stats-pickcut" title="이 픽률 미만 챔피언은 표에서 뺍니다">
                픽률 <input type="number" id="stats-pickcut-input" min="0" max="100" step="0.1" value="1" inputmode="decimal">% 이상
            </label>
        </div>

        <div class="stats-table-wrapper">
            <table class="stats-table">
                <thead>
                    <tr>
                        <th class="sortable-th" data-sort="name" style="text-align:left; padding-left:20px;">챔피언 <span class="sort-icon">▲</span></th>
                        <th class="sortable-th active" data-sort="tier">티어 <span class="sort-icon">▼</span></th>
                        <th class="stats-lane-th">라인</th>
                        <th class="sortable-th" data-sort="winRate">승률 <span class="sort-icon">▼</span></th>
                        <th class="sortable-th" data-sort="pickRate">픽률 <span class="sort-icon">▼</span></th>
                        <th class="sortable-th" data-sort="banRate">밴률 <span class="sort-icon">▼</span></th>
                        <th class="sortable-th" data-sort="games">표본 <span class="sort-icon">▼</span></th>
                    </tr>
                </thead>
                <tbody id="stats-tbody"></tbody>
            </table>
        </div>
        <p class="stats-note">
            티어는 <b>승률 · 픽률 · 밴률</b>을 합친 점수(50 근처, 높을수록 좋음)로 매기며
            <b>OP · 1 · 2 · 3 · 4 · 5</b> 여섯 단계입니다 (OP 56 · 1티어 53.5 · 2티어 50.5 · 3티어 48.5 · 4티어 45.5 이상).
            픽률 비중이 커서 승률이 높아도 픽률이 낮으면 티어가 낮습니다.
            <b>라인마다 따로</b> 계산하고, 같은 챔피언이라도 라인이 다르면 별도의 줄로 나옵니다
            (표본 ${STAT_MIN_GAMES}판 이상인 라인만). 승률은 표본이 적을수록 라인 평균 쪽으로 보정합니다.
            표의 밴률은 밴 슬롯 기준이라 같은 챔피언을 양 팀이 밴하면 2로 셉니다. 배지에 마우스를 올리면 점수가 보입니다.
        </p>
    `;

    // ── kb 밴드를 골라 champ+pos 로 합산한다
    function collect() {
        // ★ 인원 밴드가 없어져서 kb 는 'all' 한 줄뿐이다. 분모는 statscopes 를 다 더한 값이다.
        const rows = data.rows;
        const total = Object.values(data.totals).reduce((a, b) => a + b, 0);

        const byKey = new Map();
        rows.forEach(r => {
            const k = `${r.champ}|${r.pos}`;
            let c = byKey.get(k);
            if (!c) byKey.set(k, c = { champ: r.champ, pos: r.pos, games: 0, wins: 0, bans: 0, banGames: 0, kills: 0, deaths: 0, assists: 0 });
            c.games += r.games; c.wins += r.wins; c.bans += r.bans;
            // ★ banGames(밴된 판 수)는 화면엔 안 쓰지만 티어 점수가 쓴다 — 위 computeLaneTiers 주석 참고
            c.banGames += r.banGames || 0;
            c.kills += r.kills; c.deaths += r.deaths; c.assists += r.assists;
        });
        return { list: [...byKey.values()], total };
    }

    function renderStatsTable() {
        const { list, total } = collect();
        document.getElementById('stats-total').textContent =
            `${statScopeLabel(data.scope)} · ${total.toLocaleString()}판`;

        // 밴은 라인 개념이 없어서 pos=-1 줄에만 있다. 라인 필터에서도 이 값을 쓴다.
        const banOf = {};
        list.forEach(c => { if (c.pos === -1) banOf[c.champ] = c.bans; });
        // 챔피언별 전체 판수 (라인 비율의 분모)
        const totalOf = {};
        list.forEach(c => { if (c.pos === -1) totalOf[c.champ] = c.games; });

        // ★★ ALL 도 챔피언 통짜가 아니라 **챔피언 x 라인** 줄이다 (2026-08-19 개편).
        //   예전엔 주 라인 하나로 합쳐 보여줘서 "미드 빅토르" 줄에 바텀 빅토르 표본까지
        //   섞여 들어갔다. 지금은 라인이 다르면 줄도 다르다 — 승률·픽률·표본 전부 그 라인 값이다.
        //   · 30판을 넘는 라인만 줄로 세운다 (미달 라인까지 다 깔면 챔피언마다 1~2판짜리
        //     꼬리가 줄줄이 붙는다). 어느 라인도 못 넘는 챔피언은 "왜 없지" 가 되지 않게
        //     주 라인 한 줄을 흐리게 남긴다.
        //   · 밴률은 라인 개념이 없으므로(pos:-1 에만 있다) 어느 줄이든 챔피언 전체 값이다.
        let rows;
        if (curLane === 'all') {
            rows = [];
            const covered = new Set();   // 30판 이상 라인 줄이 하나라도 있는 챔피언
            list.forEach(c => {
                if (c.pos < 0 || c.games < STAT_MIN_GAMES) return;
                covered.add(c.champ);
                rows.push({
                    ...c,
                    bans: banOf[c.champ] || 0,
                    lanePos: c.pos,
                    laneRate: totalOf[c.champ] ? c.games / totalOf[c.champ] * 100 : 0
                });
            });
            list.forEach(c => {
                if (c.pos !== -1 || covered.has(c.champ)) return;
                let best = null;
                list.forEach(x => {
                    if (x.champ === c.champ && x.pos >= 0 && (!best || x.games > best.games)) best = x;
                });
                rows.push({ ...c, lanePos: best ? best.pos : -1, laneRate: best && c.games ? best.games / c.games * 100 : 0 });
            });
        } else {
            // ★ 라인 필터에서는 그 라인 표본이 30판 미만인 줄을 **아예 뺀다** (2026-08-19).
            //   흐리게 남겨 두니 "다른 포지션 챔피언이 왜 여기 있냐" 로 읽혔다 —
            //   몇 판 억지로 간 기록까지 그 라인 챔피언처럼 깔리는 게 문제였다.
            rows = list.filter(c => c.pos === Number(curLane) && c.games >= STAT_MIN_GAMES).map(c => ({
                ...c,
                bans: banOf[c.champ] || 0,
                lanePos: c.pos,
                laneRate: totalOf[c.champ] ? c.games / totalOf[c.champ] * 100 : 0
            }));
        }

        // ★ 티어는 **라인 pool 안에서** 매긴다. ALL 탭 행의 lanePos 는 주 라인이라,
        //   거기 찍히는 티어는 "그 챔피언이 주 라인에서 받은 티어" 가 된다.
        const laneTiers = computeLaneTiers(list, total);

        rows.forEach(c => {
            c.winRate = c.games ? c.wins / c.games * 100 : 0;
            c.pickRate = total ? c.games / total * 100 : 0;
            c.banRate = total ? c.bans / total * 100 : 0;
            c.name = window.korChampMap[championIdMap[c.champ]] || '알 수 없음';
            const t = laneTiers.get(`${c.champ}|${c.lanePos}`);
            c.tier = t ? t.tier : null;
            c.score = t ? t.score : null;
        });

        // ★ 픽률 커트라인 (2026-08-19). 라인별 줄이라 픽률도 그 라인 값 기준이다
        rows = rows.filter(c => c.pickRate >= minPick);

        rows.sort((a, b) => {
            let va, vb;
            // 티어 정렬은 등급이 아니라 **점수**로 한다 — 같은 S 안에서도 순서가 생긴다
            if (sortCol === 'tier') { va = a.score ?? -99; vb = b.score ?? -99; }
            else if (sortCol === 'name') { return sortDir === 'desc' ? b.name.localeCompare(a.name, 'ko') : a.name.localeCompare(b.name, 'ko'); }
            else { va = a[sortCol]; vb = b[sortCol]; }
            return sortDir === 'desc' ? vb - va : va - vb;
        });

        const tbody = document.getElementById('stats-tbody');
        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="7" class="stats-empty-row">데이터가 없습니다.</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(c => {
            const engId = championIdMap[c.champ] || '0';
            // ★ 흐림 기준을 "표본 미달" 에서 **"티어를 못 받았다"** 로 바꿨다 (2026-08-17).
            //   ALL 탭에서는 총 표본이 많아도 주 라인이 30판을 못 넘기면 티어가 없는데,
            //   그때 줄만 멀쩡히 진하면 "왜 이 챔피언만 '-' 지" 가 된다.
            const low = !c.tier;
            const laneKey = STAT_POS.find(p => p.code === c.lanePos)?.key;
            return `
            <tr class="stats-row ${low ? 'stats-row-low' : ''}" data-champ="${c.champ}" data-lane="${c.lanePos}">
                <!-- ★ td 자체를 flex 로 만들면 안 된다 (2026-08-19). display:flex 가 되는 순간
                     table-cell 이 아니게 되어 그 칸의 border-bottom 이 옆 칸과 1px 어긋나게
                     그려졌다. flex 는 안쪽 div 가 맡는다 — style.css .stats-champ-flex 참고 -->
                <td class="stats-champ-info"><div class="stats-champ-flex">
                    <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${engId}.png"
                         onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/0.png'">
                    <!-- ★ 이름 오른쪽 hover 화살표(.stats-expand ▾)는 2026-09-08 에 뗐다 (사용자 요청).
                         줄 아래가 펼쳐지던 시절의 표식인데 2026-08-26 에 상세 **페이지**로 바뀌면서
                         가리키는 동작이 없어졌다 (줄 전체가 링크다). CSS 도 같이 지웠다 -->
                    <span class="stats-champ-name">${c.name}</span>
                </div></td>
                <td>${c.tier
                    ? `<span class="stats-tier ${tierClass(c.tier)}" title="점수 ${c.score.toFixed(2)}">${c.tier}</span>`
                    : `<span class="stats-tier-none" title="표본 ${STAT_MIN_GAMES}판 미만">-</span>`}</td>
                <td class="stats-lane">
                    ${laneKey ? `<img src="${STAT_LANE_ICON[laneKey]}" alt="">` : ''}
                    <div class="stats-lane-rate">${c.laneRate.toFixed(0)}%</div>
                </td>
                <td class="stats-win">${c.winRate.toFixed(1)}%</td>
                <td class="stats-num">${c.pickRate.toFixed(1)}%</td>
                <td class="stats-num">${c.banRate.toFixed(1)}%</td>
                <td class="stats-games">${c.games.toLocaleString()}</td>
            </tr>`;
        }).join('');
    }

    renderStatsTable();

    // ── 줄을 누르면 **챔피언 상세 페이지로 간다** (2026-08-26).
    //   ★★ 예전엔 줄 아래가 펼쳐졌는데 페이지로 뗐다. 펼침은 표 폭(1000px) 안에 갇혀
    //     룬·아이템·상성을 한 줄로 욱여넣어야 했고, 정렬·필터를 누르면 그냥 닫혔다
    //     (표를 다시 그리니까). 페이지는 주소가 남아서 링크로 보낼 수도 있다.
    //   ★ tbody 에 한 번만 붙인다 — renderStatsTable() 은 innerHTML 만 바꿔서 리스너가 살아남는다.
    document.getElementById('stats-tbody').addEventListener('click', (e) => {
        const tr = e.target.closest('.stats-row');
        if (!tr) return;
        const eng = championIdMap[Number(tr.dataset.champ)];
        if (!eng) return;
        // ★★ 누른 줄의 라인을 같이 넘긴다 — 안 넘기면 **탑 카밀을 눌러도 서폿 카밀이 뜬다**
        //   (판수가 제일 많은 라인으로 물러나므로). 표가 라인별로 줄이 나뉘어 있어서
        //   `data-lane` 이 곧 그 줄의 라인이다. `-1`(라인 무관)이면 주소에 안 붙인다.
        const lane = STAT_POS.find(p => p.code === Number(tr.dataset.lane))?.key;
        const url = lane ? `/stats/${eng}/${lane}` : `/stats/${eng}`;
        window.history.pushState({ page: 'stats', champ: eng, lane }, '', url);
        showChampStatPage(eng, lane);
    });

    // (옛 펼침 코드 — 남겨 두면 위 리스너와 둘 다 돌아서 페이지 이동 뒤에 표가 다시 그려진다)

    // ── 컨트롤
    document.getElementById('stats-scope').addEventListener('change', (e) => {
        window.statScope = e.target.value;
        showStats();
    });

    // 픽률 커트라인. 지우거나 이상한 값을 치면 0(전부 표시)으로 본다
    const pickInput = document.getElementById('stats-pickcut-input');
    if (pickInput) pickInput.addEventListener('input', () => {
        const v = parseFloat(pickInput.value);
        minPick = Number.isFinite(v) ? Math.min(Math.max(v, 0), 100) : 0;
        renderStatsTable();
    });

    const filterBtns = document.querySelectorAll('.stats-filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            filterBtns.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            curLane = e.currentTarget.dataset.lane;
            renderStatsTable();
        });
    });

    const ths = document.querySelectorAll('.stats-table .sortable-th');
    ths.forEach(th => {
        th.addEventListener('click', (e) => {
            const col = e.currentTarget.dataset.sort;
            if (sortCol === col) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
            else { sortCol = col; sortDir = col === 'name' ? 'asc' : 'desc'; }

            ths.forEach(h => {
                h.classList.remove('active');
                h.querySelector('.sort-icon').textContent = h.dataset.sort === 'name' ? '▲' : '▼';
            });
            e.currentTarget.classList.add('active');
            e.currentTarget.querySelector('.sort-icon').textContent = sortDir === 'asc' ? '▲' : '▼';
            renderStatsTable();
        });
    });
}


let fullRankingData = [];
let currentRankingPage = 1;
let rankingQuery = '';        // 닉네임 필터 (원문 그대로 들고 있다가 화면에 되돌려 준다)
let rankingUpdatedAt = 0;     // 서버가 명단을 받아온 시각
// ★ 갱신 주기는 **서버가 알려준다** (/api/ranking 의 refreshMs). 시간대마다 10분/5분/1분이라
//   화면에 규칙을 복제해 두면 서버에서 주기를 바꿀 때 한쪽만 고쳐 어긋난다.
//   응답에 없으면(옛 서버) 예전 문구대로 10분으로 본다.
let rankingRefreshMs = 10 * 60 * 1000;

// ==========================================
// 컷라인 그래프 (2026-08-18)
//   ★★ 서버가 **23:45~23:59 의 1분 표본 15개 중 c300+g1000 이 최대인 하나**를 골라
//     그날의 **챌린저 최저 LP / 그마 최저 LP** 를 한 줄 남긴다 (2026-08-19 개편).
//     즉 그래프의 점은 **티어 소속 기준**이다 — "300등의 LP" 가 아니다.
//   ★★ 반면 카드 오른쪽의 "현재 커트라인" 숫자는 **지금 명단의 300등·1000등 LP** 다
//     (아래 rankCutoffSideHtml 의 lpAt). **일부러 기준이 다르다** —
//     저건 "지금 몇 점이면 300등 안인가" 라는 실시간 값이고, 그래프는 그날의 티어 경계다.
//     재계산 전 시간대에는 둘이 50~150 LP 씩 벌어질 수 있는데 **버그가 아니다.**
//   ★ 한 번 받으면 들고 있는다 — 하루 한 줄이라 페이지를 넘길 때마다 다시 받을 이유가 없다.
//   ★ null 은 "아직 안 받았다", 빈 배열은 "받았는데 기록이 없다" 로 뜻이 다르다.
//     빈 배열을 "아직" 으로 보여주면 첫날에 영영 로딩 중처럼 보인다.
// ==========================================
let rankCutoffData = null;

async function loadRankCutoffs() {
    if (rankCutoffData) return rankCutoffData;
    try {
        const res = await fetch('/api/rank-cutoffs?days=90');
        const data = await res.json();
        rankCutoffData = data.ok ? (data.days || []) : [];
    } catch (e) {
        rankCutoffData = [];
    }
    return rankCutoffData;
}

// ★★ SVG 는 **선만** 그리고 점·글자는 HTML 절대배치다.
//   폭을 카드에 맞추려면 viewBox 를 늘려야 하는데(preserveAspectRatio="none"),
//   그러면 그 안의 글자와 원이 **가로로 찌그러진다**. 스탯 탭 그래프에서 겪은 것과 같은
//   함정이라 같은 방식으로 푼다. 선 굵기는 vector-effect 로 지킨다.
function cutoffChartHtml(rows, key, opts) {
    const pts = (rows || []).map(r => ({ day: r.day, v: r[key] }))
        .filter(p => typeof p.v === 'number' && p.day);

    // ★★ 오른쪽 숫자는 그래프의 마지막 점(어젯밤 23:45)이 아니라 **지금 명단의 컷**이다.
    //   제목이 "현재 … 커트라인" 이므로 지금 값이어야 맞고, 그래야 **기록이 아직 하나도
    //   없는 첫날에도** 숫자가 뜬다. 그래프는 그 값의 과거 추이를 보여주는 것이다.
    const nowText = typeof opts.nowLp === 'number' ? opts.nowLp.toLocaleString() + ' LP' : '';
    const head = `<div class="cutoff-head">
            <span class="cutoff-title"><i class="cutoff-swatch" style="background:${opts.color}"></i>${opts.title}</span>
            ${nowText ? `<span class="cutoff-now">${nowText}</span>` : ''}
        </div>`;

    if (rows === null) {
        return `<div class="cutoff-card">${head}<div class="cutoff-empty">불러오는 중…</div></div>`;
    }
    if (!pts.length) {
        return `<div class="cutoff-card">${head}
            <div class="cutoff-empty">아직 기록이 없습니다.<br><b>매일 밤 23:45~23:59</b> 를 재서 한 점씩 쌓입니다.</div></div>`;
    }

    const vals = pts.map(p => p.v);
    const vMax = Math.max(...vals), vMin = Math.min(...vals);
    // ★ 위아래 여백. 값이 하나뿐이거나 전부 같으면 폭이 0 이라 나눗셈이 NaN 이 된다.
    const span = vMax - vMin;
    const pad = span > 0 ? span * 0.25 : Math.max(10, Math.round(vMax * 0.01));
    const lo = vMin - pad, hi = vMax + pad;

    const n = pts.length;
    const X = (i) => n === 1 ? 50 : (i / (n - 1)) * 100;
    const Y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;

    const line = n > 1
        ? `<polyline class="cutoff-line" style="stroke:${opts.color}" points="${pts.map((pt, i) => X(i).toFixed(2) + ',' + Y(pt.v).toFixed(2)).join(' ')}" />`
        : '';

    // ★ 점이 많아지면 서로 붙어 알아볼 수 없다. 30개를 넘으면 선만 그린다
    const dots = n <= 30 ? pts.map((pt, i) =>
        `<span class="cutoff-dot" style="left:${X(i).toFixed(2)}%; top:${Y(pt.v).toFixed(2)}%; background:${opts.color}"
               data-tip="${fmtCutoffDay(pt.day)} · ${pt.v.toLocaleString()} LP"></span>`).join('') : '';

    // y 라벨은 최대·최소 **그 점의 높이**에 붙인다 (여백을 준 축 끝이 아니다)
    const yLabels = span > 0
        ? `<span class="cutoff-y" style="top:${Y(vMax).toFixed(2)}%">${vMax.toLocaleString()}</span>
           <span class="cutoff-y" style="top:${Y(vMin).toFixed(2)}%">${vMin.toLocaleString()}</span>`
        : `<span class="cutoff-y" style="top:${Y(vMax).toFixed(2)}%">${vMax.toLocaleString()}</span>`;

    return `<div class="cutoff-card">
        ${head}
        <div class="cutoff-plot">
            <svg class="cutoff-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${line}</svg>
            ${dots}
            ${yLabels}
        </div>
        <div class="cutoff-axis">
            <span>${fmtCutoffDay(pts[0].day)}</span>
            <span class="cutoff-axis-mid">${n}일치 · 매일 23:45 기준</span>
            <span>${fmtCutoffDay(pts[n - 1].day)}</span>
        </div>
    </div>`;
}

const fmtCutoffDay = (d) => String(d).slice(5).replace('-', '.');

// 랭킹 표 오른쪽에 세로로 쌓이는 두 장
//   ★ 지금 컷은 이미 받아 둔 명단에서 바로 센다 — 명단이 LP 내림차순이라 N등은 N-1 번째다.
//     추가 요청이 0 이고, 서버가 하루 한 번 남기는 기록보다 늘 최신이다.
function rankCutoffSideHtml() {
    const lpAt = (n) => fullRankingData.length >= n ? fullRankingData[n - 1].leaguePoints : null;
    return `<aside class="rank-side">
        ${cutoffChartHtml(rankCutoffData, 'lpChal', { title: '현재 챌린저 커트라인', color: '#eab308', nowLp: lpAt(300) })}
        ${cutoffChartHtml(rankCutoffData, 'lpGm', { title: '현재 그랜드마스터 커트라인', color: '#f0576f', nowLp: lpAt(1000) })}
    </aside>`;
}
const RANKING_ITEMS_PER_PAGE = 50;

// ★ 티어는 서버가 한 글자로 보내 준다 (server.js 의 TIER_CODE).
//   순위 번호로 짐작하던 걸 대체한 것이다 — 마스터가 그마보다 LP 가 높은 일이 실제로 있다.
// ★ color 는 2026-08-15부터 안 쓴다 — 티어 이름·LP·승률을 전부 흰색으로 통일했고,
//   티어 구분은 왼쪽 메달 그림이 한다. 색을 되돌리고 싶으면 이 값을
//   style="color: ${t.color}" 로 다시 실으면 되니까 표에는 남겨 둔다.
// ★ short 는 폰에서 쓴다. 2026-08-19에 한 글자(챌/마)에서 온전한 줄임말로 늘렸다 —
//   "챌린저/그마/마스터" 세 글자가 다 보이게 폰 티어 칸 폭도 같이 넓혔다 (style.css).
const RANK_TIER_INFO = {
    C: { name: '챌린저', short: '챌린저', color: '#ca8a04', icon: 'challenger' },
    G: { name: '그랜드마스터', short: '그마', color: '#d33148', icon: 'grandmaster' },
    M: { name: '마스터', short: '마스터', color: 'var(--accent-mid)', icon: 'master' }
};

// 랭킹 표 왼쪽 메달. op.gg CDN 대신 라이엇 공식(CommunityDragon) 미니 문장을 쓴다 (2026-08-19)
const RANK_MEDAL_BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/';

function rankTierInfo(code) {
    return RANK_TIER_INFO[code] || RANK_TIER_INFO.M;
}

// ── LP 추이 카드 (2026-09-01, 로드맵 A-9) — 전적 페이지 사이드바. 그래프 골격은 pi-* 재사용
function lpTrendCardHtml(rows, nowLp) {
    const fmtD = (d) => { const s = String(d); return s.slice(2, 4) + '.' + s.slice(4); };   // 260901 → 09.01
    const head = `<div class="lp-card-head"><h3>LP 추이</h3><span class="lp-card-now">${(nowLp || 0).toLocaleString()} LP</span></div>`;
    if (!rows || rows.length < 2) {
        return `<div class="pix-box lp-card">${head}
            <div class="lp-card-empty">매일 자정에 한 점씩 기록됩니다.${rows && rows.length === 1 ? '<br>내일부터 선이 그려집니다.' : ''}</div></div>`;
    }
    const pts = rows.map(r => ({ day: r[0], v: r[1], t: r[2] }));
    const vals = pts.map(p => p.v);
    const vMax = Math.max(...vals), vMin = Math.min(...vals);
    const span = vMax - vMin;
    const pad = span > 0 ? span * 0.25 : Math.max(10, Math.round(vMax * 0.05) || 10);
    const lo = vMin - pad, hi = vMax + pad;
    const n = pts.length;
    const X = (i) => n === 1 ? 50 : (i / (n - 1)) * 100;
    const Y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
    const line = `<polyline class="pi-line" points="${pts.map((p, i) => X(i).toFixed(2) + ',' + Y(p.v).toFixed(2)).join(' ')}"/>`;
    // 점이 붙어 못 알아보면 선만 그린다 (컷라인 그래프의 30개 규칙과 같은 감각)
    const dots = n <= 60 ? pts.map((p, i) =>
        `<span class="pi-dot" style="left:${X(i).toFixed(2)}%; top:${Y(p.v).toFixed(2)}%"
               data-tip="${fmtD(p.day)} · ${p.v.toLocaleString()} LP · ${rankTierInfo(p.t).short}"></span>`).join('') : '';
    const yLabels = `<span class="pi-y" style="top:${Y(vMax).toFixed(2)}%">${vMax.toLocaleString()}</span>`
        + (span > 0 ? `<span class="pi-y" style="top:${Y(vMin).toFixed(2)}%">${vMin.toLocaleString()}</span>` : '');
    return `<div class="pix-box lp-card">
        ${head}
        <div class="pi-plot lp-plot">
            <svg class="pi-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${line}</svg>
            ${dots}${yLabels}
        </div>
        <div class="pi-axis lp-axis"><span>${fmtD(pts[0].day)}</span><span>${fmtD(pts[n - 1].day)}</span></div>
    </div>`;
}

// "3분 전 갱신". 서버가 0 을 주면(아직 한 번도 안 받았으면) 예전 문구로 물러난다.
// ★ 주기만 적는다. "N분 전 갱신" 은 마우스를 올렸을 때 정확한 시각으로 보여준다
//   (아래 rankUpdatedTitle). 어림수를 앞에 붙이면 줄만 길어지고 정확하지도 않았다.
function rankUpdatedText() {
    const per = Math.max(1, Math.round(rankingRefreshMs / 60000));
    return `${per}분마다 갱신`;
}

// 마우스를 올리면 정확한 시각을 보여준다. 문구 쪽은 "3분 전" 처럼 뭉뚱그리므로
// 언제 받아온 값인지 정확히 알고 싶을 때가 있다.
function rankUpdatedTitle() {
    if (!rankingUpdatedAt) return '';
    return '최근 갱신 시각: ' + new Date(rankingUpdatedAt).toLocaleString('ko-KR');
}

// ★ 헤더는 showRanking 과 popstate 두 곳에서 그린다. 예전엔 같은 HTML 이 양쪽에
//   복붙돼 있어서 한쪽만 고치면 뒤로가기로 들어왔을 때 다르게 보였다.
function renderRankingHeader() {
    const profileDiv = document.getElementById('user-profile');
    profileDiv.innerHTML = `
        <div class="stats-header">
            <!-- 제목 왼쪽 챌린저 메달은 뺐다 (2026-08-19 요청). op.gg 핫링크이기도 했다 -->
            <h1 class="ranking-title">한국서버 솔로랭크 랭킹</h1>
            <p class="rank-updated" id="rank-updated"><span${rankUpdatedTitle() ? ` data-tooltip="${escapeHtml(rankUpdatedTitle())}"` : ''}>${rankUpdatedText()}</span></p>
            <div class="rank-search-box">
                <input type="text" id="rank-search" class="rank-search" autocomplete="off"
                       placeholder="닉네임/태그 검색"
                       oninput="onRankingSearch(this.value)">
                <button type="button" class="rank-search-clear" id="rank-search-clear"
                        onclick="onRankingSearch('')" title="검색어 지우기">&times;</button>
            </div>
        </div>
    `;

    // 뒤로가기로 다시 들어오는 경우가 있어 입력칸 값을 상태에서 되돌린다
    const input = document.getElementById('rank-search');
    if (input) input.value = rankingQuery;
    const clear = document.getElementById('rank-search-clear');
    if (clear) clear.style.visibility = rankingQuery ? 'visible' : 'hidden';
}

// ★ 검색어 해석은 **한 번만** 한다. 1.1만 명을 훑으므로 행마다 자판 변환을 돌리면
//   타이핑이 눈에 띄게 밀린다. 후보 문자열을 미리 만들어 두고 비교만 시킨다.
function buildRankQuery(raw) {
    const q = String(raw || '').trim();
    if (!q) return null;

    const terms = new Set([q.toLowerCase()]);
    // 영문만 친 경우엔 한글 자판 해석도 후보에 넣는다 ("rkfps" -> "가렌", "rf" -> "ㄱㄹ").
    // 영문 닉네임도 많으므로 원문 후보는 위에서 이미 넣어 뒀다 — 둘 중 하나만 맞으면 된다.
    if (/^[A-Za-z]+$/.test(q)) koCandidates(q).forEach(k => { if (k) terms.add(k); });
    // ★ 초성을 이어 치면 IME 가 겹받침으로 묶는다 (`ㄹㅂㄹ` -> `ㄼㄹ`). 푼 후보도 넣는다.
    //   위 koCandidates 는 **영문일 때만** 타므로 한글 입력은 여기서 따로 챙겨야 한다.
    for (const t of [...terms]) { const s = splitJong(t); if (s !== t) terms.add(s); }

    return [...terms];
}

function onRankingSearch(value) {
    rankingQuery = value;
    const input = document.getElementById('rank-search');
    if (input && input.value !== value) input.value = value;
    const clear = document.getElementById('rank-search-clear');
    if (clear) clear.style.visibility = value ? 'visible' : 'hidden';
    renderRankingPage(1, { keepScroll: true });
}

// 검색어가 없으면 원본 배열을 그대로 돌려준다 (1.1만 개를 복사할 이유가 없다)
function filteredRankingData() {
    const terms = buildRankQuery(rankingQuery);
    if (!terms) return fullRankingData;
    return fullRankingData.filter(p => terms.some(t => p._lc.includes(t) || p._cho.includes(t)));
}

async function showRanking(targetPage = 1) {
    const targetUrl = `/ranking?page=${targetPage}`;
    if (window.location.pathname + window.location.search !== targetUrl) {
        if (window.location.pathname === '/ranking' && !window.location.search) {
            window.history.replaceState({ page: 'ranking', rankingPage: targetPage }, '', targetUrl);
        } else {
            window.history.pushState({ page: 'ranking', rankingPage: targetPage }, '', targetUrl);
        }
    }

    if (Date.now() < rateLimitUnlockTime) {
        showErrorToast("현재 접속자가 많아 검색이 지연되고 있습니다. 잠시 후 다시 시도해주세요.");
        return;
    }

    // 랭킹 탭에 새로 들어온 것이므로 지난번 검색어는 푼다.
    // (안 풀면 메뉴로 다시 들어왔을 때 걸러진 목록이 그대로 나와 고장처럼 보인다)
    rankingQuery = '';

    hideAllContainers();
    const resultBox = document.getElementById('result-container');
    resultBox.style.display = "block";
    // ★ 랭킹 탭만 통을 넓힌다 (1089 → 1400px). 오른쪽 그래프 칸(300px)을 넣으면
    //   1089px 에서는 표가 눌려 숙련도 칸이 들어갈 자리가 없다. 다른 탭은 그대로다 —
    //   이 클래스는 hideAllContainers 가 벗긴다.
    resultBox.classList.add('is-ranking');
    const listDiv = document.getElementById('game-list');

    // ★ 컷라인은 랭킹 명단과 **따로** 받는다. 기다렸다 같이 그리면 표가 늦게 뜬다 —
    //   먼저 "불러오는 중" 으로 자리만 잡아 두고, 도착하면 그 자리만 다시 그린다.
    loadRankCutoffs().then(() => {
        const side = document.querySelector('.rank-side');
        if (side) side.outerHTML = rankCutoffSideHtml();
    });

    const filterArea = document.getElementById('filter-area');
    const sidebarArea = document.getElementById('sidebar-area');
    const summaryArea = document.getElementById('summary-stats-area');
    if (sidebarArea) sidebarArea.style.display = "none";
    if (filterArea) filterArea.style.display = "none";
    if (summaryArea) summaryArea.style.display = "none";

    renderRankingHeader();
    listDiv.innerHTML = `<div style="min-height:100vh">${skelTableHtml(12, 44)}</div>`;
    const moreArea = document.getElementById('load-more-area');
    if (moreArea) moreArea.innerHTML = "";

    try {
        // ★ 숙련도 아이콘 매핑(championIdMap)을 랭킹과 **같이** 기다린다 (2026-09-04).
        //   안 기다리면 새로고침·직링크로 랭킹에 바로 들어올 때 map 이 비어 아이콘이 전부 빈 칸이 됐다.
        //   이미 로드됐으면 fetchChampionMap 이 즉시 리턴하므로(중복 요청 없음) 지연도 0 이다.
        const [res] = await Promise.all([
            fetch('/api/ranking'),
            fetchChampionMap()
        ]);

        if (res.status === 429) {
            const retryAfter = res.headers.get('Retry-After');
            rateLimitUnlockTime = Date.now() + (retryAfter ? parseInt(retryAfter) * 1000 : 5000);
            showErrorToast("조회 한도를 초과했습니다. 잠시 후 다시 시도해주세요.");
            listDiv.innerHTML = "<div style='text-align:center; padding:50px; color:#f87171;'>조회 한도를 초과했습니다. 잠시 후 다시 시도해주세요.</div>";
            return;
        }

        const data = await res.json();

        if (data.error) throw new Error(data.error);
        if (!data.players) throw new Error("서버가 랭킹 데이터를 준비 중입니다. 잠시 후 새로고침 해주세요.");

        // ★ 원래 순위(rank)를 여기서 못 박는다. 검색으로 걸러내면 배열 위치가 달라져서
        //   화면에서 세면 "1위" 부터 다시 시작해 버린다.
        //   검색용 소문자·초성도 같이 만들어 둔다 — 타이핑할 때마다 1.1만 번 만들 이유가 없다.
        rankingUpdatedAt = data.updatedAt || 0;
        if (data.refreshMs > 0) rankingRefreshMs = data.refreshMs;
        fullRankingData = data.players.map((p, i) => {
            const lc = String(p.displayName || '').toLowerCase();
            return { ...p, rank: i + 1, _lc: lc, _cho: getChosung(lc) };
        });
        renderRankingHeader();     // 갱신 시각을 받은 뒤 다시 그린다
        renderRankingPage(targetPage);

    } catch (e) {
        showErrorToast("데이터 로드 실패");
        listDiv.innerHTML = `<div style='text-align:center; padding:50px; color:#f87171;'>데이터 로드 실패: ${e.message}</div>`;
    }
}

// ★ 페이지 버튼 (2026-08-13). 예전엔 5개 묶음 단위로만 움직여서 220페이지 짜리
//   목록에서 뒤로 가려면 '>' 를 수십 번 눌러야 했다. 지금은 현재 페이지를 가운데 둔
//   5칸 + 처음/끝 + 직접 입력이다. 인라인 style 은 전부 style.css 16번 절로 갔다.
function rankPagerHtml(page, totalPages) {
    if (totalPages <= 1) return '';

    // ★ 양 끝 버튼은 못 눌러도 **자리를 지킨다**. 없앴다 만들었다 하면 가운데 정렬이라
    //   페이지를 넘길 때마다 번호들이 좌우로 튄다
    const btn = (p, label, title, on) =>
        `<button type="button" class="rank-pg"${on ? ` onclick="renderRankingPage(${p})"` : ' disabled'} title="${title}">${label}</button>`;

    let startPage = Math.max(1, page - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    startPage = Math.max(1, endPage - 4);   // 끝쪽에서도 5칸을 유지한다

    let html = `<div class="rank-pager">`;

    html += btn(1, '&laquo;', '처음', page > 1) + btn(page - 1, '&lsaquo;', '이전', page > 1);

    for (let p = startPage; p <= endPage; p++) {
        html += `<button type="button" class="rank-pg${p === page ? ' active' : ''}" onclick="renderRankingPage(${p})">${p}</button>`;
    }

    html += btn(page + 1, '&rsaquo;', '다음', page < totalPages) + btn(totalPages, '&raquo;', '끝', page < totalPages);

    html += `
        <span class="rank-pg-jump">
            <input type="number" min="1" max="${totalPages}" value="${page}" aria-label="페이지 번호"
                   onkeydown="if (event.key === 'Enter') renderRankingPage(this.value)">
            <span class="rank-pg-total">/ ${totalPages}</span>
        </span>`;

    return html + `</div>`;
}

// 숙련도 TOP5 칸.
//   ★ 서버가 분당 20명씩 채우므로 한 바퀴에 9시간쯤 걸린다. 아직 못 받은 사람은
//     빈 배열로 오는데, 그때 칸을 비워 두면 표가 고장난 것처럼 보여서 - 로 자리를 지킨다.
//   ★ championIdMap 은 fetchChampionMap() 이 채운다. 랭킹만 보고 있어도 페이지 로드 때
//     같이 받으므로 추가 요청은 없다. 아직 안 왔으면 아이콘 주소를 못 만드니 그때도 - 다.
function rankMasteryHtml(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return `<span class="rank-mastery-empty">-</span>`;
    }
    const icons = ids.map(id => {
        const eng = championIdMap[id];
        if (!eng) return '';
        return `<img class="rank-mastery-icon"
                     src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${eng}.png"
                     alt="" title="${window.korChampMap[eng] || eng}" loading="lazy">`;
    }).join('');
    return icons || `<span class="rank-mastery-empty">-</span>`;
}

function renderRankingPage(page, opts = {}) {
    const listDiv = document.getElementById('game-list');
    const data = filteredRankingData();
    const totalPages = Math.max(1, Math.ceil(data.length / RANKING_ITEMS_PER_PAGE));

    // 페이지 직접 입력과 검색을 같이 받으므로 여기서 한 번 가둔다
    page = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
    currentRankingPage = page;

    // ★ 검색 중에는 주소를 안 건드린다. 걸러낸 목록의 3페이지는 /ranking?page=3 이 아니라서,
    //   그 주소를 새로고침하면 엉뚱한 자리가 나온다
    if (!rankingQuery) {
        const newUrl = `/ranking?page=${page}`;
        if (window.location.pathname + window.location.search !== newUrl) {
            window.history.pushState({ page: 'ranking', rankingPage: page }, '', newUrl);
        }
    }

    const startIndex = (page - 1) * RANKING_ITEMS_PER_PAGE;
    const pageData = data.slice(startIndex, startIndex + RANKING_ITEMS_PER_PAGE);

    let rowsHtml = '';

    if (pageData.length === 0) {
        rowsHtml = `<tr><td colspan="6" class="rank-empty">'${escapeHtml(rankingQuery.trim())}' 와(과) 맞는 닉네임이 없습니다.</td></tr>`;
    }

    pageData.forEach(player => {
        const total = player.wins + player.losses;
        const winRate = total > 0 ? ((player.wins / total) * 100).toFixed(1) : '0.0';
        const t = rankTierInfo(player.tier);
        const safeName = escapeHtml(player.displayName);

        // ★ 닉네임을 아직 못 받아온 사람은 서버가 "User-a1b2c3d4" 로 채워 보낸다.
        //   라이엇 ID 에는 항상 #태그가 붙으므로 # 이 없으면 미해결이다.
        //   눌러도 검색이 헛돌기만 하니 링크로 안 만든다
        const resolved = player.displayName.includes('#');

        // ★ 닉네임을 onclick 문자열 안에 박지 않는다 (2026-08-13).
        //   아포스트로피가 든 닉네임이면 리터럴이 그 자리에서 닫혀 JS 가 깨졌고,
        //   그 사람만 클릭이 통째로 안 먹었다. data- 속성 + 이벤트 위임이면 안 생기는 문제다
        const nameCell = resolved
            ? `<span class="summoner-link" data-name="${safeName}" title="${safeName} 검색">${safeName}</span>`
            : `<span class="rank-unresolved" title="닉네임을 아직 불러오지 못했습니다">${safeName}</span>`;

        rowsHtml += `
            <tr>
                <td class="rank-num">${player.rank}</td>
                <td class="rank-name">${nameCell}</td>
                <td class="rank-tier">
                    <img class="rank-tier-medal" src="${RANK_MEDAL_BASE}${t.icon}.png" alt="" loading="lazy">
                    <span class="rank-tier-name">${t.name}</span>
                    <span class="rank-tier-short">${t.short}</span>
                </td>
                <td class="rank-lp">${player.leaguePoints}</td>
                <td class="rank-wr">
                    <span class="rank-wr-num">${winRate}%</span>
                    <span class="rank-wl">(${player.wins}W ${player.losses}L)</span>
                </td>
                <td class="rank-mastery">${rankMasteryHtml(player.mastery)}</td>
            </tr>`;
    });

    const countHtml = rankingQuery.trim()
        ? `<div class="rank-count">검색 결과 <b>${data.length.toLocaleString()}</b>명 · 전체 ${fullRankingData.length.toLocaleString()}명</div>`
        : `<div class="rank-count">전체 <b>${fullRankingData.length.toLocaleString()}</b>명</div>`;

    // ★ 폰 전용: 표 우상단에 현재 커트라인 (2026-08-19). 데스크톱은 오른쪽 그래프 카드가
    //   같은 값을 보여주므로 CSS 로 숨긴다. 색은 컷라인 그래프와 같은 챌/그마 색이다.
    //   컷은 이미 받아 둔 명단에서 바로 센다 — 명단이 LP 내림차순이라 N등은 N-1 번째다.
    const lpOf = (n) => fullRankingData.length >= n ? fullRankingData[n - 1].leaguePoints : null;
    const cutC = lpOf(300), cutG = lpOf(1000);
    const cutlineHtml = (cutC !== null && cutG !== null)
        ? `<div class="rank-cutline"><span class="rank-cutline-c">C: ${cutC.toLocaleString()}LP</span> / <span class="rank-cutline-g">GM: ${cutG.toLocaleString()}LP</span></div>`
        : '';

    const tableHtml = `
        <!-- ★ 인라인 style 을 클래스로 뺐다 (2026-08-11). min-width:600px 이 인라인이라
             @media 로 못 풀었고, 폰에서 LP·승률 칸이 화면 밖으로 밀려 옆으로 스크롤해야
             보였다. 2026-08-15에 LP·승률·티어 이름을 전부 흰색으로 통일하면서 색도
             CSS 로 갔다 — 이제 이 표에 인라인 style= 이 하나도 없다. style.css 16번 절 참고. -->
        <div class="rank-table-wrap">
            <table class="rank-table">
                <thead>
                    <tr>
                        <th class="rank-num">순위</th>
                        <th class="rank-name">닉네임</th>
                        <th class="rank-tier">티어</th>
                        <th class="rank-lp">LP</th>
                        <th class="rank-wr">승률</th>
                        <th class="rank-mastery">숙련도 TOP5</th>
                    </tr>
                </thead>
                <tbody class="ranking-body">${rowsHtml}</tbody>
            </table>
        </div>`;

    // ★ 표를 왼쪽 칸에 담고 오른쪽에 컷라인 그래프를 세로로 쌓는다 (2026-08-18).
    //   `.rank-main` 에 **min-width: 0 이 반드시 있어야 한다** — 표가 min-width: 600px
    //   이라 flex 항목이 안 줄어들면 오른쪽 칸을 밀어내고 가로로 넘친다.
    listDiv.innerHTML =
        `<div class="rank-layout">
            <div class="rank-main"><div class="rank-topline">${countHtml}${cutlineHtml}</div>${tableHtml}${rankPagerHtml(page, totalPages)}</div>
            ${rankCutoffSideHtml()}
        </div>`;

    // 표를 매번 새로 그리므로 위임 리스너도 매번 붙인다 (tbody 하나에만 붙는다)
    const body = listDiv.querySelector('.ranking-body');
    if (body) {
        body.addEventListener('click', (e) => {
            const link = e.target.closest('.summoner-link');
            if (!link) return;
            document.getElementById('dogu-search-input').value = link.dataset.name;
            executeSearch();
        });
    }

    // 검색어를 칠 때마다 맨 위로 튀면 입력칸이 시야에서 사라진다
    if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

let currentMasterData = [];
let currentMasterSortCol = 'games';
let currentMasterSortAsc = false;
let currentChampId = '';
let currentChampName = '';

async function showMasters(requestedChampId = null) {
    // 메뉴를 가려도 /masters 주소를 직접 치면 들어올 수 있어서 여기서도 막는다
    if (HIDE_UNFINISHED_PAGES) { goLobby(); return; }

    if (!window.location.pathname.startsWith('/masters')) {
        window.history.pushState({ page: 'masters' }, '', requestedChampId ? `/masters/${requestedChampId}` : '/masters');
    }

    hideAllContainers();
    const mastersContainer = document.getElementById('masters-container');
    mastersContainer.style.display = "block";
    mastersContainer.innerHTML = "<div style='text-align:center; padding:100px 0; min-height:100vh; color:var(--text-muted);'>데이터를 준비 중입니다...</div>";

    try {
        const ddragonRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion.json`);
        const ddragonData = await ddragonRes.json();

        let champList = [];
        for (let key in ddragonData.data) {
            const c = ddragonData.data[key];
            if (isClassicChamp(c.id)) continue;
            champList.push({ id: c.id, name: c.name });
        }
        champList.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

        mastersContainer.innerHTML = `
            <div class="stats-header">
                <h1 class="ranking-title">한국서버 장인 랭킹</h1>
                <p style="color: var(--text-muted); margin-top: 10px; font-size: 14px;">데이터베이스 이슈로 시즌15 마감기준 데이터가 제공됩니다.</p>
            </div>
            <div class="masters-wrap">
                <div class="masters-left"><div class="champ-grid" id="masters-champ-grid"></div></div>
                <div class="masters-right" id="masters-ranking-area"></div>
            </div>
        `;

        const grid = document.getElementById('masters-champ-grid');
        grid.innerHTML = champList.map(champ => `
            <div class="champ-grid-item" data-id="${champ.id}" data-name="${champ.name}" title="${champ.name}">
                <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champ.id}.png" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/0.png'">
            </div>
        `).join('');

        const gridItems = document.querySelectorAll('.champ-grid-item');

        gridItems.forEach(item => {
            item.addEventListener('click', (e) => {
                gridItems.forEach(i => i.classList.remove('active'));
                const target = e.currentTarget;
                target.classList.add('active');

                const cid = target.dataset.id;
                const cname = target.dataset.name;

                const newUrl = `/masters/${cid}`;
                if (window.location.pathname !== newUrl) {
                    window.history.pushState({ page: 'masters', champ: cid }, '', newUrl);
                }

                renderMasterRanking(cname, cid);
            });
        });

        if (gridItems.length > 0) {
            let targetItem = null;
            if (requestedChampId) {
                targetItem = Array.from(gridItems).find(i => i.dataset.id.toLowerCase() === requestedChampId.toLowerCase());
            }

            if (!targetItem) {
                targetItem = Array.from(gridItems).find(i => i.dataset.id === 'Lulu');
                if (!targetItem) targetItem = gridItems[0];
            }

            targetItem.classList.add('active');

            const cid = targetItem.dataset.id;
            const newUrl = `/masters/${cid}`;
            if (window.location.pathname !== newUrl) {
                window.history.replaceState({ page: 'masters', champ: cid }, '', newUrl);
            }

            renderMasterRanking(targetItem.dataset.name, cid);
        }

    } catch (e) {
        mastersContainer.innerHTML = `<div style='text-align:center; padding:50px; color:#f87171;'>오류가 발생했습니다: ${e.message}</div>`;
    }
}

function renderMasterRanking(champName, champId) {
    currentChampId = champId;
    currentChampName = champName;
    currentMasterData = mastersData[champId] || [];
    currentMasterSortCol = 'games';
    currentMasterSortAsc = false;
    renderMasterTable();
}

window.sortMasterData = function (col) {
    if (currentMasterSortCol === col) currentMasterSortAsc = !currentMasterSortAsc;
    else { currentMasterSortCol = col; currentMasterSortAsc = false; }
    renderMasterTable();
};

function renderMasterTable() {
    const rankingArea = document.getElementById('masters-ranking-area');
    if (!currentMasterData || currentMasterData.length === 0) {
        rankingArea.innerHTML = `<div style="text-align:center; padding: 100px 0; color: var(--text-muted);"><h2 style="color: #fff; margin-bottom: 10px;">데이터 준비 중</h2><p>아직 <b>${currentChampName}</b>의 장인 데이터가 수집되지 않았습니다.</p></div>`;
        return;
    }

    const getTierWeight = (tierStr) => {
        if (!tierStr) return 0;
        let t = tierStr.toUpperCase().trim();
        if (t === 'C' || t.includes('CHALLENGER')) return 100;
        if (t === 'GM' || t.includes('GRANDMASTER')) return 90;
        if (t === 'M' || t.includes('MASTER')) return 80;

        let baseScore = 0;
        if (t.startsWith('D')) baseScore = 70; else if (t.startsWith('E')) baseScore = 60; else if (t.startsWith('P')) baseScore = 50; else if (t.startsWith('G')) baseScore = 40; else if (t.startsWith('S')) baseScore = 30; else if (t.startsWith('B')) baseScore = 20; else if (t.startsWith('I')) baseScore = 10;

        let div = 0;
        if (t.includes('4') || t.endsWith('IV')) div = 1; else if (t.includes('3') || t.endsWith('III')) div = 2; else if (t.includes('2') || t.endsWith('II')) div = 3; else if (t.includes('1') || t.endsWith('I')) div = 4;
        return baseScore + div;
    };

    currentMasterData.sort((a, b) => {
        let valA = a[currentMasterSortCol], valB = b[currentMasterSortCol];
        if (currentMasterSortCol === 'tier') {
            valA = getTierWeight(valA); valB = getTierWeight(valB);
            if (valA === valB) return currentMasterSortAsc ? a.games - b.games : b.games - a.games;
        }
        if (valA < valB) return currentMasterSortAsc ? -1 : 1;
        if (valA > valB) return currentMasterSortAsc ? 1 : -1;
        return 0;
    });

    const getSortIcon = (col) => currentMasterSortCol !== col ? "<span style='color:var(--text-faint); font-size:12px; margin-left:4px;'>↕</span>" : (currentMasterSortAsc ? "<span style='color:#10b981; font-size:12px; margin-left:4px;'>▲</span>" : "<span style='color:#10b981; font-size:12px; margin-left:4px;'>▼</span>");
    const getFullTierName = (tierStr) => {
        if (!tierStr) return "";
        let t = tierStr.toUpperCase().trim();
        if (t === 'C' || t.includes('CHALLENGER')) return "Challenger"; if (t === 'GM' || t.includes('GRANDMASTER')) return "Grandmaster"; if (t === 'M' || t.includes('MASTER')) return "Master";
        let rank = "";
        if (t.startsWith('D')) rank = "Diamond"; else if (t.startsWith('E')) rank = "Emerald"; else if (t.startsWith('P')) rank = "Platinum"; else if (t.startsWith('G')) rank = "Gold"; else if (t.startsWith('S')) rank = "Silver"; else if (t.startsWith('B')) rank = "Bronze"; else if (t.startsWith('I')) rank = "Iron";
        if (!rank) return tierStr;
        let div = "";
        if (t.includes('4') || t.endsWith('IV')) div = "IV"; else if (t.includes('3') || t.endsWith('III')) div = "III"; else if (t.includes('2') || t.endsWith('II')) div = "II"; else if (t.includes('1') || t.endsWith('I')) div = "I";
        return div ? `${rank} ${div}` : rank;
    };

    let tableHtml = `
        <div style="overflow-x: auto;">
            <table class="master-table" style="min-width: 500px;">
                <thead>
                    <tr>
                        <th style="width: 8%; text-align: center;">#</th>
                        <th style="width: 40%;">소환사명</th>
                        <th style="width: 16%; cursor: pointer;" onclick="sortMasterData('tier')">티어 ${getSortIcon('tier')}</th>
                        <th style="width: 12%; text-align: center; cursor: pointer;" onclick="sortMasterData('games')">판수 ${getSortIcon('games')}</th>
                        <th style="width: 12%; text-align: center; cursor: pointer;" onclick="sortMasterData('winRate')">승률 ${getSortIcon('winRate')}</th>
                        <th style="width: 12%; text-align: center; cursor: pointer;" onclick="sortMasterData('kda')">평점 ${getSortIcon('kda')}</th>
                    </tr>
                </thead>
                <tbody>
    `;

    currentMasterData.forEach((player, index) => {
        let tierBadgeClass = "m";
        let tUpper = player.tier.toUpperCase();
        if (tUpper === "C" || tUpper.includes("CHALLENGER")) tierBadgeClass = "c"; else if (tUpper === "GM" || tUpper.includes("GRANDMASTER")) tierBadgeClass = "gm"; else if (tUpper.includes("D")) tierBadgeClass = "d"; else if (tUpper.includes("E")) tierBadgeClass = "e";

        const fullTierName = getFullTierName(player.tier);
        const lpDisplay = player.lp > 0 ? `<span style="font-weight: 700; color: #fff; font-size: 16px;">${player.lp} <span style="font-weight: normal; color: var(--text-muted); font-size: 12px;">LP</span></span>` : '';

        tableHtml += `
            <tr>
                <td style="text-align: center; color: #fff; font-weight: 700;">${index + 1}</td>
                <td>
                    <div class="master-summoner">
                        <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${currentChampId}.png" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/0.png'">
                        <div><div class="summoner-link" onclick="document.getElementById('dogu-search-input').value='${player.name}'; executeSearch();" title="${player.name} 검색">${player.name}</div></div>
                    </div>
                </td>
                <td><div class="master-tier"><span class="tier-badge ${tierBadgeClass}" style="white-space: nowrap;">${fullTierName}</span> ${lpDisplay}</div></td>
                <td style="text-align: center; color: var(--text-bright);">${player.games}</td>
                <td style="text-align: center; color: #10b981; font-weight: 700;">${Number(player.winRate).toFixed(2)}%</td>
                <td style="text-align: center; color: var(--text-bright); font-weight: 700;">${Number(player.kda).toFixed(2)}</td>
            </tr>
        `;
    });

    tableHtml += `</tbody></table></div>`;
    rankingArea.innerHTML = tableHtml;
}

// ==========================================
// [8] 부가기능 (개인정보, 약관, 이메일복사 등)
// ==========================================
window.showPrivacyPolicy = function () {
    if (window.location.pathname !== '/privacy') window.history.pushState({ page: 'privacy' }, '', '/privacy');
    hideAllContainers();
    document.getElementById('privacy-container').style.display = "block";
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.showTerms = function () {
    if (window.location.pathname !== '/terms') window.history.pushState({ page: 'terms' }, '', '/terms');
    hideAllContainers();
    document.getElementById('terms-container').style.display = "block";
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ============================================================
//  오늘의 신화 상점 (2026-08-16에 실제 데이터로 교체)
//
//    예전엔 아이템 4개가 하드코딩돼 있었다. 지금은 윈도우 로컬 수집기가 롤 클라
//    화면을 읽어 POST /api/mythic-shop 으로 보낸 걸 /today 로 받아 그린다.
//
//    ★★ 수집이 반자동이라 **그날 데이터가 없는 날이 생긴다.** 그때 어제 것이 오늘 것처럼
//      보이면 안 되므로 `items: null` 을 반드시 구분해서 표시한다. 서버가 404 가 아니라
//      200 + items:null 로 주는 이유도 이것이다 (404 면 서버 오류와 구분이 안 된다).
//    ★ `date` 는 **UTC 기준**이다. 로테이션이 00:00 UTC(한국 09:00) 갱신이라
//      한국 날짜와 하루 어긋날 수 있어서, 화면에 "N월 N일 로테이션" 이라고 적는다.
//    ★ 이미지는 `items[].image` 를 그대로 쓴다. **id 로 만들지 말 것** —
//      감정표현은 경로가 제각각이라 유추가 안 된다 (아이콘만 규칙적이다).
// ============================================================
const ME_GEM_ICON = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/rarity-gem-icons/mythic.png";
const MYTHIC_FALLBACK_IMG = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/hextech-images/chest.png";

// ============================================================
//  판매 기간 · 초기화 시각 (2026-08-17)
//
//    ★★ 날짜를 박아 두지 않는다. **기준 시각 하나 + 주기**로 계산한다 —
//      박아 두면 다음 로테이션부터 조용히 틀린 값이 나간다.
//    ★ 초기화는 전부 **한국시간 09:00 = 00:00 UTC** 다. 그래서 UTC 자정을 기준으로 세면 된다.
//      (수집기 쪽 `SECTIONS` 도 같은 규칙이다)
// ============================================================
const KST_OFFSET = 9 * 3600000;

const MYTHIC_RESET = {
    daily: { step: 1, anchor: '2026-08-17', tip: '매일 09시 초기화' },
    weekly: { step: 7, anchor: '2026-08-20', tip: '매주 목요일 09시 초기화' },   // 8/20 = 목요일
    biweekly: { step: 14, anchor: '2026-08-19', tip: '격주 수요일 09시 초기화' }  // 8/19 = 수요일 (초기화 주)
    // 추천은 없다 — 로테이션이 아니라 **상품마다 판매 종료가 다르다** (아래 MYTHIC_ITEM_END)
};

// 지금이 속한 판매 기간 [start, end)
function mythicPeriod(section, now = Date.now()) {
    const r = MYTHIC_RESET[section];
    if (!r) return null;
    const step = r.step * 86400000;
    const anchor = Date.parse(r.anchor + 'T00:00:00Z');
    // ★ floor 라 기준 시각보다 과거여도(음수) 맞게 나온다
    const start = anchor + Math.floor((now - anchor) / step) * step;
    return { start, end: start + step, tip: r.tip };
}

// "2026. 08. 17. 09:00" — 한국시간으로 찍는다
function fmtKst(ms) {
    const d = new Date(ms + KST_OFFSET);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}. ${p(d.getUTCMonth() + 1)}. ${p(d.getUTCDate())}. ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// "2026년 08월 27일 03:00"
function fmtKstLong(ms) {
    const d = new Date(ms + KST_OFFSET);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}년 ${p(d.getUTCMonth() + 1)}월 ${p(d.getUTCDate())}일 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// "2일 03:04:05 뒤 초기화" / 하루 미만이면 "03:04:05 뒤 초기화"
function remainText(until, suffix) {
    const diff = Math.max(0, until - Date.now());
    const p = n => String(n).padStart(2, '0');
    const day = Math.floor(diff / 86400000);
    const clock = `${p(Math.floor(diff / 3600000) % 24)}:${p(Math.floor(diff / 60000) % 60)}:${p(Math.floor(diff / 1000) % 60)}`;
    return day > 0 ? `${day}일 ${clock} ${suffix}` : `${clock} ${suffix}`;
}

// ★★ 추천 상품은 상품마다 판매 종료가 다른데 **수집기가 그 값을 안 준다.**
//   인게임 화면에는 남은 기간이 찍히므로 수집기가 읽어 보낼 수 있다 (SERVER_STATUS.md 에 요청해 뒀다).
//   그때까지는 손으로 적는다. **모르는 상품은 딱지를 안 붙인다** — 틀린 기한을 붙이는 것보다 낫다.
//   ★ 로테이션이 바뀌면 여기를 갈아야 한다. 안 갈면 딱지가 사라질 뿐 틀린 값이 나가지는 않는다.
const MYTHIC_ITEM_END = {
    'Together as 1': '2026-08-27 03:00',
    '프레스티지 T1 제이스': '2026-08-27 03:00',
    '프레스티지 T1 사일러스': '2026-08-27 03:00',
    '행성 파괴자 다리우스': '2026-09-11 03:00',
    '프레스티지 개선장군 다리우스': '2026-09-11 03:00',
    '프레스티지 메카 삼국 가렌': '2026-09-11 03:00',
    '프레스티지 개선장군 다리우스 (강렬)': '2026-09-11 03:00'
};

function mythicItemEnd(name) {
    const s = MYTHIC_ITEM_END[name];
    if (!s) return null;
    const ms = Date.parse(s.replace(' ', 'T') + ':00+09:00');   // 적어 둔 값은 한국시간이다
    return Number.isFinite(ms) ? ms : null;
}

function mythicDayLabel(date) {
    // "2026-08-16" → "8월 16일"
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    return m ? `${Number(m[2])}월 ${Number(m[3])}일` : '';
}

function mythicRotationLabel(date) {
    // "2026-08-16" → "8월 16일 로테이션"
    const d = mythicDayLabel(date);
    return d ? `${d} 로테이션` : '';
}

// 아직 수집 전(또는 초기화가 지났는데 새 상품이 안 들어옴)일 때의 안내 문구 (2026-08-19 통일).
//   "아직 오늘 로테이션을 수집하지 않았습니다" 는 우리 사정을 말하는 문장이라 바꿨다.
function mythicCollectingMsg(key) {
    if (key === 'featured') return '추천 상품을 수집 중입니다!';
    const info = MYTHIC_TABS.find(t => t.key === key);
    return `${info ? info.name : '일일'} 로테이션 상품을 수집 중입니다!`;
}

// ============================================================
//  홈 패치노트 영역 (2026-08-19)
//    왼쪽 목록만 서버(/api/patch-notes)에서 온다 — 공식 홈페이지 목록을 30분 캐시로
//    긁은 것이다. 오른쪽 PBE 칸은 X 자동 수집이 안 돼서 index.html 에 정적 안내다.
// ============================================================
// ==========================================
//  홈 위젯 — 라인별 추천 챔피언 (2026-09-01 신설, 로드맵 A-6)
//
//   홈에 통계로 가는 입구가 헤더 메뉴뿐이라 만들었다. **라인마다 티어 점수 상위 3명** —
//   점수 상위 5명을 통짜로 뽑으면 16.17 기준 정글이 셋(리 신·킨드레드·니달리)이라 라인이
//   치우친다 (사용자 결정 2026-09-01: 라인별 · 3명 · 가로 일자 카드).
//
//   ★★ 티어 점수는 통계 탭과 **같은 `computeLaneTiers`** 가 계산한다. 서버에 공식을 복제하면
//     두 벌이 되어 어긋난다 (TIER_COEF·TIER_CUTS 가 화면 쪽에만 있는 이유이기도 하다).
//     `/api/champion-stats` 는 gzip 16.8KB 라 홈에서 한 번 받아도 부담이 없고 서버 캐시도 있다.
//   ★ 실패하거나 표본이 없으면 **위젯을 통째로 숨긴다** (도감 채택률과 같은 정신).
//   ★★ 2026-09-08 부터 **골격이 index.html 에 박혀 있고 위젯은 보인 채로 시작한다** —
//     예전처럼 `display:none` 으로 시작하면 app.js 가 defer 라 첫 그림에 위젯이 없어서,
//     먼저 그려진 신화상점 위로 나중에 끼어들며 화면을 밀었다. 그래서 **숨기는 쪽이 예외**다:
//     실패·표본 0 일 때만 `display='none'` 으로 접는다 (아래 세 자리 — 전부 짝이다).
//   ★ 줄을 누르면 통계 상세로 간다 — 통계 표와 같이 **라인을 주소에 같이 넘긴다**
//     (안 넘기면 판수가 제일 많은 라인으로 물러나서 "탑 잭스" 를 눌러도 다른 라인이 뜬다).
// ★ 라인마다 몇 명을 보여줄지. 열 폭이 232px 라 이 이상은 세로로만 길어진다
const HOME_TIER_N = 3;

async function loadHomeTiers() {
    const box = document.getElementById('home-tier-container');
    if (!box) return;
    try {
        await fetchChampionMap();
        const res = await fetch('/api/champion-stats');
        const data = await res.json();
        // 박제된 패치(rows 가 파일에 있는 경우)는 홈에서까지 파일을 받지 않는다 — 그냥 안 그린다
        if (!data.ready || !data.rows?.length) { box.style.display = 'none'; return; }

        // 통계 탭의 collect() 와 같은 합산 (kb 는 'all' 하나뿐이다)
        const byKey = new Map();
        data.rows.forEach(r => {
            const k = `${r.champ}|${r.pos}`;
            let c = byKey.get(k);
            if (!c) byKey.set(k, c = { champ: r.champ, pos: r.pos, games: 0, wins: 0, bans: 0, banGames: 0 });
            c.games += r.games; c.wins += r.wins; c.bans += r.bans; c.banGames += r.banGames || 0;
        });
        const list = [...byKey.values()];
        const total = Object.values(data.totals || {}).reduce((a, b) => a + b, 0);
        const tiers = computeLaneTiers(list, total);

        // 라인마다 점수 상위 HOME_TIER_N 명
        const cols = STAT_POS.map(p => ({
            p,
            arr: list
                .map(c => { const t = tiers.get(`${c.champ}|${c.pos}`); return (t && c.pos === p.code) ? { ...c, ...t } : null; })
                .filter(Boolean)
                .sort((a, b) => b.score - a.score)
                .slice(0, HOME_TIER_N)
        })).filter(x => x.arr.length);
        if (!cols.length) { box.style.display = 'none'; return; }

        // ★ 여기만 「버전: 26.17」이다 (2026-09-08 사용자 요청). statScopeLabel 은 「26.17 패치」라
        //   통계 탭·패치 영향·도감이 다 같이 쓰므로 건드리지 않는다
        const sc = String(data.scope || '');
        document.getElementById('home-tier-scope').textContent =
            sc.startsWith('p:') ? `버전: ${patchDisplay(sc.slice(2))}` : statScopeLabel(sc);
        document.getElementById('home-tier-list').innerHTML = cols.map(({ p, arr }) => `
            <div class="home-tier-col">
                <div class="home-tier-colhead">
                    <img src="${STAT_LANE_ICON[p.key]}" alt="">
                    <span>${p.name}</span>
                    <span class="home-tier-colnote"><span>승률</span><span>픽률</span></span>
                </div>
                ${arr.map(c => {
            const eng = championIdMap[c.champ] || '0';
            const kor = (window.korChampMap || {})[eng] || eng;
            const win = c.games ? c.wins / c.games * 100 : 0;
            const pick = total ? c.games / total * 100 : 0;
            return `
                <div class="home-tier-row" data-champ="${eng}" data-lane="${p.key}" title="${kor} · ${p.name} · 승률 ${win.toFixed(1)}% · 픽률 ${pick.toFixed(1)}%">
                    <img class="home-tier-portrait"
                         src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${eng}.png" alt="" loading="lazy">
                    <span class="home-tier-name">${kor}</span>
                    <span class="stats-tier ${tierClass(c.tier)} home-tier-badge" title="점수 ${c.score.toFixed(2)}">${c.tier === 'OP' ? 'OP' : c.tier + '티어'}</span>
                    <span class="home-tier-num"><span>${win.toFixed(1)}%</span><span>${pick.toFixed(1)}%</span></span>
                </div>`;
        }).join('')}
            </div>`).join('');
        box.style.display = '';

        document.getElementById('home-tier-list').addEventListener('click', (e) => {
            const row = e.target.closest('.home-tier-row');
            if (!row) return;
            const url = `/stats/${row.dataset.champ}/${row.dataset.lane}`;
            window.history.pushState({ page: 'stats', champ: row.dataset.champ, lane: row.dataset.lane }, '', url);
            showChampStatPage(row.dataset.champ, row.dataset.lane);
        });
    } catch (e) {
        // 곁가지라 조용히 넘긴다 — 홈의 나머지는 그대로 나온다.
        // ★ 골격을 먼저 띄우므로 실패하면 도로 접어야 한다 (안 접으면 빈 칸이 남는다)
        box.style.display = 'none';
    }
}

async function loadPatchNotes() {
    const box = document.getElementById('patch-note-list');
    if (!box) return;

    const fmtDate = (iso) => {
        const d = iso ? new Date(iso) : null;
        const p = x => String(x).padStart(2, '0');
        return d && !isNaN(d) ? `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}` : '';
    };
    const row = (url, title, date) => `<a class="patch-note-item" href="${escapeHtml(url)}" target="_blank" rel="noopener">
            <span class="patch-note-title">${escapeHtml(title)}</span>
            <span class="patch-note-date">${fmtDate(date)}</span>
        </a>`;

    let data = null;
    try {
        const res = await fetch('/api/patch-notes');
        data = await res.json();
    } catch (e) { /* 아래에서 폴백 처리 */ }

    if (data && Array.isArray(data.official) && data.official.length) {
        box.innerHTML = data.official.slice(0, 5).map(n => row(n.url, n.title, n.date)).join('');
    } else {
        box.innerHTML = `<div class="patch-note-empty">패치노트를 불러오지 못했습니다.<br>
            <a class="patch-note-x-link" href="https://www.leagueoflegends.com/ko-kr/news/tags/patch-notes/" target="_blank" rel="noopener">공식 홈페이지에서 보기 →</a></div>`;
    }

    // ★ 오른쪽 PBE 칸 (2026-08-19 2차). 서버가 nitter RSS 에서 `Patch NN.NN [Full] Preview`
    //   글만 골라 x.com 주소로 준다 — 첫 줄에 Full 이 있으면 [상세], 없으면 [간단].
    //   비어 있으면(니터가 죽는 등) index.html 의 정적 안내(프로필 바로가기)를 그대로 둔다.
    const pbeBox = document.getElementById('pbe-note-list');
    if (pbeBox && data && Array.isArray(data.pbe) && data.pbe.length) {
        pbeBox.innerHTML = data.pbe.slice(0, 5).map(n =>
            row(n.url, `PBE 서버 ${n.patch} 패치 [${n.detail ? '상세' : '간단'}]`, n.date)).join('');
    }
}

window.loadMythicShop = async function () {
    const box = document.getElementById('mythic-items');
    if (!box) return;

    let data;
    try {
        const res = await fetch('/api/mythic-shop/today');
        data = await res.json();
        if (!data.ok) throw new Error('not ok');
    } catch (e) {
        box.innerHTML = `<div class="mythic-empty">신화 상점 정보를 불러오지 못했습니다.</div>`;
        return;
    }

    const label = document.getElementById('mythic-rotation');
    if (label) label.textContent = mythicRotationLabel(data.date);

    // ★ 아직 오늘 수집 전. 어제 것을 대신 보여주면 거짓말이 되므로 비워 두고 말한다.
    if (!data.items || !data.items.length) {
        box.innerHTML = `<div class="mythic-empty">${mythicCollectingMsg('daily')}</div>`;
        return;
    }

    box.innerHTML = data.items.map(mythicCardHtml).join('');
};

// 상품 카드 한 장. 첫 화면 위젯과 신화상점 탭이 **같은 것을 쓴다** —
//   두 벌로 두면 한쪽만 고쳤을 때 같은 상품이 화면마다 다르게 보인다.
//   ★ image 는 서버가 raw.communitydragon.org 로 시작하는지 이미 검증한 값이다
//     (validateMythicBody). 그래서 그대로 src 에 넣는다. 이름만 이스케이프한다.
// ★★ 그림 성격이 종류마다 달라서 채우는 법도 다르다 (2026-08-17 실측):
//   · 스킨   `<챔프>_splash_tile_<N>.jpg` **380x380 정사각 타일** → 칸을 꽉 채운다(잘라서)
//   · 크로마 `v1/champion-chroma-images/…` **270x303 투명 배경 3D 모델 렌더** →
//            **자르면 안 된다.** 인물이라 위아래가 잘리면 머리·발이 날아간다. 키우기만 한다
//   · 아이콘·감정표현 300x300 정사각 / `other` 는 이미지가 아예 없다(폴백 상자 아이콘)
//     → 예전처럼 가운데 작게. 폴백 아이콘을 늘리면 상자 그림만 커진다
//   ★ 이미지가 없으면 무조건 손대지 않는다 — 폴백을 채우면 우스워진다
const MYTHIC_FIT = { skin: 'is-art', chroma: 'is-render' };

// ★★ 스킨은 **수집기가 준 타일(380 정사각) 대신 가로 일러스트를 쓴다** (2026-08-17).
//   타일을 16:9 칸에 채우면 위아래가 41% 잘려 나가는데, 같은 자리에 가로 일러스트가 있다:
//     `<챔프>_splash_tile_<N>.jpg` → `<챔프>_splash_centered_<N>.jpg` (1280x720, 66~129KB)
//   **지금 상점의 스킨 17개 전부로 확인했다 — 17/17 성공.** 카드가 253px 이라 16:9 로 깔면
//   **잘리는 데가 하나도 없다.**
//   ★ "이미지 URL 은 수집기가 만든다" 는 규칙(감정표현은 경로가 제각각이라)에서 **스킨만
//     예외로 둔 것이다.** 안전한 이유는 세 가지다 — ① 스킨 경로는 규칙적이다
//     ② 못 찾으면 아래 onerror 가 **수집기가 준 타일로 되돌아간다** ③ 그것마저 실패하면 상자 아이콘.
const mythicWideSplash = (url) =>
    (url && url.includes('_splash_tile_')) ? url.replace('_splash_tile_', '_splash_centered_') : null;

// 유도한 일러스트 → (실패) 수집기가 준 원본 → (실패) 상자 아이콘. 두 단계로 물러난다.
window.mythicImgError = function (img) {
    const fb = img.dataset.fallback;
    if (fb && img.src !== fb) { img.src = fb; return; }
    img.onerror = null;
    img.src = MYTHIC_FALLBACK_IMG;
};

// ============================================================
//  신화상점 → 챔피언 스킨 탭 (2026-08-17)
//
//    ★★ **스킨마다 주소를 새로 박을 필요가 없다.** 수집기가 주는 `catalogId` 가
//      **CD 스킨 id (= 챔피언숫자키 x 1000 + 스킨번호)** 라, 그 하나로 챔피언까지 역산된다:
//        `98049` → `98` → championIdMap[98] = 'Shen' → /champions/Shen
//      크로마도 같은 꼴이다 (`86042` → 86 → Garen).
//    ★ 그래서 하는 일은 "id 를 들고 챔피언 페이지로 가서, 목록에서 그 id 를 찾아 고르기" 뿐이다.
//      `fetchCdSkins()` 가 스킨·크로마의 `id` 를 남기게 한 것이 이걸 위해서다.
//    ★ 주소에는 챔피언까지만 담긴다 (`/champions/Shen`). 스킨 번호까지 담으려면
//      진입부 pathParts 분기와 popstate 두 곳을 같이 고쳐야 해서 지금은 안 했다.
// ============================================================
window.pendingSkin = null;

async function openSkinFromMythic(catalogId, type) {
    const id = Number(catalogId);
    if (!id) return;
    if (!Object.keys(championIdMap || {}).length) await fetchChampionMap();

    const champId = championIdMap[Math.floor(id / 1000)];
    if (!champId) return;      // 모르는 챔피언이면 아무 일도 안 한다 (엉뚱한 곳으로 보내지 않는다)

    window.pendingSkin = { id, type };
    showChampions(champId);
}

// 탭을 코드로 옮긴다. switchChampTab 은 `event.currentTarget` 만 보므로 흉내 낸 객체면 된다.
//   ★ 버튼은 글자가 아니라 `data-tab` 으로 찾는다 — 이름이 바뀌어도 안 깨진다.
function goChampTab(tab) {
    const btn = document.querySelector(`.champ-tab-btn[data-tab="${tab}"]`);
    if (btn) switchChampTab({ currentTarget: btn }, tab);
}

// 챔피언 페이지가 다 그려진 뒤에 불린다. 들어온 요청대로 탭·스킨을 맞춰 준다.
//   요청은 두 갈래인데 하는 일은 같다:
//     · `pendingSkin`      — 신화상점 카드에서 넘어옴 (CD 스킨/크로마 id)
//     · `pendingChampView` — 주소로 들어옴 (`/champions/Shen/skins/49`)
function applyPendingChampView() {
    const fromShop = window.pendingSkin;
    const fromUrl = window.pendingChampView;
    // ★ 한 번 쓰고 반드시 버린다 — 안 그러면 다음에 여는 챔피언에도 따라붙는다
    window.pendingSkin = null;
    window.pendingChampView = null;
    if (!fromShop && !fromUrl) return;

    const list = window.currentSkinList || [];
    let tab = 'skins', idx = -1, chromaIdx = -1;

    if (fromShop) {
        if (fromShop.type === 'chroma') {
            // 크로마는 "그 크로마를 가진 스킨" 을 찾아 고른 뒤 색점까지 눌러 준다
            list.forEach((s, i) => {
                const ci = (s.chromas || []).findIndex(c => c.id === fromShop.id);
                if (ci >= 0) { idx = i; chromaIdx = ci; }
            });
        } else {
            idx = list.findIndex(s => s.id === fromShop.id);
        }
    } else {
        tab = CHAMP_TABS.includes(fromUrl.tab) ? fromUrl.tab : 'skills';
        if (tab === 'skins' && fromUrl.skin != null && fromUrl.skin !== '') {
            // ★ 배열 자리가 아니라 **스킨 번호**로 찾는다 (가렌은 11 다음이 13 이다)
            idx = list.findIndex(s => s.num === Number(fromUrl.skin));
        }
    }

    // ★ 탭은 옮긴다 — 스킨을 못 찾아도(목록이 DD 폴백이면 번호가 없을 수 있다) 그 탭까지는 가는 게 맞다
    if (tab !== 'skills') goChampTab(tab);

    if (idx < 0) return;
    selectSkin(idx);
    if (chromaIdx >= 0) selectChroma(chromaIdx);

    // 목록이 길면 고른 스킨이 화면 밖에 있다 (미스 포츈은 24개다).
    //   ★★ `scrollIntoView` 를 쓰면 안 된다 — 목록만이 아니라 **페이지까지 같이 끌어내려서**
    //     챔피언 탭 줄이 화면 위로 잘려 나간다 (실제로 그렇게 났다).
    //     목록은 자기 스크롤을 가지므로 그 `scrollTop` 만 직접 옮긴다.
    const box = document.querySelector('.skin-list');
    const el = document.querySelector('.skin-item.active');
    if (box && el) box.scrollTop = el.offsetTop - (box.clientHeight - el.clientHeight) / 2;
}

// ★★ 넥서스 마무리 효과는 수집기가 그림을 못 붙인다 (2026-08-17).
//   `Together as 1`(T1 넥서스 효과)이 **`type: other · catalogId 없음 · score 0`** 으로 왔다 —
//   수집기 카탈로그가 아이콘·감정표현·스킨만 알아서 이 종류를 통째로 못 알아본 것이다.
//   ★ CD 에 따로 있다: **`v1/nexusfinishers.json`** — 게임 전체에 **6개뿐**이고
//     아이콘(480x480) · 스플래시(1417x979) · **영상(webm)** 까지 들어 있다.
//   ★ **이름으로 맞춘다.** `catalogId` 가 안 오므로 붙일 열쇠가 그것뿐이다
//     (`translatedName` 이 클라 표기 그대로라 그대로 맞는다). 못 찾으면 예전처럼 상자 아이콘.
//   ★ 스플래시가 더 잘 어울리지만 **1.15MB 라 안 쓴다** — 카드 한 장이 격주 탭 전체(1.1MB)와
//     맞먹는다. 아이콘은 223KB 고 잔이 한가운데라 16:9 로 잘려도 멀쩡하다.
let nexusFinisherMap = null;

async function loadNexusFinishers() {
    if (nexusFinisherMap) return nexusFinisherMap;
    nexusFinisherMap = {};
    try {
        // 한국어판을 본다 — 다른 효과들은 이름이 번역돼 있다 (`여명의 쇄도` 등)
        const res = await fetch(CD_ASSET_BASE.replace('/global/default/', '/global/ko_kr/') + 'v1/nexusfinishers.json');
        const arr = await res.json();
        (Array.isArray(arr) ? arr : Object.values(arr)).forEach(f => {
            if (!f.translatedName || !f.iconPath) return;
            nexusFinisherMap[f.translatedName] = {
                icon: cdAssetUrl(f.iconPath),
                // ★ 영상이 진짜 물건이다 — 480x480 · 4.96초 · 소리 없음 (실측).
                //   아이콘·스플래시는 **정지 PNG 다** (APNG 도 아니다. 청크에 `acTL` 이 없다)
                video: cdAssetUrl(f.videoPath)
            };
        });
    } catch (e) { /* 못 받아도 그만 — 상자 아이콘으로 간다 */ }
    return nexusFinisherMap;
}

function mythicCardHtml(item) {
    // 수집기가 그림을 못 준 물건은 넥서스 효과인지 이름으로 되짚어 본다
    const finisher = !item.image && nexusFinisherMap ? nexusFinisherMap[item.name] : null;
    const fit = item.image ? (MYTHIC_FIT[item.type] || '') : (finisher ? 'is-art' : '');
    const wide = fit === 'is-art' ? mythicWideSplash(item.image) : null;
    const src = wide || item.image || finisher?.icon || MYTHIC_FALLBACK_IMG;

    // ★ 넥서스 효과는 **움직이는 게 본체다.** 정지 그림을 `poster` 로 깔아 두고 그 위에
    //   영상을 틀어서, 못 받아도 아이콘이 그대로 남게 한다 (소리 없는 5초짜리 반복).
    //   `muted` 가 없으면 브라우저가 자동재생을 막는다 — 빼지 말 것.
    const media = finisher?.video
        ? `<video src="${finisher.video}" poster="${finisher.icon}" autoplay loop muted playsinline></video>`
        : `<img src="${src}" alt="" loading="lazy"
                 data-fallback="${item.image || MYTHIC_FALLBACK_IMG}"
                 onerror="mythicImgError(this)">`;
    // 스킨·크로마는 누르면 그 스킨 일러스트를 보러 간다. 아이콘·감정표현은 갈 곳이 없다.
    const goto = (item.type === 'skin' || item.type === 'chroma') && item.catalogId
        ? ` data-skin-id="${item.catalogId}" data-skin-type="${item.type}"` : '';
    // 판매 종료를 아는 상품은 남은 시간 딱지를 붙인다 (지금은 추천 구획만 해당)
    //   ★★ 딱지는 **그림 칸 밖 · 카드 바로 아래**에 둔다. 그림 칸 안에 넣으면 그 칸이
    //     모서리를 깎느라 `overflow: hidden` 이라 **툴팁이 잘린다** (처음엔 그것 때문에
    //     네이티브 `title` 을 썼는데, 흰 배경이라 사이트 툴팁과 따로 놀았다).
    const endMs = mythicItemEnd(item.name);
    const timer = endMs
        ? `<span class="mythic-item-timer js-shop-timer" data-until="${endMs}" data-suffix="남음"
                 data-tooltip="${fmtKstLong(endMs)} 판매종료"></span>`
        : '';

    return `
        <div class="mythic-item-card ${fit}${goto ? ' is-link' : ''}${finisher?.video ? ' is-finisher' : ''}"${goto}>
            ${timer}
            <div class="mythic-item-img-box">${media}</div>
            <div class="mythic-item-info">
                <span class="mythic-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                <div class="mythic-item-price"><img src="${ME_GEM_ICON}" style="width: 13px; height: 13px;"><span style="color: #facc15; font-size: 14px; font-weight: 700;">${item.price}</span></div>
            </div>
        </div>
    `;
}

// ★ `.js-shop-timer` 를 전부 훑는다 — 첫 화면 위젯 · 구획 헤더 · 추천 상품 딱지가
//   같은 시계를 쓰고, 뒤 둘은 생겼다 없어지기 때문이다.
//   ★★ 각자 목표 시각을 `data-until` 로 들고 있다. 없으면 **일일 초기화**로 본다 —
//     첫 화면 위젯이 그 경우다 (예전 동작 그대로).
window.updateShopTimer = function () {
    const dailyEnd = mythicPeriod('daily').end;

    // ★★ 페이지를 켜 둔 채 초기화 시각(한국 09:00)을 넘기면 화면을 다시 그린다 (2026-08-19).
    //   안 그러면 타이머만 0 으로 돌고 **어제 상품이 계속 걸려 있었다.**
    //   새 로테이션이 아직 수집 전이면 이번엔 "수집 중입니다" 안내가 나간다.
    if (!window._shopRolloverEnd) window._shopRolloverEnd = dailyEnd;
    if (Date.now() >= window._shopRolloverEnd) {
        window._shopRolloverEnd = mythicPeriod('daily').end;
        mythicTodayCache = null;
        Object.keys(mythicSectionCache).forEach(k => delete mythicSectionCache[k]);
        loadMythicShop();
        const mythicBox = document.getElementById('mythic-container');
        const activeTab = document.querySelector('.mshop-tab.active');
        if (mythicBox && mythicBox.style.display !== 'none' && activeTab) {
            renderMythicSection(activeTab.dataset.tab);
        }
    }

    document.querySelectorAll('.js-shop-timer').forEach(el => {
        const until = Number(el.dataset.until) || dailyEnd;
        // ★ 추천 상품 딱지가 0 이 되면 그 카드를 뗀다 (2026-08-27) — 판매가 끝난 상품이 켜 둔 화면에 남지 않게
        if (el.classList.contains('mythic-item-timer') && until <= Date.now()) {
            const card = el.closest('.mythic-item-card');
            if (card) { card.remove(); return; }
        }
        el.innerText = remainText(until, el.dataset.suffix || '뒤 초기화');
    });
};

// ============================================================
//  신화상점 탭 (2026-08-17 신설)
//    메뉴는 도감 오른쪽. 소메뉴 4개는 **인게임 상점의 구획을 그대로 따랐다** —
//    추천 / 격주 / 주간 / 일일.
//
//    ★★ 지금 데이터가 있는 건 **일일 하나뿐이다.** 나머지 셋은 수집기가 아직 안 보내고,
//      **보내도 지금 서버가 거절한다** — validateMythicBody(server.js) 가 type 을
//      `icon|emote` 로, price 를 `5|25` 로 못 박고 있어서 스킨·크로마·와드가 오면 400 이다.
//      게다가 `date` 가 unique 라 한 날짜에 문서가 하나뿐이다. 네 구획을 담으려면
//      `section` 같은 칸이 필요한데, **형식은 수집기 쪽 SERVER_SPEC.md 가 정본**이라
//      거기 정해지면 그때 서버를 고친다. 화면은 그때 renderMythicSection 만 채우면 된다.
//
//    ★ 기본 탭은 `추천` 이다(인게임 순서). 그래서 **들어오자마자 "준비 중" 이 보이는 게
//      정상이다** — 고장으로 안 읽히게 안내 문구에 이유를 적고 일일로 가는 버튼을 둔다.
//
//    ★ 주소는 `/mythic/<탭키>` 다. 새 주소를 만들었으니 app.js 진입부의 pathParts 분기와
//      popstate **두 곳을 같이 고쳤다** — 한쪽만 고치면 뒤로가기로 들어왔을 때 다르게 동작한다.
// ============================================================
const MYTHIC_TABS = [
    { key: 'featured', name: '추천', full: '추천 상품' },
    { key: 'biweekly', name: '격주', full: '격주 로테이션' },
    { key: 'weekly', name: '주간', full: '주간 로테이션' },
    { key: 'daily', name: '일일', full: '일일 로테이션' }
];

// ★ 자리막이 카드 수 — **그 구획을 처음 열 때만** 쓴다 (두 번째부터는 지난번에 받은 수를 안다).
//   격주 12 · 주간 8 은 style.css .mshop-grid 주석에 적힌 기준값이다.
const MYTHIC_SKEL_N = { featured: 4, biweekly: 12, weekly: 8, daily: 4 };

// 오늘 로테이션 응답을 잠깐 물고 있는다. 탭을 오갈 때마다 다시 부를 이유가 없다.
//   서버도 60초 캐시(myCache)라 그보다 길게 잡으면 수집 직후 옛 값이 남는다.
let mythicTodayCache = null;
async function fetchMythicToday() {
    if (mythicTodayCache && Date.now() - mythicTodayCache.at < 60000) return mythicTodayCache.data;
    const res = await fetch('/api/mythic-shop/today');
    const data = await res.json();
    if (!data.ok) throw new Error('not ok');
    mythicTodayCache = { at: Date.now(), data };
    return data;
}

// ★★ 일일 밖의 세 구획은 `/today` 가 아니라 `/section/<키>` 다 — **"오늘 것" 이 아니라
//   "마지막으로 수집한 것"** 을 받는다. 주간·격주는 며칠씩 그대로라 오늘 날짜로 찾으면
//   수집한 날이 아닌 이상 늘 빈손이 된다. 대신 서버가 `ageDays`·`stale` 을 같이 준다.
const mythicSectionCache = {};
async function fetchMythicSection(section) {
    const c = mythicSectionCache[section];
    if (c && Date.now() - c.at < 60000) return c.data;
    const res = await fetch(`/api/mythic-shop/section/${section}`);
    const data = await res.json();
    if (!data.ok) throw new Error('not ok');
    mythicSectionCache[section] = { at: Date.now(), data };
    return data;
}

async function showMythicShop(target) {
    // ★ 도감과 같은 규칙: 이미 /mythic 안에 있으면 밀어 넣지 않는다.
    //   popstate 로 들어왔을 때 또 push 하면 뒤로가기가 앞으로 되돌아간다.
    if (!window.location.pathname.startsWith('/mythic')) {
        window.history.pushState({ page: 'mythic' }, '', '/mythic');
    }
    hideAllContainers();
    const box = document.getElementById('mythic-container');
    box.style.display = 'block';

    let curTab = MYTHIC_TABS.some(t => t.key === target) ? target : 'featured';

    box.innerHTML = `
        <div class="mshop-header">
            <h1 class="ranking-title">신화급 상점</h1>
        </div>
        <div class="mshop-tabs">
            ${MYTHIC_TABS.map(t => `<button class="mshop-tab${t.key === curTab ? ' active' : ''}" data-tab="${t.key}">${t.name}</button>`).join('')}
        </div>
        <div class="mshop-body" id="mshop-body"></div>
    `;

    function selectTab(key) {
        curTab = key;
        document.querySelectorAll('.mshop-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === key));
        // 소메뉴도 주소에 담는다 (`/mythic/daily`). 새로고침·링크 공유가 그대로 산다.
        // ★ 구획을 옮겨도 **이력은 안 쌓는다** (2026-08-17). 네 구획을 훑어본 사람이
        //   페이지를 벗어나려고 뒤로가기를 네 번 누르게 되는 걸 막는다.
        //   주소는 그대로 바뀌므로 복사해서 보내는 건 똑같이 된다.
        const want = `/mythic/${key}`;
        if (window.location.pathname !== want) window.history.replaceState({ page: 'mythic' }, '', want);
        renderMythicSection(key);
    }

    document.querySelectorAll('.mshop-tab').forEach(b =>
        b.addEventListener('click', () => selectTab(b.dataset.tab)));

    // 첫 그리기는 주소를 안 건드린다 — /mythic 으로 들어온 사람을 굳이 밀지 않는다.
    renderMythicSection(curTab);

    // "일일 로테이션 보기" 버튼처럼 본문 안에서 탭을 옮기는 자리. 본문을 매번 새로 그리므로
    // 위임으로 한 번만 붙인다.
    document.getElementById('mshop-body').addEventListener('click', (ev) => {
        const go = ev.target.closest('[data-goto]');
        if (go) { selectTab(go.dataset.goto); return; }
        // 스킨·크로마 카드 → 그 스킨 일러스트 보는 곳으로
        const card = ev.target.closest('[data-skin-id]');
        if (card) openSkinFromMythic(card.dataset.skinId, card.dataset.skinType);
    });
}

// ★★ 제목 옆은 **다음 초기화까지 남은 시간**, 오른쪽 끝은 **판매 기간**이다 (2026-08-17).
//   예전엔 "8월 17일 기준 · 오늘" 과 "수집 2026. 8. 17. 오후 2:23:11" 이 있었는데,
//   둘 다 **우리가 언제 읽었나**를 말할 뿐 **언제까지 파는지**를 안 알려줬다.
//   ★ 추천은 로테이션이 아니라 상품마다 기한이 달라서 둘 다 없다 (카드에 딱지가 붙는다).
//   ★ 자리막이와 완성 화면이 **같은 머리글**을 써야 로딩이 끝날 때 제목이 안 흔들린다 (2026-09-08)
function mshopHeadHtml(info, key) {
    const period = mythicPeriod(key);
    return `
        <div class="mshop-section-head">
            <h2 class="mshop-section-title">${info.full}</h2>
            ${period ? `<span class="timer-text js-shop-timer" data-until="${period.end}" data-tooltip="${period.tip}"></span>` : ''}
            ${period ? `<span class="mshop-period" data-tooltip="판매 기간 (한국시간)">${fmtKst(period.start)} - ${fmtKst(period.end)}</span>` : ''}
        </div>`;
}

async function renderMythicSection(key) {
    const body = document.getElementById('mshop-body');
    if (!body) return;
    const info = MYTHIC_TABS.find(t => t.key === key);
    const isDaily = key === 'daily';

    // ★★ 「…을 불러오는 중입니다」 한 줄 → **머리글 + 카드 자리막이** 로 바꿨다 (2026-09-08 사용자 요청).
    //   글 한 줄만 있다가 카드 8~12장이 한꺼번에 나타나면 화면이 통째로 튀어서 "짠" 하고 어색했다.
    //   머리글(제목·남은 시간·판매 기간)은 **받아 올 게 없는 값**이라 처음부터 진짜를 그린다.
    //   ★ 카드 수는 지난번에 받은 수를 쓴다 — 캐시가 60초로 만료돼도 객체는 남아 있어 **개수는 안다**.
    //     처음 여는 구획만 MYTHIC_SKEL_N 의 기준값이다.
    const lastItems = isDaily ? mythicTodayCache?.data?.items : mythicSectionCache[key]?.data?.items;
    const skelN = lastItems?.length || MYTHIC_SKEL_N[key] || 4;
    body.innerHTML = mshopHeadHtml(info, key)
        + `<div class="mshop-grid">${`
        <div class="mythic-item-card mythic-card-skel">
            <div class="mythic-item-img-box"></div>
            <div class="mythic-item-info">
                <span class="mythic-item-name"></span>
                <div class="mythic-item-price"></div>
            </div>
        </div>`.repeat(skelN)}</div>`;
    updateShopTimer();   // 머리글 카운트다운을 바로 채운다 (1초 기다리면 빈 채로 깜빡인다)

    let data;
    try {
        data = isDaily ? await fetchMythicToday() : await fetchMythicSection(key);
    } catch (e) {
        body.innerHTML = `<div class="mythic-empty">신화 상점 정보를 불러오지 못했습니다.</div>`;
        return;
    }

    // 그림이 안 붙은 물건이 있으면 넥서스 효과 목록을 받아 둔다 (6개짜리라 가볍다)
    if ((data.items || []).some(i => !i.image)) await loadNexusFinishers();

    // ★ 아직 한 번도 안 들어온 구획. **빈 칸으로 두지 않는다** — 기본 탭이 추천이라
    //   들어오자마자 이 자리를 보게 되고, 아무 말도 없으면 고장으로 읽힌다.
    //   여기까지 오면 화면은 이미 완성돼 있다 — 수집기가 보내기 시작하면 저절로 켜진다.
    if (!isDaily && (!data.items || !data.items.length)) {
        body.innerHTML = `
            <div class="mshop-soon">
                <div class="mshop-soon-title">${mythicCollectingMsg(key)}</div>
                <p class="mshop-soon-desc">
                    이 구획은 아직 들어온 데이터가 없습니다. 수집이 시작되면 여기에 그대로 나옵니다.
                </p>
                <button class="mshop-goto" data-goto="daily">일일 로테이션 보기</button>
            </div>`;
        return;
    }

    // ★★ 초기화가 지났는데 새 로테이션이 아직 안 들어온 경우 (2026-08-19).
    //   서버의 stale 은 "주기(7·14일)보다 오래 묵었나" 라 로테이션이 갓 바뀐 직후를 못 잡는다 —
    //   수집 날짜가 **지금 판매 기간의 시작보다 앞이면** 그 상품은 이미 내려간 것이다.
    //   지난 상품을 최신인 척 보여주는 대신 수집 중 안내로 바꾼다 (일일 탭이 하던 것과 같은 원칙).
    const periodNow = mythicPeriod(key);
    if (!isDaily && periodNow && data.date
        && Date.parse(data.date + 'T00:00:00Z') < periodNow.start) {
        body.innerHTML = `
            <div class="mshop-soon">
                <div class="mshop-soon-title">${mythicCollectingMsg(key)}</div>
                <p class="mshop-soon-desc">
                    로테이션이 바뀌었는데 새 상품이 아직 수집되지 않았습니다.<br>
                    (마지막 수집: ${mythicDayLabel(data.date)})
                </p>
                <button class="mshop-goto" data-goto="daily">일일 로테이션 보기</button>
            </div>`;
        return;
    }

    // ★ 일일은 **오늘 수집 전이면 비워 두고 이유를 적는다.** 수집이 반자동(사용자가 상점
    //   화면을 열고 단축키를 눌러야 한다)이라 빈 날이 일상이고, 어제 것을 대신 보여주면
    //   거짓말이 된다. 서버가 404 가 아니라 200 + items:null 로 주는 이유가 이것이다.
    // ★ 추천 구획만 배치가 다르다 — 인게임 상점처럼 첫 상품을 크게 건다.
    //   **자리 기준이다**(1번 크게 / 2·3번 가로로 길게 / 나머지 한 줄). 상품 이름으로 짜면
    //   로테이션이 바뀌는 순간 깨진다. 자세한 건 style.css 의 `.is-featured` 주석.
    // ★ 판매 기간이 끝난 상품은 내린다 (2026-08-27, 사용자 요청). 추천은 로테이션이 아니라 **상품마다 종료가 달라서**
    //   수집이 새로 안 와도 화면에서 걸러야 한다 — `MYTHIC_ITEM_END`(손표)에 적힌 종료 시각이 지난 것. 종료를 모르는 상품은 둔다.
    //   켜 둔 페이지는 updateShopTimer 가 0 이 되는 순간 그 카드를 뗀다.
    const now = Date.now();
    const items = (data.items || []).filter(i => { const e = mythicItemEnd(i.name); return !(e && e <= now); });
    // ★ 추천도 다른 구획과 같은 격자(한 줄 4개)다 (2026-08-27, 사용자 요청). 예전 "1번 크게 / 2·3번 가로로" 배치(`.is-featured`)는
    //   CSS 만 남아 있고 안 붙인다.
    const cards = items.length
        ? `<div class="mshop-grid">${items.map(mythicCardHtml).join('')}</div>`
        : `<div class="mythic-empty">${mythicCollectingMsg(key)}</div>`;

    // ★★ 제목 옆은 **다음 초기화까지 남은 시간**, 오른쪽 끝은 **판매 기간**이다 (2026-08-17).
    //   예전엔 "8월 17일 기준 · 오늘" 과 "수집 2026. 8. 17. 오후 2:23:11" 이 있었는데,
    //   둘 다 **우리가 언제 읽었나**를 말할 뿐 **언제까지 파는지**를 안 알려줬다.
    //   ★ 추천은 로테이션이 아니라 상품마다 기한이 달라서 둘 다 없다 (카드에 딱지가 붙는다).
    // ★ 머리글은 자리막이가 이미 그린 것과 **같은 함수**다 — 두 벌로 두면 로딩→완료에서 머리글이 흔들린다
    body.innerHTML = mshopHeadHtml(info, key) + cards;
    // ★ 「마지막 수집이 N일 전입니다…」 딱지(.mshop-stale)는 2026-09-08 에 뺐다 (사용자 요청).
    //   서버의 `data.stale`·`data.ageDays` 는 그대로 온다 — 다시 붙이려면 위 cards 앞에
    //   `${data.stale ? '<div class="mshop-stale">…</div>' : ''}` 한 줄이면 된다.
    //   ★ 로테이션이 갓 바뀌었을 때의 안내(.mshop-soon)는 **그대로 둔다** — 그건 지난 상품을
    //     최신인 척 보여주지 않으려고 화면을 통째로 바꾸는 자리라 성격이 다르다.

    // 방금 만든 카운트다운·딱지를 바로 채운다 (1초 뒤 타이머를 기다리면 빈 채로 깜빡인다)
    updateShopTimer();
}

// copyEmail 은 지웠다 (2026-08-22) — 푸터의 "버그제보 및 피드백" 은 공통 파일이 클립보드 복사까지 한다

window.switchDetailTab = async function (event, matchId, tabName) {
    const wrapper = event.target.closest('.match-detail');

    wrapper.querySelectorAll('.detail-tab-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    wrapper.querySelectorAll('.detail-tab-content').forEach(c => c.classList.remove('active'));
    wrapper.querySelector(`#tab-${tabName}-${matchId}`).classList.add('active');

    if (tabName !== 'analysis' && tabName !== 'build') return;

    const tl = await ensureTimeline(matchId);

    if (tabName === 'analysis') {
        const body = wrapper.querySelector(`#analysis-body-${matchId}`);
        if (!body || body.dataset.drawn) return;
        body.dataset.drawn = '1';

        if (!tl.goldFrames) {
            body.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:40px;">그래프 데이터가 없습니다.</div>`;
            return;
        }

        renderTimelineTab(body, matchId, tl.goldFrames);
    }

    if (tabName === 'build') {
        const skillBody = wrapper.querySelector(`#skill-body-${matchId}`);
        const itemBody = wrapper.querySelector(`#item-body-${matchId}`);
        if (!skillBody || skillBody.dataset.drawn) return;
        skillBody.dataset.drawn = '1';

        const game = allMatches.find(m => m.matchId === matchId);
        const skillHtml = game ? buildSkillTableHtml(game, tl.myTimeline) : '';
        const itemHtml = buildItemOrderHtml(tl.myTimeline);

        skillBody.innerHTML = skillHtml || `<div style="text-align:center; color:var(--text-muted); padding:30px;">데이터가 없습니다.</div>`;
        itemBody.innerHTML = itemHtml || `<div style="text-align:center; color:var(--text-muted); padding:30px;">데이터가 없습니다.</div>`;
    }
};

// ==========================================
// 상세 표 가운데 팀 요약 (밴 / 오브젝트)
// ==========================================
// 밴을 안 한 자리에 쓰는 빈 초상화 (인게임 밴 슬롯과 같은 이미지)
const EMPTY_CHAMP_ICON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/-1.png';

// 밴 초상화 줄. 협곡 팀 요약과 아레나 상세가 같이 쓴다 — 두 벌을 두면 -1 처리가 어긋난다.
// 밴이 아예 없는 모드(칼바람·신속대전 등)는 빈 문자열이라 부르는 쪽이 줄을 통째로 생략하면 된다.
function champBanIconsHtml(ids) {
    if (!ids || ids.length === 0) return '';
    return ids.map(id => {
        // championId가 -1이면 시간 초과로 밴을 못 한 것. 인게임처럼 빈 초상화를 띄운다.
        if (!id || id <= 0) {
            return `<img class="ts-ban ts-ban-empty" src="${EMPTY_CHAMP_ICON}">`;
        }
        const eng = championIdMap[id];
        return `<img class="ts-ban" src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${eng}.png"
                     title="${(eng && window.korChampMap[eng]) || ''}" onerror="this.src='${EMPTY_CHAMP_ICON}'">`;
    }).join('');
}

// 아이콘은 미니맵 실루엣이라 원본 색이 흰색이다.
// CSS mask로 팀 색을 입히므로 여기서는 파일 이름만 갖는다.
// 나중에 public/ 로 옮기려면 이 상수만 '/objectives/' 로 바꾸면 된다.
const OBJECTIVE_ICON_BASE = '/objectives/';

const OBJECTIVE_LABELS = [
    ['baron', '내셔 남작', 'baron'],
    ['elderDragon', '장로 드래곤', 'dragon_elder'],
    ['riftHerald', '협곡의 전령', 'riftherald'],
    ['horde', '공허 유충', 'grub'],
    ['dragon', '드래곤', 'dragon'],
    ['tower', '포탑', 'tower'],
    ['inhibitor', '억제기', 'inhibitor']
];

function renderTeamSummaryRow(game) {
    const stats = game.teamStats || [];
    if (stats.length === 0) return '';

    const blue = stats.find(t => t.teamId === 100);
    const red = stats.find(t => t.teamId === 200);
    if (!blue || !red) return '';

    // 밴도 오브젝트도 전부 0이면(칼바람 등) 줄 자체를 만들지 않는다
    const totalBans = blue.bans.length + red.bans.length;
    const totalObj = [blue, red].reduce((sum, t) =>
        sum + Object.values(t.objectives || {}).reduce((a, b) => a + b, 0), 0);
    if (totalBans === 0 && totalObj === 0) return '';

    // 밴이 아예 없는 모드(칼바람·신속대전 등)는 자리만 비운다. 안내 문구도 넣지 않는다.
    const banHtml = champBanIconsHtml;

    const objHtml = (t) => OBJECTIVE_LABELS.map(([key, label, icon]) => {
        const n = t.objectives[key] || 0;
        return `
            <span class="ts-obj ${n === 0 ? 'zero' : ''}" data-tooltip="${label}">
                <span class="ts-obj-icon" style="--obj-icon:url('${OBJECTIVE_ICON_BASE}${icon}.png');"></span>
                <span class="ts-obj-val">${n}</span>
            </span>`;
    }).join('');

    const side = (t, name, cls) => `
        <div class="ts-row ${cls}">
            <span class="ts-side">${name}</span>
            <div class="ts-bans">${banHtml(t.bans)}</div>
            <div class="ts-objs">${objHtml(t)}</div>
        </div>`;

    return `
        <tbody class="team-summary">
            <tr>
                <td colspan="10">
                    <div class="ts-box">
                        ${side(blue, '블루팀', 'blue')}
                        ${side(red, '레드팀', 'red')}
                    </div>
                </td>
            </tr>
        </tbody>`;
}

// ==========================================
// 라인 정렬 / 포지션 판정
// ==========================================
const LANE_ORDER = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };

// teamPosition이 없는 모드(칼바람·아레나)나 판정 실패 시에는 원래 순서를 유지한다.
function sortByLane(list) {
    if (!list.every(p => p.teamPosition && LANE_ORDER[p.teamPosition] !== undefined)) return list;
    return list.slice().sort((a, b) => LANE_ORDER[a.teamPosition] - LANE_ORDER[b.teamPosition]);
}

// 선호 포지션 집계용. 라이엇 판정을 우선 쓰고, 없을 때만 예전 추측 방식으로 넘어간다.
const POS_KEY = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support' };

// ==========================================
// 전적 박스 뱃지
//   1위 판정은 모두 "그 경기 전체 플레이어" 기준이다. (같은 팀이 아니라)
//   동점이면 여럿에게 붙는다.
// ==========================================
function buildBadges(game, isArena, isAram) {
    const all = game.participants || [];
    const me = all.find(p => p.isSearchedUser);
    if (!me) return `<div class="pix-badges"></div>`;

    // 전체 최댓값. 값이 0뿐인 경기에는 뱃지를 주지 않는다.
    const topOf = (key) => {
        const max = Math.max(...all.map(p => Number(p[key]) || 0));
        return max > 0 && (Number(me[key]) || 0) === max;
    };

    const badges = [];
    const add = (cls, text) => badges.push(`<div class="pix-badge ${cls}">${text}</div>`);

    if (isArena || isAram) {
        // 아레나·칼바람: 라인·시야·오브젝트 개념이 없어서 전투 지표만 쓴다
        if (topOf('damage')) add('dmg-top', '딜량 1위');
        if (topOf('damageTaken')) add('tank-top', '탱킹 1위');
        if (topOf('kills')) add('kill-top', '킬 1위');
        if (topOf('assists')) add('assist-top', '도움 1위');
        // 처형·포탑 사망은 빼고 적 챔피언에게 죽은 적이 없을 때
        if ((me.champDeaths ?? me.deaths) === 0) add('no-death', '노데스');
        if (me.kp === 100) add('domination', '장악');

    } else {
        if (me.firstBlood) add('first-blood', '선취점');
        if (me.firstBloodAssist) add('first-blood-assist', '선취점 도움');
        if (me.multiKill) add('multi-kill', me.multiKill);
        if (topOf('damage')) add('dmg-top', '딜량 1위');
        if (me.soloKills > 0) add('solo-kill', `솔로킬 ${me.soloKills}`);
        if (me.steals > 0) add('steal', `스틸 ${me.steals}`);
        if (topOf('visionScore')) add('vision-top', '시야 1위');
        if (me.kp === 100) add('domination', '장악');
    }

    return `<div class="pix-badges">${badges.join('')}</div>`;
}

// ==========================================
// 진행 중인 게임 (Spectator)
// ==========================================
let liveGameData = null;
let liveGameOpen = false;

async function checkLiveGame(puuid) {
    const btn = document.getElementById('live-btn');
    const area = document.getElementById('live-game-area');
    if (!btn || !puuid) return;

    liveGameData = null;
    liveGameOpen = false;
    if (area) area.innerHTML = '';
    if (window.liveTimerInterval) clearInterval(window.liveTimerInterval);

    btn.disabled = true;
    btn.classList.remove('in-game');
    btn.title = '확인 중...';

    try {
        const res = await fetch(`/api/live/${puuid}`);
        const json = await res.json();

        if (json.inGame && json.game) {
            liveGameData = json.game;
            btn.disabled = false;
            btn.classList.add('in-game');
            btn.title = '진행 중인 게임 보기';
        } else {
            // 게임 중이 아닌 것과 조회 실패는 화면상 똑같이 회색이라, 이유를 툴팁으로 구분한다
            btn.title = '현재 게임 중이 아닙니다';
        }
    } catch (e) {
        btn.title = '인게임 정보를 불러올 수 없습니다';
    }
}

window.toggleLiveGamePanel = function () {
    const area = document.getElementById('live-game-area');
    if (!area || !liveGameData) return;

    liveGameOpen = !liveGameOpen;

    if (!liveGameOpen) {
        area.innerHTML = '';
        if (window.liveTimerInterval) clearInterval(window.liveTimerInterval);
        return;
    }

    area.innerHTML = renderLiveGameHtml(liveGameData);

    // 경과 시간을 1초마다 갱신
    const startedAt = Date.now() - liveGameData.gameLength * 1000;
    const tick = () => {
        const el = document.getElementById('live-timer');
        if (!el) { clearInterval(window.liveTimerInterval); return; }
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        el.innerText = `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초`;
    };
    tick();
    if (window.liveTimerInterval) clearInterval(window.liveTimerInterval);
    window.liveTimerInterval = setInterval(tick, 1000);
};

function liveChampIcon(championId) {
    const engName = championIdMap[championId];
    return engName
        ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${engName}.png`
        : `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/0.png`;
}

function liveRuneIcon(id) {
    return runePathMap[id]
        ? `https://ddragon.leagueoflegends.com/cdn/img/${runePathMap[id]}`
        : '';
}

function liveChampKorName(championId) {
    const engName = championIdMap[championId];
    return (engName && window.korChampMap[engName]) || engName || '알 수 없음';
}

// 룬이 없는 모드. 관전 API가 기본값을 채워 보내서 그냥 두면 엉뚱한 룬이 뜬다.
const LIVE_NO_RUNE_QUEUES = new Set([
    4310,   // 클래식 5대5
    2400,   // 무작위 총력전: 아수라장
    2450    // 아수라장 클래식 스타일
]);   // 일반 칼바람(450/720)은 룬이 있으므로 제외

function renderLivePlayer(p, side, showRunes = true, anyTier = false) {
    // 스트리머 모드(Riot ID 익명화)를 켠 사람은 riotId가 비어서 온다.
    // 이름 자리를 챔피언 이름으로 채운다. (포우·op.gg도 같은 방식)
    const anon = !p.riotId || !p.riotId.trim();
    const name = anon ? liveChampKorName(p.championId) : (p.riotId.split('#')[0] || '알 수 없음');
    const tag = anon ? '' : (p.riotId.split('#')[1] || '');

    const champ = `<img class="live-champ" src="${liveChampIcon(p.championId)}" onerror="this.style.visibility='hidden'">`;
    // ★ 마스터+ 티어 배지 (2026-09-03, 기능 감사 F1) — 상세 전적의 tierSlot() 과 같은 규칙:
    //   판에 한 명이라도 있어야 18px 슬롯을 만든다 (아무도 없는 판에 빈 칸을 두면 이름만 밀린다).
    //   좌우 대칭 배치라 배지는 초상화의 **바깥쪽**(블루는 오른쪽 끝, 레드는 왼쪽 끝)에 둔다
    const tier = !anyTier ? '' : `<span class="live-tier-slot">${p.rankTier
        ? `<img src="${RANK_MEDAL_BASE}${rankTierInfo(p.rankTier[0]).icon}.png" alt=""
               title="${rankTierInfo(p.rankTier[0]).name} · ${p.rankTier[1].toLocaleString()} LP" loading="lazy">`
        : ''}</span>`;
    const spells = `
        <div class="live-spells">
            ${spellImg(p.spell1)}
            ${spellImg(p.spell2)}
        </div>`;
    const runes = !showRunes ? '' : `
        <div class="live-runes">
            ${p.mainRune ? `<img src="${liveRuneIcon(p.mainRune)}" onerror="this.style.visibility='hidden'">` : '<span></span>'}
            ${p.subStyle ? `<img src="${liveRuneIcon(p.subStyle)}" onerror="this.style.visibility='hidden'">` : '<span></span>'}
        </div>`;
    const nameHtml = `
        <div class="live-name" title="${anon ? '비공개' : escapeHtml(p.riotId)}">
            <span class="live-name-main${anon ? ' anon' : ''}">${name}</span>${tag ? `<span class="live-name-tag">#${tag}</span>` : ''}
        </div>`;

    // 익명 사용자는 검색할 대상이 없으므로 클릭을 막는다.
    // ★ 클릭은 [data-search-name] document 위임이 받는다 (2026-09-04). 예전엔 onclick 문자열에
    //   riotId 를 박아서 홑따옴표만 막고 있었는데, 큰따옴표 하나면 속성을 탈출했다 —
    //   전적 카드에서 이미 고친 함정(S4)이 인게임 패널 두 자리에만 안 옮겨져 있었다
    const clickAttr = anon
        ? 'class="live-player %SIDE% anon" title="Riot ID를 비공개한 사용자입니다"'
        : `class="live-player %SIDE%" data-search-name="${escapeHtml(p.riotId || '')}"`;

    // 블루팀은 오른쪽 정렬, 레드팀은 왼쪽 정렬로 가운데를 향하게 배치
    return side === 'blue'
        ? `<div ${clickAttr.replace('%SIDE%', 'blue')}>
               ${runes}${spells}${nameHtml}${champ}${tier}
           </div>`
        : `<div ${clickAttr.replace('%SIDE%', 'red')}>
               ${tier}${champ}${nameHtml}${spells}${runes}
           </div>`;
}


// 인게임 패널은 공간이 넉넉해서 전적 목록보다 정식 명칭을 쓴다.
const LIVE_QUEUE_NAMES = {
    '솔로랭크': '개인/2인 랭크 게임',
    '자유랭크': '자유 랭크 게임',
    '칼바람': '무작위 총력전',
    '아수라장': '무작위 총력전: 아수라장',
    '아수라장(클래식)': '무작위 총력전: 아수라장 클래식 스타일',
    '아레나': '아레나 3x6',
    '일반(교차)': '일반 (교차 선택)',
    '일반(신속)': '일반 (신속 대전)',
    '봇전(입문)': '봇전 (입문)',
    '봇전(초보)': '봇전 (초보)',
    '봇전(중급)': '봇전 (중급)'
};

const LIVE_MAP_NAMES = {
    11: '소환사의 협곡',
    12: '무작위 맵',
    30: '아레나',
    453: '소환사의 협곡 (클래식)'
};

// 같은 mapId라도 모드에 따라 부르는 이름이 다른 경우
const LIVE_MAP_BY_QUEUE = {
    4310: '소환사의 협곡 (클래식)'
};

// 아레나는 3인 6팀이라 좌우 세 팀씩 나눠 놓는다.
function renderLiveArenaSide(teams) {
    return `
        <div class="live-arena-side">
            ${teams.map(t => `
                <div class="live-arena-team">
                    <span class="live-arena-no ${placementClass(t.id)}">${t.id}</span>
                    <div class="live-arena-players">
                        ${t.players.map(p => {
                            const anon = !p.riotId || !p.riotId.trim();
                            const name = anon ? liveChampKorName(p.championId) : p.riotId.split('#')[0];
                            const tag = anon ? '' : (p.riotId.split('#')[1] || '');
                            const click = anon ? '' : `data-search-name="${escapeHtml(p.riotId || '')}"`;
                            return `
                                <div class="live-arena-player ${anon ? 'anon' : ''}" ${click} title="${anon ? '비공개' : escapeHtml(p.riotId)}">
                                    <img src="${liveChampIcon(p.championId)}" onerror="this.style.visibility='hidden'">
                                    <span class="live-arena-name">${name}</span>${tag ? `<span class="live-arena-tag">#${tag}</span>` : ''}
                                </div>`;
                        }).join('')}
                    </div>
                </div>`).join('')}
        </div>`;
}

function renderLiveGameHtml(g) {
    // 밴이 없는 모드는 줄 자체를 만들지 않는다.
    // 밴 슬롯은 있는데 시간 초과로 못 한 자리(-1)는 빈 초상화로 채운다.
    const banHtml = (ids) => ids.length === 0
        ? ''
        : ids.map(id => (!id || id <= 0)
            ? `<img class="live-ban live-ban-empty" src="${EMPTY_CHAMP_ICON}">`
            : `<img class="live-ban" src="${liveChampIcon(id)}" onerror="this.src='${EMPTY_CHAMP_ICON}'">`).join('');

    const hasBans = g.bans.blue.length > 0 || g.bans.red.length > 0;
    const showRunes = !LIVE_NO_RUNE_QUEUES.has(g.queueId);

    // 서버가 추정한 라인 순으로 세운다. 추정이 안 된 모드는 원래 순서를 유지한다.
    const byLane = (arr) => arr.every(p => p.position && LANE_ORDER[p.position] !== undefined)
        ? arr.slice().sort((a, b) => LANE_ORDER[a.position] - LANE_ORDER[b.position])
        : arr;

    const blueTeam = byLane(g.teams.blue);
    const redTeam = byLane(g.teams.red);
    // 마스터+ 가 한 명이라도 있어야 배지 슬롯을 만든다 (상세 전적과 같은 규칙)
    const anyTier = blueTeam.concat(redTeam).some(p => p.rankTier);

    return `
        <div class="live-game-box">
            ${g.isArena && g.subteams
            ? renderLiveArenaSide(g.subteams.slice(0, 3))
            : `<div class="live-team blue">
                ${blueTeam.map(p => renderLivePlayer(p, 'blue', showRunes, anyTier)).join('')}
            </div>`}

            <div class="live-center">
                <div class="live-queue">${LIVE_QUEUE_NAMES[g.queueName] || g.queueName}</div>
                <div class="live-map">&lt; ${LIVE_MAP_BY_QUEUE[g.queueId] || LIVE_MAP_NAMES[g.mapId] || '소환사의 협곡'} &gt;</div>
                ${!hasBans ? '' : (g.isArena
                    // 아레나는 18명이라 한 줄로 늘어놓으면 너무 길다. 3개씩 끊는다.
                    ? `<div class="live-bans arena">${banHtml(g.bans.blue.concat(g.bans.red))}</div>`
                    : `<div class="live-bans">
                    <div class="live-ban-row">${banHtml(g.bans.blue)}</div>
                    <div class="live-ban-row">${banHtml(g.bans.red)}</div>
                </div>`)}
                <div class="live-timer" id="live-timer">-</div>
            </div>

            ${g.isArena && g.subteams
            ? renderLiveArenaSide(g.subteams.slice(3, 6))
            : `<div class="live-team red">
                ${redTeam.map(p => renderLivePlayer(p, 'red', showRunes, anyTier)).join('')}
            </div>`}
        </div>`;
}

// ==========================================
// 타임라인 탭 (팀 골드 / 골드 격차 / 챔피언별 골드)
// ==========================================

// 챔피언별 골드 선 색. 앞 5개가 블루팀, 뒤 5개가 레드팀.
const CHAMP_LINE_COLORS = [
    '#5383e8', '#38bdf8', '#2dd4bf', '#4ade80', '#a3e635',
    '#e84057', '#fb7185', '#f97316', '#facc15', '#c084fc'
];

// 세 그래프가 공유하는 축·툴팁 설정
function timelineChartScales() {
    return {
        x: { ticks: { color: 'var(--text-muted)', maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: 'var(--text-muted)', callback: (v) => (v / 1000).toFixed(0) + 'k' }, grid: { color: 'rgba(255,255,255,0.05)' } }
    };
}

window.champGoldCharts = window.champGoldCharts || {};

function renderTimelineTab(body, matchId, gf) {
    const players = gf.players || [];

    // 챔피언 토글 버튼 (블루 5 / 레드 5). 골드용과 경험치용을 따로 만든다.
    const toggleRow = (kind) => `
        <div class="tl-toggle-row" data-kind="${kind}">
            ${players.map((p, i) => `
                <button class="tl-champ-toggle" data-pid="${p.id}" data-kind="${kind}"
                        style="--line-color:${CHAMP_LINE_COLORS[i] || '#888'}"
                        onclick="toggleChampLine('${matchId}', ${p.id}, '${kind}')"
                        title="${p.name || p.champ}">
                    <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${p.champ}.png"
                         onerror="this.style.visibility='hidden'">
                </button>`).join('')}
        </div>`;

    body.innerHTML = `
        <h4 class="tl-chart-title">시간대별 팀 골드</h4>
        <div class="tl-chart"><canvas id="gold-chart-${matchId}"></canvas></div>

        <h4 class="tl-chart-title">골드 격차</h4>
        <div class="tl-chart">
            <canvas id="golddiff-chart-${matchId}"></canvas>
            <div class="tl-obj-layer" id="golddiff-objs-${matchId}"></div>
        </div>

        ${players.length === 0 ? '' : `
        <h4 class="tl-chart-title">챔피언별 골드</h4>
        ${toggleRow('gold')}
        <div class="tl-chart"><canvas id="champgold-chart-${matchId}"></canvas></div>

        <h4 class="tl-chart-title">챔피언별 경험치</h4>
        ${toggleRow('xp')}
        <div class="tl-chart"><canvas id="champxp-chart-${matchId}"></canvas></div>`}
    `;

    // ---- 1. 팀 골드 ----
    new Chart(body.querySelector(`#gold-chart-${matchId}`), {
        type: 'line',
        data: {
            labels: gf.labels,
            datasets: [
                { label: '블루팀', data: gf.blue, borderColor: '#5383e8', backgroundColor: 'rgba(83, 131, 232, 0.1)', fill: true, tension: 0.3, pointRadius: 1 },
                { label: '레드팀', data: gf.red, borderColor: '#e84057', backgroundColor: 'rgba(232, 64, 87, 0.1)', fill: true, tension: 0.3, pointRadius: 1 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: 'var(--text-muted)' } },
                tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + ctx.raw.toLocaleString() + ' G' } }
            },
            scales: timelineChartScales()
        }
    });

    // ---- 2. 골드 격차 (블루 - 레드) ----
    const diff = gf.blue.map((v, i) => v - (gf.red[i] || 0));
    const diffChart = new Chart(body.querySelector(`#golddiff-chart-${matchId}`), {
        type: 'line',
        data: {
            labels: gf.labels,
            datasets: [{
                label: '골드 격차',
                data: diff,
                borderColor: '#5383e8',
                borderWidth: 2,
                tension: 0.3,
                pointRadius: 1,
                // 점은 segment 설정을 안 따르고 borderColor를 쓴다. 따로 지정해야 한다.
                pointBackgroundColor: (ctx) => (diff[ctx.dataIndex] ?? 0) >= 0 ? '#5383e8' : '#e84057',
                pointBorderColor: (ctx) => (diff[ctx.dataIndex] ?? 0) >= 0 ? '#5383e8' : '#e84057',
                // 구간별로 0 위/아래를 판정해 선 색을 바꾼다
                segment: {
                    borderColor: (ctx) => {
                        const mid = (ctx.p0.parsed.y + ctx.p1.parsed.y) / 2;
                        return mid >= 0 ? '#5383e8' : '#e84057';
                    }
                },
                // 0선을 기준으로 위는 파랑, 아래는 빨강으로 채운다
                fill: {
                    value: 0,
                    above: 'rgba(83, 131, 232, 0.25)',
                    below: 'rgba(232, 64, 87, 0.25)'
                }
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const v = ctx.raw;
                            if (v === 0) return '격차 없음';
                            const team = v > 0 ? '블루팀' : '레드팀';
                            return `${team} +${Math.abs(v).toLocaleString()} G`;
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { color: 'var(--text-muted)', maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    ticks: { color: 'var(--text-muted)', callback: (v) => (v / 1000).toFixed(1) + 'k' },
                    grid: { color: (ctx) => ctx.tick.value === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.05)' }
                }
            }
        }
    });

    // 골드 격차 그래프 위에 오브젝트 처치 표시.
    // 축이 확정된 뒤여야 좌표가 맞아서, 애니메이션 완료 시점과 리사이즈 때 다시 배치한다.
    const drawObjMarkers = placeObjectiveMarkers(matchId, diffChart, gf);
    if (drawObjMarkers) {
        if (diffChart.options.animation) diffChart.options.animation.onComplete = drawObjMarkers;
        diffChart.options.onResize = () => requestAnimationFrame(drawObjMarkers);
        diffChart.update('none');   // 애니메이션 없이 즉시 렌더 -> 축 좌표가 바로 확정된다
        requestAnimationFrame(drawObjMarkers);
        setTimeout(drawObjMarkers, 1100);   // 애니메이션이 끝난 뒤 한 번 더 보정
    }

    // ---- 3. 챔피언별 골드 ----
    if (players.length > 0) {
        const makeChart = (canvasId, unit) => new Chart(body.querySelector(canvasId), {
            type: 'line',
            data: { labels: gf.labels, datasets: [] },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: 'var(--text-muted)', boxWidth: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} ${unit}` } }
                },
                scales: timelineChartScales()
            }
        });

        window.champGoldCharts[matchId] = {
            charts: {
                gold: makeChart(`#champgold-chart-${matchId}`, 'G'),
                xp: makeChart(`#champxp-chart-${matchId}`, 'XP')
            },
            players,
            root: body
        };

        // 검색한 소환사가 있으면 두 그래프 모두 기본으로 켜둔다
        const game = allMatches.find(m => m.matchId === matchId);
        const meIdx = game ? game.participants.findIndex(p => p.isSearchedUser) : -1;
        if (meIdx > -1 && players[meIdx]) {
            toggleChampLine(matchId, players[meIdx].id, 'gold');
            toggleChampLine(matchId, players[meIdx].id, 'xp');
        }
    }
}

// kind('gold' | 'xp')별로 독립 동작한다. 두 그래프는 서로 영향을 주지 않는다.
// 골드 격차 그래프의 0선 위에 오브젝트 처치 아이콘을 얹는다.
//   캔버스에 직접 그리지 않고 HTML을 겹치는 이유:
//   팀 색 마스크와 data-tooltip을 그대로 재사용할 수 있고, 클릭·호버 판정이 공짜다.
const OBJ_MARKER_MAP = {
    BARON_NASHOR: ['내셔 남작', 'baron'],
    RIFTHERALD: ['협곡의 전령', 'riftherald'],
    HORDE: ['공허 유충', 'grub'],
    DRAGON: ['드래곤', 'dragon'],
    ELDER_DRAGON: ['장로 드래곤', 'dragon_elder']
};

function placeObjectiveMarkers(matchId, chart, gf) {
    const layer = document.getElementById(`golddiff-objs-${matchId}`);
    if (!layer) return;

    const events = (gf.objectives || []).slice().sort((a, b) => a.t - b.t);
    if (events.length === 0) return;

    let lastKey = '';

    const draw = () => {
        const xs = chart.scales.x, ys = chart.scales.y;
        if (!xs || !ys || !chart.chartArea) return;

        const lastIdx = gf.labels.length - 1;
        const zeroY = ys.getPixelForValue(0);

        // 축이 그대로면 다시 그리지 않는다.
        // 매 프레임 새로 만들면 마우스를 올린 요소가 사라져 툴팁이 깜빡인다.
        const key = `${Math.round(zeroY)}|${Math.round(chart.chartArea.left)}|${Math.round(chart.chartArea.right)}`;
        if (key === lastKey) return;
        lastKey = key;

        layer.innerHTML = '';

        // 분 단위 소수 위치를 픽셀로. 라벨이 1분 간격이라 두 눈금 사이를 비례 배분한다.
        const xPixel = (minute) => {
            const i = Math.min(Math.floor(minute), lastIdx);
            const a = xs.getPixelForValue(i);
            const b = xs.getPixelForValue(Math.min(i + 1, lastIdx));
            return a + (b - a) * (minute - i);
        };

        // 높이는 딱 두 가지다. 블루는 0선 살짝 위, 레드는 살짝 아래.
        // 그래프의 "위=블루 / 아래=레드" 의미와도 맞고, 같은 시각에 양 팀이 먹어도 겹치지 않는다.
        const OFFSET = 9;

        events.forEach(ev => {
            const info = OBJ_MARKER_MAP[ev.subType === 'ELDER_DRAGON' ? 'ELDER_DRAGON' : ev.type];
            if (!info) return;   // 포탑·억제기 등은 표시하지 않음

            const [label, icon] = info;
            const isBlue = ev.teamId === 100;
            const x = xPixel(ev.t / 60000);
            const y = isBlue ? zeroY - OFFSET : zeroY + OFFSET;

            const sec = Math.floor(ev.t / 1000);
            const timeText = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

            // 바깥은 툴팁 담당, 안쪽은 아이콘 담당.
            // mask는 자식과 ::after까지 잘라내므로, 툴팁을 가진 요소에 mask를 걸면 안 된다.
            layer.insertAdjacentHTML('beforeend', `
                <span class="tl-obj-marker ${isBlue ? 'blue' : 'red'}"
                      style="left:${x}px; top:${y}px;"
                      data-tooltip="${isBlue ? '블루팀' : '레드팀'} ${label} 처치 (${timeText})">
                    <span class="tl-obj-marker-icon" style="--obj-icon:url('${OBJECTIVE_ICON_BASE}${icon}.png');"></span>
                </span>`);
        });
    };

    // 차트가 그려진 뒤의 좌표라야 정확하다.
    // chart.draw를 덮어쓰면 Chart.js 내부 동작이 깨지므로 건드리지 않는다.
    return draw;
}

window.toggleChampLine = function (matchId, pid, kind) {
    const ctx = window.champGoldCharts[matchId];
    if (!ctx) return;

    const { charts, players, root } = ctx;
    const chart = charts[kind];
    if (!chart) return;

    const idx = players.findIndex(p => p.id === pid);
    if (idx === -1) return;

    const p = players[idx];
    const existing = chart.data.datasets.findIndex(d => d._pid === pid);

    if (existing > -1) {
        chart.data.datasets.splice(existing, 1);
    } else {
        chart.data.datasets.push({
            _pid: pid,
            label: p.name || p.champ,
            data: (kind === 'xp' ? p.xp : p.gold) || [],
            borderColor: CHAMP_LINE_COLORS[idx] || '#888',
            backgroundColor: 'transparent',
            borderWidth: 2, tension: 0.3, pointRadius: 0
        });
    }
    chart.update();

    // 해당 종류의 버튼만 상태를 바꾼다
    const btn = root.querySelector(`.tl-champ-toggle[data-pid="${pid}"][data-kind="${kind}"]`);
    if (btn) btn.classList.toggle('active', existing === -1);
};

// ==========================================
// ★ 챔피언 목록 및 상세 페이지 로직
// ==========================================

// ★ 챔피언 페이지 전용 데이터 지연 로드 (2026-08-11).
//   custom_templates.js + custom_values.js + custom_lore.js 가 gzip 142KB 인데
//   전부 selectChampion() 안에서만 쓰인다. index.html 에서 바로 받으면
//   전적검색만 하러 온 사람도 그만큼 기다리게 되므로 챔피언 탭에서 처음 받는다.
//
//   index.html 이 <script class="lazy-champ-data" data-src="..."> 로 재워 두고
//   (src 로 두면 브라우저가 즉시 받아버린다) 여기서 진짜 script 로 바꿔 붙인다.
//   data-src 값에는 server.js 가 ?v=mtime 을 이미 붙여 놨다 — 그대로 써야
//   custom_values.js 를 고쳤을 때 브라우저가 새로 받는다.
let champDataPromise = null;
function loadChampionData() {
    if (champDataPromise) return champDataPromise;

    const tags = Array.from(document.querySelectorAll('script.lazy-champ-data[data-src]'));
    champDataPromise = Promise.all(tags.map(tag => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        // ★ async = false 를 꼭 줘야 한다. 동적으로 만든 script 는 기본이 async 라
        //   받아지는 대로 실행돼서 순서가 안 정해진다. false 면 셋을 병렬로 받되
        //   문서에 넣은 순서대로 실행한다 (지금은 서로 참조가 없지만 순서는 지켜 둔다).
        s.async = false;
        s.src = tag.dataset.src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('챔피언 데이터를 받지 못했습니다: ' + tag.dataset.src));
        document.head.appendChild(s);
    })));

    // 실패했으면 캐시를 비워서 다음에 탭을 다시 눌렀을 때 재시도되게 한다.
    champDataPromise.catch(() => { champDataPromise = null; });
    return champDataPromise;
}

// ============================================================
//  챔피언 목록 필터 — 검색(초성 지원) + 역할군 (2026-08-12)
// ============================================================

// 역할군은 Data Dragon 의 champion.json `tags` 다. 이미 받는 파일이라 추가 요청이 없다.
//   173명 전부 1~2개를 가진다 (0개도 3개도 없음).
const ROLE_ORDER = ['fighter', 'assassin', 'mage', 'marksman', 'tank', 'support'];
const ROLE_KO = {
    fighter: '전사', assassin: '암살자', mage: '마법사',
    marksman: '원거리 딜러', tank: '탱커', support: '서포터',
};
// 라이엇 공식 역할군 아이콘 (인게임 챔피언 정보창에 쓰는 그 금색 문양).
const ROLE_ICON = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-champion-details/global/default/role-icon-';

// 챔피언 id → 역할군 배열(소문자). showChampions() 가 champion.json 을 받을 때 채운다.
//   스탯 탭의 "역할군 평균" 이 이 표로 모집단을 고른다. 추가 요청은 없다.
const champRoleMap = {};

// 검색 대상 문자열. "한글이름|초성|영문id" 를 공백 없이 이어 붙여 한 번에 비교한다.
//   초성 변환은 위쪽 "챔피언 필터 패널" 의 getChosung() 을 그대로 쓴다 — 표를 두 벌 두면 어긋난다.
//   영문 id 도 넣는 이유: "garen" 처럼 영타로 치는 사람이 있어서다.
function champSearchKey(champ) {
    const name = champ.name.replace(/\s+/g, '');
    return `${name}|${getChosung(name)}|${champ.id.toLowerCase()}`;
}

// 지금 켜져 있는 역할군. 여러 개 켜면 **전부 해당해야 통과**(AND)다.
//   ★ 챔피언은 역할을 최대 2개까지만 가진다. 그래서 3개 이상 켜면 결과는 항상 0명이다.
//     이건 버그가 아니라 데이터가 그런 것이다 (2026-08-12 확인).
const activeChampRoles = new Set();

window.toggleChampRole = function (btn) {
    const r = btn.dataset.role;
    if (activeChampRoles.has(r)) { activeChampRoles.delete(r); btn.classList.remove('on'); }
    else { activeChampRoles.add(r); btn.classList.add('on'); }
    filterChampList();
};

// 검색 상자 안 X 버튼 (2026-08-12).
//   ★ 어떤 필터 함수를 부를지 여기서 알 필요가 없다. 값을 지운 뒤 input 이벤트를
//     다시 쏘면 각 상자가 자기 oninput(filterChampList / filterVsList /
//     filterChampFilterList)을 알아서 돌린다. 상자가 늘어도 이 함수는 그대로다.
//   보임/숨김은 CSS 의 :placeholder-shown 이 처리한다 (style.css 참고).
window.clearSearchBox = function (btn) {
    const input = btn.parentNode.querySelector('input');
    if (!input || input.disabled) return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
};

window.filterChampList = function () {
    const input = document.getElementById('champ-search-input');
    // ★ 영문은 **무조건** 한글 자판으로 읽는다 (폴백 없음). "rkfps" -> "가렌", "d" -> "ㅇ"
    const cands = koCandidates((input ? input.value : '').replace(/\s+/g, ''));
    let shown = 0;

    document.querySelectorAll('.champ-sidebar-item').forEach(el => {
        const key = (el.dataset.search || '').toLowerCase();
        const roles = (el.dataset.roles || '').split(' ');
        const okText = cands.some(c => key.includes(c));
        // AND — 켠 역할군을 **전부** 가진 챔피언만 남는다
        const okRole = [...activeChampRoles].every(r => roles.includes(r));
        const ok = okText && okRole;
        // ★ style.display 를 건드리면 안 된다 (2026-08-12).
        //   항목은 인라인 style 에 `display: flex` 를 갖고 있어서, 되돌리려고 '' 를 넣으면
        //   그 flex 까지 같이 지워진다 → 아이콘과 이름이 세로로 쌓여 상자가 깨진다.
        //   클래스로 끄고 CSS 에서 !important 로 인라인을 이긴다.
        el.classList.toggle('filtered-out', !ok);
        if (ok) shown++;
    });

    const empty = document.getElementById('champ-list-empty');
    if (empty) empty.style.display = shown ? 'none' : 'block';
};

// ============================================================
//  챔피언 페이지 주소 (2026-08-17)
//    `/champions/<id>[/<탭>[/<스킨번호>]]` — 예: `/champions/Shen/skins/49`
//
//    ★★ **탭·스킨·챔피언 바꾸기는 전부 `replaceState` 다. 이력을 쌓지 않는다.**
//      쌓으면 탭 네 개를 훑어본 사람이 목록으로 돌아가려고 **뒤로가기를 네 번** 눌러야 한다.
//      주소는 그대로 바뀌므로 **복사해서 보내면 그 자리가 열리는 건 똑같다.**
//    ★ 이력을 쌓는 건 **메뉴로 들어오는 첫 걸음 하나뿐**이다 (showChampions 의 pushState).
//      그것까지 replace 로 바꾸면 `전적검색 → 챔피언` 하고 뒤로가기를 눌렀을 때
//      **사이트를 통째로 벗어난다.**
//    ★ 기본 탭(스킬)은 주소에 안 붙인다 — `/champions/Shen` 이 예전 그대로 남는다.
//      (옛 링크가 그대로 살아 있어야 한다)
// ============================================================
const CHAMP_TABS = ['skills', 'stats', 'skins', 'lore', 'quotes'];
let champViewId = '';
let champViewTab = 'skills';
let champViewSkin = -1;     // 스킨 탭에서 고른 스킨 번호 (기본 스킨이 0 이라 -1 이 "없음")

function champViewUrl() {
    const base = currentChampMode === 'classic' ? '/champions-classic' : '/champions';
    if (!champViewId) return base;
    let u = `${base}/${champViewId}`;
    if (champViewTab !== 'skills') u += `/${champViewTab}`;
    if (champViewTab === 'skins' && champViewSkin >= 0) u += `/${champViewSkin}`;
    return u;
}

function syncChampUrl() {
    const u = champViewUrl();
    if (window.location.pathname !== u) {
        window.history.replaceState({ page: 'champions', champ: champViewId }, '', u);
    }
}

async function showChampions(requestedChampId = null, classicMode = false) {
    currentChampMode = classicMode ? 'classic' : 'normal';
    if (!window.location.pathname.startsWith('/champions')) {
        window.history.pushState({ page: 'champions' }, '', requestedChampId ? `/champions/${requestedChampId}` : '/champions');
    }

    hideAllContainers();
    const champsContainer = document.getElementById('champions-container');
    champsContainer.style.display = "block";
    // ★ 재방문이면 로딩 문구를 안 쓴다 (2026-08-31, 사용자 지적 — 진입할 때마다 0.1초 깜빡였다).
    //   champion.json 이 메모리 캐시에 있으면 아래 렌더가 사실상 즉시라, 이전 화면을 잠깐 두는 쪽이 안 깜빡인다
    if (!window.__champJson) {
        champsContainer.innerHTML = skelChampHtml();
    }

    try {
        // ★ 버전 동기화를 반드시 기다린다. 안 기다리면 기본값(구버전)으로 받아서
        //   신규 챔피언이 목록에서 사라진다 — 로크가 이 경우였다 (2026-08-10).
        if (ddragonReady) await ddragonReady;

        // ★ 문장·수치·스토리를 여기서 처음 받는다. selectChampion() 이 바로 아래에서
        //   불리므로 반드시 목록 그리기 전에 끝나 있어야 한다.
        //   두 fetch 가 서로 안 기다리게 챔피언 목록과 같이 출발시킨다.
        const champDataLoaded = loadChampionData();

        // ★ champion.json 메모리 캐시 (2026-08-31, 깜빡임 수정의 짝) — 버전이 갈리면 다시 받는다
        let data = (window.__champJsonVer === ddragonVersion) ? window.__champJson : null;
        if (!data) {
            const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion.json`);
            data = await res.json();
            window.__champJson = data;
            window.__champJsonVer = ddragonVersion;
        }

        let champList = [];
        for (let key in data.data) {
            const c = data.data[key];
            // ★ 역할군 표를 여기서 같이 채운다. 스탯 탭의 "역할군 평균" 이 이걸 본다.
            //   목록 필터와 달리 **정규 챔피언만** 담는다 — 어느 탭으로 들어왔든 평균의
            //   모집단이 같아야 값이 안 흔들린다 (클래식은 championStats 에도 없다).
            if (!isClassicChamp(c.id)) champRoleMap[c.id] = (c.tags || []).map(t => t.toLowerCase());
            // 클래식 탭이면 Jade_ 계열만, 정규 탭이면 그 외만
            if (isClassicChamp(c.id) !== classicMode) continue;
            // tags = 역할군 (Fighter / Mage / Assassin / Marksman / Tank / Support).
            //   173명 전부 1~2개다 — 0개도 3개도 없다 (2026-08-12 확인).
            champList.push({ id: c.id, name: c.name, tags: c.tags || [] });
        }

        // 예전에는 Data Dragon 이 신규 챔피언을 늦게 올려서 목록에 손으로 넣어 뒀다.
        // 지금은 champion.json 이 전부 포함하고 있어 그대로 쓴다.
        // 새 챔피언이 안 보이면 Data Dragon 반영을 기다리면 된다.

        champList.sort((a, b) => a.name.localeCompare(b.name, 'ko-KR'));

        // 목록을 다시 그리면 버튼도 새로 만들어진다. 켜져 있던 역할군 표시를 같이 비워야
        // "버튼은 꺼져 보이는데 목록은 걸러져 있는" 상태가 안 생긴다.
        activeChampRoles.clear();

        if (champList.length === 0) {
            champsContainer.innerHTML = `<div style='text-align:center; padding:100px 0; min-height:60vh; color:var(--text-muted);'>표시할 챔피언이 없습니다.</div>`;
            return;
        }

        let html = `
            <!-- ★ 도감 4칸 — 헤더 드롭다운과 같은 줄이다. **머리글보다 위**여야 네 메뉴에서 줄 높이가 같다 (2026-08-27) -->
            ${classicMode ? '' : codexTabsHtml('champions')}
            <!-- ★ 머리글(#champ-page-header)은 2026-08-28 부터 **오른쪽 칸 안**(.champ-detail-col) 에 있다 —
                 그 칸이 상자 자체라 머리글이 상자 안 맨 위 줄(왼쪽 정렬)이고 아래가 탭·내용이다 (사용자 선택 A). 폰도 같은 순서(목록 → 상자) -->
            <!-- ★ 여기 세 덩이는 인라인 style 이었는데 클래스로 뺐다 (2026-08-11).
                 인라인은 스타일시트를 이겨서 @media 로 못 덮는다 — 폰에서 280px 목록이
                 그대로 버텨 상세 영역에 60px 밖에 안 남았다. style.css 15번 절 참고. -->
            <div class="champ-page-wrap">
                <div class="champ-list-col">
                    <div class="champ-filter">
                        <span class="search-wrap">
                            <input id="champ-search-input" class="champ-search" type="text" autocomplete="off"
                                   placeholder="챔피언 검색 (초성 가능)" oninput="filterChampList()">
                            <button type="button" class="search-clear" onclick="clearSearchBox(this)" aria-label="검색어 지우기">&times;</button>
                        </span>
                        <div class="role-btns">
                            ${ROLE_ORDER.map(r => `
                            <button class="role-btn" data-role="${r}" data-label="${ROLE_KO[r]}"
                                    onclick="toggleChampRole(this)" aria-label="${ROLE_KO[r]}">
                                <img src="${ROLE_ICON}${r}.png" alt="${ROLE_KO[r]}">
                            </button>`).join('')}
                        </div>
                    </div>
                <div class="champ-list-pane">
        `;

        html += champList.map(champ => `
            <div onclick="selectChampion('${champ.id}', '${champ.name}')" id="champ-item-${champ.id}" class="champ-sidebar-item"
                 data-search="${champSearchKey(champ)}" data-roles="${champ.tags.map(t => t.toLowerCase()).join(' ')}"
                 style="display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: rgba(255,255,255,0.02); border: 1px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.2s;"
                 onmouseover="if(!this.classList.contains('active')) this.style.background='rgba(255,255,255,0.08)'"
                 onmouseout="if(!this.classList.contains('active')) this.style.background='rgba(255,255,255,0.02)'">
                <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champ.id}.png" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/0.png'" style="width: 40px; height: 40px; border-radius: 6px; object-fit: cover;">
                <div style="font-size: 14px; font-weight: 500; color: #fff;">${champ.name}</div>
            </div>
        `).join('');

        html += `
                    <div id="champ-list-empty" class="champ-list-empty" style="display:none;">조건에 맞는 챔피언이 없습니다.</div>
                </div></div>
                <div class="champ-detail-col">
            <div class="stats-header" id="champ-page-header" style="display: flex; align-items: center; justify-content: flex-start; gap: 15px; padding: 12px 20px; min-height: 72px;">
                <span style="color: var(--text-faint); font-size: 14px;">${classicMode ? '챔피언 정보 (클래식)' : '챔피언 정보'}</span>
            </div>
                <div id="champ-detail-area" class="champ-detail-pane">
                    <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/0.png" style="width: 80px; opacity: 0.3; margin-bottom: 20px;">
                    <div style="color: var(--text-muted); font-size: 18px;">👈 왼쪽에서 챔피언을 선택해주세요.</div>
                </div>
                </div>
            </div>
        `;
        champsContainer.innerHTML = html;

        // 목록을 먼저 그려 두고 여기서 기다린다. 아래 selectChampion() 이
        // customTemplates / customValues / customLore 를 바로 읽기 때문이다.
        // 못 받았으면 아래 catch 가 잡는다 — 조용히 DD 툴팁으로 흘려보내면
        // `[스탯 비례]` 같은 미해결 토큰이 그대로 찍히므로 차라리 실패를 알린다.
        // (loadChampionData 가 실패 시 캐시를 비우므로 탭을 다시 누르면 재시도된다)
        await champDataLoaded;

        if (requestedChampId) {
            const target = champList.find(c => c.id.toLowerCase() === requestedChampId.toLowerCase());
            if (target) selectChampion(target.id, target.name);
            else selectChampion(champList[0].id, champList[0].name);
        } else {
            selectChampion(champList[0].id, champList[0].name);
        }

    } catch (e) { champsContainer.innerHTML = `<div style='text-align:center; padding:50px; color:#f87171;'>데이터를 불러오지 못했습니다.</div>`; }
}

window.selectChampion = async function (champId, champName) {
    // ★ 챔피언을 바꿔도 **이력을 쌓지 않는다** (2026-08-17). 예전엔 목록에서 고를 때마다
    //   한 칸씩 쌓여서, 몇 명 훑어보고 나면 뒤로가기를 그만큼 눌러야 페이지를 벗어났다.
    //   주소는 그대로 바뀌므로 복사해서 보내는 건 똑같이 된다.
    //   ★ 탭·스킨은 새 챔피언에서 처음부터다 — 단, 주소로 들어온 요청(pendingChampView)이
    //     있으면 그건 아래 applyPendingChampView 가 다시 세운다.
    champViewId = champId;
    champViewTab = 'skills';
    champViewSkin = -1;
    syncChampUrl();
    ++skinPreloadToken;   // 이전 챔피언 스킨 예열을 중단한다 (2026-08-19)

    document.querySelectorAll('.champ-sidebar-item').forEach(el => {
        el.classList.remove('active');
        el.style.borderColor = 'transparent'; el.style.background = 'rgba(255,255,255,0.02)';
    });
    const targetEl = document.getElementById(`champ-item-${champId}`);
    if (targetEl) {
        targetEl.classList.add('active');
        targetEl.style.borderColor = 'var(--accent)'; targetEl.style.background = 'rgba(167, 139, 250, 0.1)';
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const detailArea = document.getElementById('champ-detail-area');
    // ★ 클래스로 뺐다 (2026-08-19). 폰에서는 상세 칸 높이가 auto 라 이 문구 한 줄 높이로
    //   쪼그라들었다가 로딩이 끝나면 확 늘어났다 — style.css 의 .champ-loading 이
    //   폰에서만 최소 높이를 잡아 상자 크기를 PC 처럼 유지한다.
    detailArea.innerHTML = `<div class="champ-loading">${champName} 상세 정보를 불러오는 중...</div>`;

    try {
        const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion/${champId}.json`);
        const data = await res.json();
        const champ = data.data[champId];

        const header = document.getElementById('champ-page-header');
        if (header) {
            header.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: flex-start; gap: 15px;">
                    <img class="champ-header-portrait" src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champId}.png"
                         onclick="playChampVoice('${champ.key}', 'pick')" title="${escapeHtml(champ.name)} 대표 대사 듣기"
                         style="width: 48px; height: 48px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                    <div style="text-align: left; display: flex; align-items: center; gap: 15px;">
                        <div>
                            <div style="color: var(--accent); font-weight: 700; font-size: 13px; margin-bottom: 2px;">${champ.title}</div>
                            <h2 style="color: #fff; font-size: 26px; margin: 0; line-height: 1;">${champ.name}</h2>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 2px;">
                            <!-- ★ PICK/BAN → 픽 대사/밴 대사 + 아웃라인(보조 버튼) 꼴 (2026-08-31, 260830 디자인 6번 — 뜻이 안 보인다는 지적) -->
                            <button onclick="playChampVoice('${champ.key}', 'pick')" style="background: transparent; border: 1px solid rgba(167, 139, 250, 0.5); color: var(--text-bright); border-radius: 8px; padding: 2px 10px; font-size: 12px; font-weight: 600; cursor: pointer; transition: 0.2s; outline: none; white-space: nowrap;" onmouseover="this.style.background='rgba(107, 70, 193, 0.3)'" onmouseout="this.style.background='transparent'">픽 대사</button>
                            <button onclick="playChampVoice('${champ.key}', 'ban')" style="background: transparent; border: 1px solid rgba(167, 139, 250, 0.5); color: var(--text-bright); border-radius: 8px; padding: 2px 10px; font-size: 12px; font-weight: 600; cursor: pointer; transition: 0.2s; outline: none; white-space: nowrap;" onmouseover="this.style.background='rgba(107, 70, 193, 0.3)'" onmouseout="this.style.background='transparent'">밴 대사</button>
                        </div>
                    </div>
                </div>
            `;
        }

        const parseRiotTooltip = (spell) => {
            if (!spell.tooltip) return spell.description;
            let text = spell.tooltip;
            text = text.replace(/{{\s*spellmodifierdescriptionappend\s*}}/gi, '');
            text = text.replace(/{{\s*e([0-9]+)\s*}}/gi, (match, p1) => {
                const idx = parseInt(p1);
                return spell.effectBurn[idx] ? `[ ${spell.effectBurn[idx]} ]` : match;
            });
            if (spell.vars && spell.vars.length > 0) {
                text = text.replace(/{{\s*([a-z0-9]+)\s*}}/gi, (match, p1) => {
                    const varData = spell.vars.find(v => v.key === p1.toLowerCase());
                    if (varData) {
                        const coeff = Array.isArray(varData.coeff) ? varData.coeff.join('/') : varData.coeff;
                        let statName = varData.link === 'spelldamage' ? '주문력' :
                            varData.link === 'attackdamage' ? '공격력' :
                                varData.link === 'bonusattackdamage' ? '추가 공격력' :
                                    varData.link === 'bonushealth' ? '추가 체력' :
                                        varData.link === 'armor' ? '방어력' : varData.link;
                        return `(+ ${coeff} ${statName})`;
                    }
                    return match;
                });
            }
            text = text.replace(/{{\s*[^}]+\s*}}/g, '<span style="color:var(--accent); font-weight: 700;">[스탯 비례]</span>');
            text = text.replace(/@[^@]+@/g, '<span style="color:var(--accent); font-weight: 700;">[스탯 비례]</span>');
            return cleanTooltipText(text);
        };

        window.currentChampPaddedKey = String(champ.key).padStart(4, '0');


        const renderScalingTable = (spellKey, riotDesc) => {
            const tpl = (typeof customTemplates !== 'undefined' && customTemplates[champ.id])
                ? customTemplates[champ.id][spellKey] : null;
            const values = (typeof customValues !== 'undefined' && customValues[champ.id] && customValues[champ.id][spellKey])
                ? customValues[champ.id][spellKey] : {};

            // 아직 수치를 안 채웠거나 일부만 해석된 스킬은 문장에 물음표가 찍힌다.
            // 값에 ? 가 섞여 있으면 (예: "50 / 75 (+ (?))") 템플릿을 쓰지 않는다.
            // 템플릿을 쓰지 않고 라이엇 기본 설명으로 넘긴다
            //
            // ★ 문장에 실제로 등장하는 {pN} 만 검사한다.
            //   가드의 목적은 "화면에 물음표가 찍히는 걸 막는 것" 이라
            //   문장이 안 쓰는 자리는 볼 이유가 없다.
            //   "현재 내 챔피언의 상태" 처럼 고정값이 없어서 문장에서 뺀 자리는
            //   custom_values.js 에 ? 로 남아 있는데(fill_values.js 가 CD 원본 desc 의
            //   @Name@ 을 훑어 만들기 때문에 손으로 지워도 재실행하면 되살아난다),
            //   예전 가드는 그것까지 세어서 멀쩡한 문장을 통째로 버렸다.
            // ★ 템플릿이 배열이면 "하위 스킬을 파트로 쪼갠 것" 이다. 가드는 합쳐서 검사한다.
            const tplFlat = Array.isArray(tpl) ? tpl.join(' ') : tpl;
            const unfilled = Object.keys(values).some(
                k => /^p[0-9]+$/.test(k)
                  && tplFlat && tplFlat.includes(`{${k}}`)
                  && (values[k] === '' || String(values[k]).includes('?'))
            );

            // ★ 챔피언 레벨에 따라 변하는 수치의 각주(그래프 / 계단 목록).
            //   custom_graphs.js 에 따로 있다 — 값(custom_values.js)도 문장(custom_templates.js)도
            //   스크립트가 매번 새로 찍기 때문에 거기 써 넣으면 재생성 때 날아간다.
            //   값 **바로 뒤**에 이어 붙여서 색칠된 수치의 마지막 글자에 각주가 달리게 한다.
            const graphs = (typeof customGraphs !== 'undefined' && customGraphs[champ.id]
                && customGraphs[champ.id][spellKey]) || {};

            // ★ 각주가 **배열**이면 값 안의 `(레벨에 따라)` 자리마다 하나씩 끼워 넣는다
            //   (2026-08-14). 한 값에 레벨 비례가 두 군데인 자리가 6개 있다 —
            //   카타리나 P 는 기본 피해량과 **주문력 계수**가 각각 레벨에 따라 변한다.
            //   문자열이면 예전처럼 값 **뒤에** 붙인다 (색칠된 수치의 마지막 글자에 달린다).
            const withNotes = (val, note) => {
                if (!note) return val;
                if (!Array.isArray(note)) return val + note;
                let i = 0;
                return String(val).replace(/\(레벨에 따라\)/g,
                    (hit) => hit + (note[i++] || ''));
            };

            if (tpl && !unfilled) {
                const fill = (t) => {
                    let x = t;
                    for (let key in values) {
                        x = x.split(`{${key}}`).join(withNotes(values[key], graphs[key]));
                    }
                    return x;
                };
                const bodyStyle = 'color: var(--text-bright); line-height: 1.6; font-size: 14px;';

                // ★ 구분선 아래 작은 회색 글씨 (2026-08-12).
                //   인게임 툴팁에서 본문 아래에 한 칸 띄고 깔리는 부연 설명이다
                //   ("이 스킬은 피해를 입힐 때 효과가 발동합니다." 등).
                //   CD 의 dynamicDescription 에는 아예 없고, 라이엇이 따로 관리하는
                //   stringtable 키(keyTooltipExtendedBelowLine)에서 온다.
                //   build_champion_data.js 가 "<슬롯>_rules" 로 찍어 둔다 — belowline.js 참고.
                //
                //   ★ 가드는 **회색 글씨만** 버린다. 본문 가드처럼 통째로 폴백시키면
                //     부연 설명 하나 때문에 멀쩡한 스킬 문장이 DD 툴팁으로 떨어진다.
                //     값을 못 구한 자리가 9군데 있다 (드레이븐 R·파이크 R 등 f 계열).
                const rulesTpl = (typeof customTemplates !== 'undefined' && customTemplates[champ.id])
                    ? customTemplates[champ.id][spellKey + '_rules'] : null;
                const rulesBad = rulesTpl && Object.keys(values).some(
                    k => /^p[0-9]+$/.test(k)
                        && rulesTpl.includes(`{${k}}`)
                        && (values[k] === '' || String(values[k]).includes('?'))
                );
                //   글자 크기는 본문 14px 보다 한 단계 작게 (인게임도 작다).
                //   색은 <rules> 태그가 낸다 — app.js <style> 의 #5a5955, 인게임 실측값이다.
                const rulesHtml = (rulesTpl && !rulesBad)
                    ? `<div style="border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 14px 0;"></div>`
                    + `<div class="skill-rules" style="line-height: 1.55; font-size: 13px;">${fill(rulesTpl)}</div>`
                    : '';

                // ★ 배열 템플릿 = 하위 스킬(재시전·2타·3타·진화)을 아이콘과 함께 구분선으로 나눈다.
                //   0번은 스킬 본체라 기본 아이콘, 1번부터는 values.icons[i-1] 을 쓴다.
                //   (icons 는 findExtraIcons 가 bin 에서 뽑아 둔 추가 아이콘 배열이다)
                if (Array.isArray(tpl)) {
                    const extra = Array.isArray(values.icons) ? values.icons : [];
                    const slotIdx = ['Q', 'W', 'E', 'R'].indexOf(spellKey);
                    let baseImg = null;
                    if (spellKey === 'P' && champ.passive && champ.passive.image) {
                        baseImg = `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/passive/${champ.passive.image.full}`;
                    } else if (slotIdx >= 0 && champ.spells[slotIdx]) {
                        // 위 img 와 같은 이유로 values.img 가 있으면 그걸 우선한다 (벨베스 Q)
                        baseImg = values.img
                            || `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/spell/${champ.spells[slotIdx].image.full}`;
                    }
                    return tpl.map((part, i) => {
                        // ★ values.imgBody 는 **0번 파트 전용** 아이콘이다 (2026-08-12).
                        //   스킬 칸(버튼·이름)은 values.img 를 쓰는데, 그 둘을 다르게 하고 싶을 때만 쓴다.
                        //   유나라 Q 가 유일한 사례 — 버튼은 컬러(활성), "기본 지속 효과" 옆은 흑백(비활성).
                        const icon = i === 0 ? (values.imgBody || baseImg) : extra[i - 1];
                        // ★ 아이콘을 **첫 글줄 한가운데**에 맞춘다 (2026-08-10).
                        //   컨테이너가 align-items:flex-start 라 아이콘 위와 텍스트 블록 위가
                        //   맞춰지는데, 실제 화면에서는 **아이콘이 글자보다 위로 떠 보인다.**
                        //   글줄 상자(14px x 1.6 = 22.4px) 안에서 글자가 가운데에 놓이느라
                        //   위쪽에 여백이 생기기 때문이다. 그만큼 아이콘을 **내려야** 맞는다.
                        //   ★ 처음엔 부호를 반대로 잡아 아이콘을 올렸더니 격차가 더 벌어졌다.
                        //     방향이 헷갈리면 화면을 보고 판단할 것 — 부호만 바꾸면 된다.
                        //   글자 크기를 바꾸면 이 값도 같이 바뀌므로 calc 로 적어 둔다.
                        const iconPull = 'margin-top: calc((34px - 1.6 * 14px) / 2);';
                        const imgTag = icon
                            ? `<img src="${icon}" style="width: 34px; height: 34px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.1); flex-shrink: 0; ${iconPull}" onerror="this.style.visibility='hidden'">`
                            : `<div style="width: 34px; flex-shrink: 0;"></div>`;
                        return `<div style="display: flex; gap: 12px; align-items: flex-start;">${imgTag}<div style="flex: 1; ${bodyStyle}">${fill(part)}</div></div>`;
                    }).join('<div style="border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 14px 0;"></div>')
                        + rulesHtml;
                }

                return `<div style="margin-bottom: 10px; ${bodyStyle}">${fill(tpl)}</div>` + rulesHtml;
            }

            return `<div style="margin-bottom: 10px; color: var(--text-bright); line-height: 1.6; font-size: 14px;">${riotDesc}</div>`;
        };

        // ★ 패시브 스킬 세팅
        const passive = {
            id: 'P1', keyChar: '패시브', name: champ.passive.name,
            desc: renderScalingTable('P', cleanTooltipText(champ.passive.description)),
            // ★ 문장을 파트로 쪼갠 스킬(배열 템플릿)은 구분선 아래에 아이콘이 붙는다.
            //   아직 안 쪼갠 스킬만 이름 옆에 아이콘을 보여 준다 — 안 그러면 화면에서 아예 사라진다.
            partTpl: Array.isArray((typeof customTemplates !== 'undefined' && customTemplates[champ.id]) ? customTemplates[champ.id]['P'] : null),
            cooldown: (typeof customValues !== 'undefined' && customValues[champ.id] && customValues[champ.id]['P'] && customValues[champ.id]['P'].cooldown) || '-',
            // ★ 패시브 쿨타임이 레벨에 따라 **계단식**으로 줄어드는 자리가 있다 (2026-08-14).
            //   그라가스는 1/6/11/16레벨에 12/10/8/6 인데 값은 `12 ~ 6` 한 줄이라
            //   매 레벨 줄어드는 것처럼 읽힌다. custom_graphs.js 의 각주를 옆에 붙인다.
            cooldownNote: (typeof customGraphs !== 'undefined' && customGraphs[champ.id]
                && customGraphs[champ.id]['P'] && customGraphs[champ.id]['P'].cooldown) || '',
            cost: (typeof customValues !== 'undefined' && customValues[champ.id] && customValues[champ.id]['P'] && customValues[champ.id]['P'].cost) || '-',
            img: `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/passive/${champ.passive.image.full}`,
            img2: (typeof customValues !== 'undefined' && customValues[champ.id] && customValues[champ.id]['P'] && customValues[champ.id]['P'].img2) || null,
            stats: (typeof customValues !== 'undefined' && customValues[champ.id] && customValues[champ.id]['P'] && customValues[champ.id]['P'].stats) || null, // ★ 스탯 추가
            values: (typeof customValues !== 'undefined' && customValues[champ.id] && customValues[champ.id]['P']) || null, // ★ 피해량/계수 (v1, v2)
            isPassive: true
        };

        const spellSlotsId = ['Q1', 'W1', 'E1', 'R1'];
        const spellSlotsKey = ['Q', 'W', 'E', 'R'];

        // ★ 일반 스킬 세팅
        const spells = champ.spells.map((s, i) => {
            let customCd = s.cooldownBurn;
            let customCost = s.costBurn;
            let customImg2 = null;
            let customStats = null; // ★ 스탯 변수 추가

            let customVals = null;
            if (typeof customValues !== 'undefined' && customValues[champ.id] && customValues[champ.id][spellSlotsKey[i]]) {
                if (customValues[champ.id][spellSlotsKey[i]].cooldown) customCd = customValues[champ.id][spellSlotsKey[i]].cooldown;
                if (customValues[champ.id][spellSlotsKey[i]].cost) customCost = customValues[champ.id][spellSlotsKey[i]].cost;
                if (customValues[champ.id][spellSlotsKey[i]].img2) customImg2 = customValues[champ.id][spellSlotsKey[i]].img2;
                if (customValues[champ.id][spellSlotsKey[i]].stats) customStats = customValues[champ.id][spellSlotsKey[i]].stats; // ★ 스탯 가져오기
                customVals = customValues[champ.id][spellSlotsKey[i]];
            }
            return {
                id: spellSlotsId[i],
                keyChar: spellSlotsKey[i],
                name: s.name,
                desc: renderScalingTable(spellSlotsKey[i], parseRiotTooltip(s)),
                // ★ 문장을 파트로 쪼갠 스킬(배열 템플릿)은 구분선 아래에 아이콘이 붙는다.
                //   아직 안 쪼갠 스킬만 이름 옆에 아이콘을 보여 준다 — 안 그러면 화면에서 아예 사라진다.
                partTpl: Array.isArray((typeof customTemplates !== 'undefined' && customTemplates[champ.id]) ? customTemplates[champ.id][spellSlotsKey[i]] : null),
                cooldown: customCd,
                // 패시브 쪽 주석 참고. QWER 쿨타임은 랭크별이라 지금은 대상이 없지만 틀을 맞춰 둔다.
                cooldownNote: (typeof customGraphs !== 'undefined' && customGraphs[champ.id]
                    && customGraphs[champ.id][spellSlotsKey[i]]
                    && customGraphs[champ.id][spellSlotsKey[i]].cooldown) || '',
                cost: customCost,
                // ★ customValues 에 img 가 있으면 DD 기본 아이콘 대신 그걸 쓴다.
                //   DD 아이콘이 인게임과 다른 경우가 있다 — 벨베스 Q 가 유일한 사례로,
                //   DD 것은 사분면이 한 칸만 켜진 그림이고 인게임은 꽉 찬 그림이다.
                img: (customVals && customVals.img)
                    || `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/spell/${s.image.full}`,
                img2: customImg2,
                stats: customStats, // ★ 데이터에 스탯 저장
                values: customVals, // ★ 피해량/계수 (v1, v2)
                isPassive: false
            };
        }).filter(sp => {
            // ★ 템플릿이 null 이면 "이 챔피언에겐 이 키가 아예 없다" 는 뜻이라
            //   스킬 목록에서 통째로 뺀다. (아펠리오스 E — 무기 교체가 탄약 소진으로
            //   자동 진행돼서 E 키를 안 쓴다. Data Dragon 에는 더미가 들어 있다)
            //   "" 는 "아직 문장을 안 썼다"(= DD 폴백) 라서 뜻이 다르다. 여기서 걸러지면 안 된다.
            const t = (typeof customTemplates !== 'undefined' && customTemplates[champ.id])
                ? customTemplates[champ.id][sp.keyChar] : undefined;
            return t !== null;
        });
        // ★ 두 번째 폼(니달리 쿠거, 엘리스 거미, 제이스 대포, 나르 메가)은
        //   별도 스킬 칸으로 만들지 않고 같은 칸에 합친다.
        //   Data Dragon 의 스킬 이름이 이미 두 폼을 같이 적어 두기 때문이다 —
        //   제이스 Q 이름이 "하늘로! / 전격 폭발" 인데 앞이 해머폼, 뒤가 캐논폼이다.
        //   따로 칸을 만들면 같은 이름이 두 번 나와서 어느 쪽이 어느 폼인지 알 수 없다.
        //   보조 아이콘(img2)은 원래 있던 장치를 그대로 쓴다.
        const cv2 = (typeof customValues !== 'undefined' && customValues[champ.id]) || null;
        if (cv2) {
            spells.forEach((sp) => {
                const v = cv2[sp.keyChar + '2'];
                const tpl2 = (typeof customTemplates !== 'undefined' && customTemplates[champ.id])
                    ? customTemplates[champ.id][sp.keyChar + '2'] : null;
                if (!v || !tpl2) return;

                // ★ Data Dragon 은 두 폼 이름을 "폼1 / 폼2" 로 합쳐서 준다
                //   (제이스 Q "하늘로! / 전격 폭발", 니달리 Q "창 투척 / 숨통 끊기").
                //   박스를 나눴으니 각 박스엔 자기 이름만 보여준다.
                //   ★ 폼2 이름이 어느 쪽 조각인지 소스마다 다를 수 있어서
                //     "폼2 이름이 아닌 쪽"을 폼1로 잡는다.
                //     렉사이 굴 파기 스킬처럼 폼2 이름이 비어 있으면 뒷조각을 쓴다.
                const parts = String(sp.name).split('/').map(x => x.trim()).filter(Boolean);
                let name2 = v.name || '';
                if (parts.length === 2) {
                    if (!name2) name2 = parts[1];
                    sp.name = (parts[0] === name2) ? parts[1] : parts[0];
                }

                // 두 번째 폼은 아래에 박스를 따로 쌓는다. 한 박스에 이어 붙이면
                // 쿨타임·소모값이 폼마다 달라서 헤더가 지저분해진다.
                sp.form2 = {
                    label: v.form || '두 번째 형태',
                    name: name2,
                    icon: v.icon || '',
                    cooldown: v.cooldown || '-',
                    cost: v.cost || '-',
                    desc: renderScalingTable(sp.keyChar + '2', ''),
                    values: v
                };
            });
        }
        window.currentChampSkills = [passive, ...spells];

        // ★ 배경 전문은 `champion_lore.json`(960KB)에 있고 **배경 탭을 열 때 처음 받는다**.
        //   그 전까지는 DD 의 짧은 소개(212자)를 깔아 둔다 — DD 의 `lore` 는 이름과 달리
        //   전문이 아니라 `blurb` 와 같은 글이다.
        window.currentChampLoreId = champId;
        window.currentChampShortLore = champ.lore;
        const loreHtml = `<div id="champ-lore-body" class="champ-lore-text"></div>`;

        // 대사 탭 — 대표 대사(championQuotes) + 픽/밴 음성. 내용은 renderChampQuotes 가 채운다.
        window.currentChampVoiceKey = champ.key;
        window.currentChampName = champ.name;
        const quotesHtml = `<div id="champ-quotes-body" class="champ-quotes"></div>`;

        // ★ 스탯 탭 (2026-08-12). 내용은 renderChampStats 가 채운다.
        window.currentChampStatsId = champ.id;
        const statsHtml = `<div class="champ-stats-wrap"><div id="champ-stats-body"></div></div>`;

        // ★ HTML 틀 구성 (보조 아이콘 컨테이너 추가, 소모값 색상 #d9d5e3 통일, 하단 커스텀 영역 확보)
        const skillsHtml = `
        <style>
${TOOLTIP_STYLE_CSS}        </style>
        <div class="champ-skill-layout">
            <div class="champ-skill-btns">
                ${window.currentChampSkills.map((skill, idx) => `
                    <!-- ★ 인라인 style 을 클래스로 뺐다 (2026-08-11). 폰에서 버튼 하나가
                         96px 라 5개면 512px 였고, 스킬 칸이 300px 대라 두 줄로 접혔다.
                         인라인이라 @media 로 줄일 수가 없었다. 값은 그대로고
                         모바일 규칙만 style.css 15번 절 @media 에 있다.
                         background·borderColor 는 playSkill 이 인라인으로 덮어쓴다. -->
                    <div onclick="playSkill(${idx})" id="skill-btn-${idx}" class="skill-btn">
                        <img src="${skill.img}" class="skill-btn-img" id="skill-img-${idx}">
                        <!-- ★ 라벨은 배열 인덱스가 아니라 skill.keyChar 로 붙인다.
                             인덱스로 매기면 슬롯이 하나라도 빠졌을 때 뒤가 통째로 밀린다
                             (아펠리오스는 E 가 없어서 R 버튼에 E 가 찍혔었다).
                             패시브만 keyChar 가 '패시브' 라 예외로 P 를 쓴다. -->
                        <div class="skill-btn-key">${skill.isPassive ? 'P' : skill.keyChar}</div>
                    </div>
                `).join('')}
            </div>
            <div class="champ-skill-body">
                <div class="champ-skill-box">
                    <div class="champ-skill-head">
                        
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="display: flex; gap: 5px;">
                                <img id="champ-skill-icon-header" src="" style="width: 48px; height: 48px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);">
                                <img id="champ-skill-icon-header-2" src="" style="width: 48px; height: 48px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); display: none;">
                                <!-- 재시전·취소·진화·1·2·3타 등 같은 스킬의 추가 아이콘. 개수가 가변이라 비워 둔다. -->
                                <span id="champ-skill-icon-extra" style="display: flex; gap: 5px;"></span>
                            </div>
                            <!-- ★ 라벨과 이름은 세로로 쌓아야 한다. 바깥은 flex 행이라
                                 감싸지 않으면 라벨이 이름 **옆**에 붙는다. -->
                            <div>
                                <!-- ★ 폼이 두 개인 챔피언의 **첫 번째 폼** 이름 (미니 나르·인간 형태…).
                                     아래 두 번째 폼 박스엔 원래부터 있던 라벨인데 본체 쪽엔 없어서
                                     어느 폼 설명인지 알 수 없었다. 같은 모양으로 맞춘다 (2026-08-10). -->
                                <div id="champ-skill-form" style="color: var(--accent); font-size: 12px; font-weight: 700; margin-bottom: 2px; display: none;"></div>
                                <h3 id="champ-skill-name-header" style="color: #fff; font-size: 18px; font-weight: 700; margin: 0;"></h3>
                            </div>
                        </div>
                        <div class="champ-skill-meta">
                            <div id="champ-skill-cooldown-header" style="color:var(--text-bright);"></div>
                            <div id="champ-skill-cost-header" style="color: var(--text-bright);"></div>
                            <div id="champ-skill-stats-header" style="color: var(--text-muted); font-weight: normal; font-size: 12px; margin-top: 4px;"></div>
                        </div>
                        
                    </div>
                    <hr style="border:0; border-top: 1px solid #554433; margin: 20px 0;">
                    <div id="champ-skill-desc-text-body" style="word-break: keep-all; margin-bottom: 25px;"></div>
                    
                    <hr id="champ-skill-bottom-hr" style="border:0; border-top: 1px solid #554433; margin: 20px 0; display: none;">
                    <div id="champ-skill-custom-bottom"></div>

                </div>

                <!-- ★ 두 번째 폼 박스 (니달리 쿠거·엘리스 거미·제이스 대포·나르 메가).
                     첫 박스와 같은 모양으로 바로 아래에 쌓인다. 해당 없으면 통째로 숨긴다. -->
                <div id="champ-skill2-box" class="champ-skill-box" style="display: none;">
                    <div class="champ-skill-head">
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <img id="champ-skill2-icon" src="" style="width: 48px; height: 48px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);">
                            <div>
                                <div id="champ-skill2-form" style="color: var(--accent); font-size: 12px; font-weight: 700; margin-bottom: 2px;"></div>
                                <h3 id="champ-skill2-name" style="color: #fff; font-size: 18px; font-weight: 700; margin: 0;"></h3>
                            </div>
                        </div>
                        <div class="champ-skill-meta">
                            <div id="champ-skill2-cooldown" style="color:var(--text-bright);"></div>
                            <div id="champ-skill2-cost" style="color:var(--text-bright);"></div>
                        </div>
                    </div>
                    <hr style="border:0; border-top: 1px solid #554433; margin: 20px 0;">
                    <div id="champ-skill2-desc" style="word-break: keep-all;"></div>
                </div>

                <!-- ★ 순서: [첫 폼 설명] [두 번째 폼 설명] [첫 폼 영상] [두 번째 폼 영상].
                     설명 둘을 먼저 붙이고 영상 둘을 그 아래에 **같은 순서로** 쌓는다
                     (미니 나르 - 메가 나르 - 미니 영상 - 메가 영상).
                     예전엔 두 번째 폼 영상이 설명 박스 **안에** 있어서 한 덩어리로 보였고,
                     첫 폼 영상은 맨 아래라 영상 순서가 거꾸로였다.
                     ★ 영상이 없는 스킬이 있다 (이즈리얼 패시브 등 — 라이엇이 안 만들었다).
                     기본을 display:none 으로 두고 **불러오기에 성공했을 때만** 보여 준다.
                     안 그러면 검은 화면만 덩그러니 남는다. -->
                <video id="champ-skill-video" autoplay loop muted playsinline style="width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); object-fit: cover; flex-shrink: 0; display: none;"></video>
                <video id="champ-skill2-video" autoplay loop muted playsinline style="width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); object-fit: cover; flex-shrink: 0; display: none;"></video>
            </div>
        </div>
        `;

        // ★ 스킨 목록은 CD 를 먼저 본다. 실패하면 DD 스플래시 한 장으로 물러나는데,
        //   레이아웃은 같은 걸 쓴다 (썸네일과 큰 그림이 같은 파일이 될 뿐이다)
        const cdSkins = await fetchCdSkins(champ.key);
        const skinList = cdSkins || champ.skins.map(s => {
            const url = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champId}_${s.num}.jpg`;
            // num 은 폴백 목록에도 담는다 — 주소(`/skins/49`)가 이 값으로 스킨을 찾는다
            return { num: Number(s.num), name: s.name === 'default' ? '기본 스킨' : s.name, thumb: url, full: url, desc: '' };
        });
        window.currentSkinList = skinList;

        const skinsHtml = `
            <div class="skin-layout">
                <div class="skin-list">
                    ${skinList.map((skin, index) => `
                        <div class="skin-item${index === 0 ? ' active' : ''}" data-i="${index}" onclick="selectSkin(${index})">
                            <img class="skin-item-img" src="${skin.thumb}" alt="" loading="lazy">
                            <div class="skin-item-name">${skin.gem ? `<img class="skin-gem" src="${skin.gem}" alt="">` : ''}${escapeHtml(skin.name)}</div>
                        </div>
                    `).join('')}
                </div>
                <div class="skin-view">
                    <!-- 그림과 크로마 점을 한 줄에 둔다. 점이 세로줄로 오른쪽에 붙으므로
                         그림은 자연히 왼쪽으로 치우친다. 세로 예산도 그만큼 아낀다. -->
                    <div class="skin-stage">
                        <div class="skin-view-frame">
                            <!-- 크로마를 고른 동안만 채워진다. 크로마 렌더가 투명 배경 세로
                                 인물이라 칸의 절반이 비는데, 그 뒤에 원래 일러스트를 흐리게
                                 깔아 메운다. 이미 받아 둔 그림이라 추가 요청이 없다. -->
                            <div id="skin-view-bg" class="skin-view-bg"></div>
                            <img id="skin-view-img" class="skin-view-img" src="" alt="">
                        </div>
                        <div id="skin-chroma-col" class="skin-chroma-col is-empty"></div>
                    </div>
                    <div id="skin-view-name" class="skin-view-name"></div>
                    <div id="skin-view-desc" class="skin-view-desc"></div>
                </div>
            </div>
        `;

        detailArea.innerHTML = `
            <div class="champ-detail-inner">
                <div class="champ-tab-bar">
                    <button class="champ-tab-btn active" data-tab="skills" onclick="switchChampTab(event, 'skills')" style="padding: 15px 20px; background: transparent; border: none; color: #fff; font-weight: 700; font-size: 16px; cursor: pointer; border-bottom: 3px solid var(--accent);">스킬</button>
                    <button class="champ-tab-btn" data-tab="stats" onclick="switchChampTab(event, 'stats')" style="padding: 15px 20px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; border-bottom: 3px solid transparent;">스탯</button>
                    <button class="champ-tab-btn" data-tab="skins" onclick="switchChampTab(event, 'skins')" style="padding: 15px 20px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; border-bottom: 3px solid transparent;">스킨</button>
                    <button class="champ-tab-btn" data-tab="lore" onclick="switchChampTab(event, 'lore')" style="padding: 15px 20px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; border-bottom: 3px solid transparent;">배경</button>
                    <!-- ▼▼ 비공개 처리 (대사 탭) ▼▼
                         되살릴 때: 이 주석 한 줄만 풀면 된다. 탭 내용(quotesHtml)·renderChampQuotes·
                         champion_quotes.js 는 그대로라 바로 살아난다.
                         가린 이유: 라이엇이 공개하는 음성이 픽·밴 둘뿐이라 채울 게 대표 대사
                         한 줄밖에 없다. 자세한 건 CLAUDE.md "인게임 대사" 절 참고.
                    <button class="champ-tab-btn" data-tab="quotes" onclick="switchChampTab(event, 'quotes')" style="padding: 15px 20px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; border-bottom: 3px solid transparent;">대사</button>
                         ▲▲ 비공개 처리 끝 ▲▲ -->
                </div>
                <div class="champ-tab-scroll">
                    <div id="champ-tab-skills" class="champ-tab-content" style="display: block; height: 100%;">${skillsHtml}</div>
                    <div id="champ-tab-stats" class="champ-tab-content" style="display: none;">${statsHtml}</div>
                    <div id="champ-tab-skins" class="champ-tab-content" style="display: none; height: 100%;">${skinsHtml}</div>
                    <div id="champ-tab-lore" class="champ-tab-content" style="display: none;">${loreHtml}</div>
                    <div id="champ-tab-quotes" class="champ-tab-content" style="display: none;">${quotesHtml}</div>
                </div>
            </div>
        `;

        playSkill(0);
        selectSkin(0);
        renderChampStats(champ.id);
        // 주소로 들어왔거나 신화상점에서 넘어왔으면 그 탭·스킨을 열어 준다
        applyPendingChampView();
    } catch (error) { detailArea.innerHTML = `<div style="color:#f87171;">데이터를 불러오지 못했습니다.</div>`; }
};

// ============================================================
//  스탯 탭 (2026-08-12)
//
//  데이터는 `public/champion_stats.js` (build_stats_page.js 생성).
//  [기본값, 레벨당증가, 방식] 만 들어 있고 레벨별 값은 여기서 계산한다.
//    '+' 덧셈형: base + per x g(N)
//    'x' 곱셈형: base x (1 + per x g(N))   ← 공격 속도만
//  g(N) 은 라이엇 성장 곡선이라 **직선이 아니다** (레벨곡선_정리.md 참고).
//
//  화면은 표가 본체다 (스탯 / 1레벨 / 18레벨). 스탯 이름을 누르면 그 줄 아래로
//  1~18레벨 꺾은선이 펼쳐진다 — 중간 레벨 값은 그래프에 커서를 올리면 나온다.
// ============================================================

// 스탯별 색. 스킬 설명 팔레트(app.js <style>)와 같은 값을 써서 사이트 안에서 일관되게 보이게 한다.
//   ★ 그래프는 스탯 하나당 선 하나(단일 시리즈)라 색이 "구분" 이 아니라 "이름표" 역할이다.
//     그래서 여러 색을 나란히 놓을 때 필요한 색맹 대비 검증 대상이 아니다.
const STAT_COLOR = {
    '체력': '#60e08f', '체력 재생(초당)': '#1f995c',
    '공격력': '#f26522', '공격 속도': '#ffe384',
    '방어력': '#f0ba57', '마법 저항력': '#4fdfff',
    '이동 속도': '#fffdc9', '사거리': '#cdfafa',
};
// 자원은 챔피언마다 이름이 다르다. 색은 인게임 자원바 느낌으로 묶는다.
const RESOURCE_COLOR = [
    [/마나|기류/, '#189ce7'],
    [/기력/, '#f1c40f'],
    [/분노|피의 샘|핏빛 격노/, '#e74c3c'],
    [/열기/, '#e67e22'],
    [/흉포|용기|투지|보호막/, 'var(--accent)'],
];
const statColorOf = (name) => {
    if (STAT_COLOR[name]) return STAT_COLOR[name];
    const base = name.replace(/ 재생\(초당\)$/, '');
    for (const [re, c] of RESOURCE_COLOR) if (re.test(base)) return c;
    return 'var(--text-muted)';
};

const fmtStat = (v) => {
    const n = Math.round(v * 100) / 100;
    return Number.isInteger(n) ? String(n) : String(n);
};
// 화면에 쓰는 이름. "(초당)" 은 좁아서 "/초" 로 줄인다.
const statLabel = (k) => k.replace('(초당)', '/초');

// ------------------------------------------------------------
//  1~18레벨 꺾은선
//
//  ★ SVG 는 **선만** 그리고 점·라벨·눈금은 HTML 로 얹는다 (2026-08-12).
//    처음엔 전부 SVG 로 그리고 `preserveAspectRatio="none"` 으로 폭을 늘렸는데,
//    **글자와 점이 가로로 3배 늘어나 찌그러졌다** (viewBox 320 → 실제 1100px).
//    선은 늘어나도 되지만 글자·원은 안 된다. 그래서 좌표만 % 로 잡고
//    나머지는 HTML 절대배치로 뺐다 — 폰이든 데스크톱이든 글자 크기가 그대로다.
//
//  · y 축은 0 부터 그린다. 밑을 자르면 조금 크는 값도 급상승처럼 보인다
//    (마법 저항력 32 -> 58 은 실제로 완만하다).
//  · 값 라벨은 **양 끝만** 찍는다. 18개 전부 찍으면 읽을 수 없다.
//    중간 값은 커서를 올리면 나온다.
//  · 점은 작아서 정확히 못 맞춘다 → 각 점이 담당하는 x 구간을 덮는 투명 칸을
//    **점 바로 앞**에 깔고 CSS 인접 선택자로 켠다.
//  · 숫자·라벨은 본문색을 쓴다. 색은 선과 점이 갖는다.
// ------------------------------------------------------------
function statGraphHtml(vals, color, extras = [], axis = null) {
    const n = vals.length;
    // ★ 축은 **밖에서 정해 받는다** (전 챔피언 범위, statGlobalRange).
    //   여기서 챔피언·평균선을 보고 잡으면 역할군 버튼을 켤 때마다 다시 스케일되어
    //   **챔피언 곡선의 개형이 바뀐다** — 같은 챔피언인데 선이 납작해졌다 살아난다.
    //   범위 밖으로 나가는 선은 clip 으로 자르고 범례에 "그래프 밖" 이라고 적는다.
    let top = (axis && axis.top) || Math.max(...vals) * 1.1 || 1;
    let bottom = (axis && axis.bottom) || 0;
    if (!(top > bottom)) { bottom = 0; top = top || 1; }
    const px = (i) => (i / (n - 1)) * 100;                    // x: 0~100%
    const py = (v) => ((v - bottom) / (top - bottom)) * 100;  // y: 바닥에서 0~100%
    const poly = (arr) => arr.map((v, i) => `${px(i)},${100 - py(v)}`).join(' ');

    // 선은 viewBox 를 늘려 그린다. 굵기는 non-scaling-stroke 로 2px 을 지킨다.
    //   평균선은 **먼저** 그려서 챔피언 선 아래에 깔린다 (겹치면 본인 값이 보여야 한다).
    //   clip 은 **평균선에만** 건다 — SVG 통째로 overflow:hidden 을 주면 양 끝
    //   x=0 / x=100 에서 챔피언 선의 굵기가 절반 잘려 끝이 얇아 보인다.
    const avgLines = !extras.length ? '' : `
                <defs><clipPath id="statClipY"><rect x="-20" y="0" width="140" height="100"/></clipPath></defs>
                <g clip-path="url(#statClipY)">` + extras.map(e => `
                    <polyline points="${poly(e.vals)}" fill="none" stroke="${e.color}"
                              stroke-width="${e.solid ? 2 : 1.5}"${e.solid ? '' : ' stroke-dasharray="5 4"'}
                              stroke-linejoin="round" stroke-linecap="round"
                              vector-effect="non-scaling-stroke" opacity="0.9"/>`).join('') + `
                </g>`;

    const grid = [6, 11, 16].map(lv => `
        <i class="g-grid" style="left:${px(lv - 1)}%"></i>
        <span class="g-ax" style="left:${px(lv - 1)}%">${lv}</span>`).join('');

    const marks = vals.map((v, i) => {
        const left = i === 0 ? 0 : (px(i - 1) + px(i)) / 2;
        const right = i === n - 1 ? 100 : (px(i) + px(i + 1)) / 2;
        // 양 끝에서는 말풍선이 잘리지 않게 정렬을 바꾼다
        const align = i <= 1 ? 'start' : (i >= n - 2 ? 'end' : 'mid');
        // 평균선을 켜 뒀으면 같은 말풍선에 그 레벨의 평균도 같이 적는다.
        // 선만 보고 눈대중하는 것보다 이쪽이 비교가 된다.
        const cmp = extras.map(e =>
            `<i class="g-cmp" style="color:${e.color}">${e.label} ${fmtStat(e.vals[i])}</i>`).join('');
        return `<i class="g-hit" style="left:${left}%; width:${right - left}%"></i>` +
            `<span class="g-pt g-a-${align}" style="left:${px(i)}%; bottom:${py(v)}%">` +
            `<i class="g-dot" style="background:${color}"></i>` +
            `<b class="g-val">Lv.${i + 1} · ${fmtStat(v)}${cmp}</b></span>`;
    }).join('');

    return `
    <div class="stat-graph-inner">
        <div class="g-plot">
            <svg class="g-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${avgLines}
                <polyline points="${poly(vals)}" fill="none" stroke="${color}" stroke-width="2"
                          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
            </svg>
            ${grid}
            <span class="g-end g-start" style="bottom:${py(vals[0])}%">${fmtStat(vals[0])}</span>
            <span class="g-end g-last" style="bottom:${py(vals[n - 1])}%">${fmtStat(vals[n - 1])}</span>
            ${marks}
            <span class="g-ax g-ax-first" style="left:0%">1</span>
            <span class="g-ax g-ax-last" style="left:100%">18</span>
        </div>
    </div>`;
}

// ------------------------------------------------------------
//  역할군 평균 비교 (2026-08-12)
//
//  그래프 위에 역할군 버튼 6개를 두고, 켜면 그 역할군 챔피언들의 **레벨별 평균**을
//  점선으로 겹쳐 그린다. 챔피언 본인 선은 굵은 실선이라 항상 위에 온다.
//  모집단은 champRoleMap (Data Dragon tags) ∩ championStats 다.
// ------------------------------------------------------------

// 평균선 색. 6개를 나란히 놓으므로 여기는 **색이 구분 역할**이라 색맹 대비가 필요하다.
//   Okabe-Ito 팔레트에서 골랐다 (스탯 색 팔레트와는 다른 목적이다).
const ROLE_LINE = {
    fighter: '#e69f00', assassin: '#d55e00', mage: '#56b4e9',
    marksman: '#009e73', tank: '#0072b2', support: '#cc79a7',
};
// 범례에서만 쓰는 짧은 이름. "원거리 딜러 평균 …" 은 줄이 길어서 역할군 버튼 오른쪽과
// 맞물린다. 버튼 말풍선에는 정식 이름이 그대로 나온다.
const ROLE_SHORT = { marksman: '원딜' };

// 지금 켜 둔 비교용 역할군. 스탯을 바꿔도 유지된다 (챔피언 목록 필터와는 별개다).
const avgRoles = new Set();

// (역할군, 스탯) → 1~18레벨 평균. 값은 안 변하므로 한 번 구하면 캐시한다.
const roleAvgCache = {};
function roleAvgVals(role, statKey) {
    const ck = role + '|' + statKey;
    if (ck in roleAvgCache) return roleAvgCache[ck];
    const acc = new Array(18).fill(0);
    let cnt = 0;
    for (const id in championStats) {
        const roles = champRoleMap[id];
        if (!roles || !roles.includes(role)) continue;
        // ★ 자원은 챔피언마다 키 이름이 다르다(마나·기력·분노…). **같은 키를 가진 챔피언만**
        //   센다 — 마나 평균에 기력을 섞으면 뜻이 없고, 자원 없는 챔피언을 0으로 넣으면
        //   평균이 통째로 내려앉는다.
        const v = championStats[id].s[statKey];
        if (!v) continue;
        for (let i = 0; i < 18; i++) acc[i] += statAtLevel(v, i + 1);
        cnt++;
    }
    return (roleAvgCache[ck] = cnt ? { vals: acc.map(x => x / cnt), count: cnt } : null);
}

// ★ y 축 = **전 챔피언이 갖는 값의 범위** (2026-08-12).
//   천장 = 18레벨 기준 1위 챔피언 / 바닥 = 1레벨 기준 꼴찌 챔피언.
//   내 챔피언 값으로 축을 잡으면 어느 챔피언을 봐도 선이 화면을 꽉 채워서
//   "이게 높은 건지 낮은 건지" 가 안 보인다. 전체 범위를 축으로 두면 선의 높이가
//   곧 순위 감각이 된다.
//   바닥이 0 이던 걸 "1레벨 최솟값" 으로 내린 이유: 어느 챔피언도 그 아래로는 안 가서
//   0~최솟값 구간이 항상 비어 있었다. 잘라내면 같은 세로 길이에서 차이가 더 보인다.
//   **역할군 평균·vs 챔피언도 이 범위를 못 벗어난다** (평균은 최소~최대 사이) —
//   축이 누구를 켜든 안 흔들리는 이유다.
const statRangeCache = {};
function statGlobalRange(statKey) {
    if (statKey in statRangeCache) return statRangeCache[statKey];
    let hi = null, lo = null;
    for (const id in championStats) {
        const v = championStats[id].s[statKey];
        if (!v) continue;
        const name = championStats[id].n;
        const a = statAtLevel(v, 1), b = statAtLevel(v, 18);
        // 성장은 단조증가라 18레벨이 최대·1레벨이 최소다. 그래도 양 끝을 다 본다.
        const m = Math.max(a, b), n = Math.min(a, b);
        if (!hi || m > hi.val) hi = { val: m, name };
        if (!lo || n < lo.val) lo = { val: n, name };
    }
    return (statRangeCache[statKey] = (hi && lo) ? { hi, lo } : null);
}

window.toggleStatAvgRole = function (btn) {
    const r = btn.dataset.role;
    if (avgRoles.has(r)) avgRoles.delete(r); else avgRoles.add(r);
    drawStatPanel();
};

// ------------------------------------------------------------
//  vs 챔피언 — 오른쪽 검색 상자에서 고른 챔피언을 그래프에 겹친다 (2026-08-12)
//
//  목록은 championStats 만 있으면 만들어진다 (키가 곧 DD id 라 아이콘 주소가 나온다).
//  왼쪽 목록과 달리 **역할군 아이콘 줄은 안 넣었다** — 바로 위 "역할군 평균과 비교"
//  아이콘과 생김새가 같아서 뜻이 갈리지 않는다.
// ------------------------------------------------------------

// 평균선(Okabe-Ito)과 안 겹치고 스탯 색과도 안 겹치는 색으로 사이트 강조색을 쓴다.
const VS_LINE = 'var(--accent)';
let vsChampId = null;

// vs 상자는 **그래프가 떠 있을 때만** 쓸 수 있다. 겹칠 그래프가 없으면 눌러도
// 아무 일이 안 일어나서, 꺼진 걸 눈에 보이게 해 두는 편이 낫다.
function syncVsBox() {
    const col = document.querySelector('.stat-vs-col');
    if (!col) return;
    const off = !openStatKey;
    col.classList.toggle('off', off);
    const input = col.querySelector('#vs-search-input');
    if (input) {
        input.disabled = off;
        input.placeholder = off ? '스탯을 먼저 고르세요' : 'vs 챔피언 검색 (초성 가능)';
        if (off) { input.value = ''; filterVsList(); }
    }
}

window.pickVsChamp = function (id) {
    if (!openStatKey) return;                       // 상자가 꺼져 있을 때의 안전장치
    vsChampId = (vsChampId === id) ? null : id;
    document.querySelectorAll('.vs-item').forEach(el => el.classList.toggle('on', el.dataset.id === vsChampId));
    drawStatPanel();
};

window.filterVsList = function () {
    const q = (document.getElementById('vs-search-input') || {}).value || '';
    const cands = koCandidates(q.replace(/\s+/g, ''));
    let shown = 0;
    document.querySelectorAll('.vs-item').forEach(el => {
        const ok = cands.some(c => (el.dataset.search || '').includes(c));
        el.classList.toggle('filtered-out', !ok);
        if (ok) shown++;
    });
    const empty = document.getElementById('vs-list-empty');
    if (empty) empty.style.display = shown ? 'none' : 'block';
};

function vsBoxHtml(selfId) {
    const ids = Object.keys(championStats)
        .filter(id => id !== selfId)                 // 자기 자신과 비교할 이유는 없다
        .sort((a, b) => championStats[a].n.localeCompare(championStats[b].n, 'ko-KR'));
    const items = ids.map(id => {
        const name = championStats[id].n;
        // 초성 헬퍼는 챔피언 필터 절의 getChosung() 을 그대로 쓴다. 표를 두 벌 두면 어긋난다.
        const key = `${name.replace(/\s+/g, '')}|${getChosung(name.replace(/\s+/g, ''))}|${id}`.toLowerCase();
        return `<div class="vs-item${vsChampId === id ? ' on' : ''}" data-id="${id}" data-search="${key}"
                     onclick="pickVsChamp('${id}')" title="${name}">
                    <img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${id}.png" alt="">
                    <span>${name}</span>
                </div>`;
    }).join('');
    // 처음 그릴 때는 아직 스탯을 안 골랐으니 꺼진 채로 나간다 (syncVsBox 가 켜 준다).
    return `
        <div class="stat-vs-col off">
            <span class="search-wrap">
                <input id="vs-search-input" class="champ-search vs-search" type="text" autocomplete="off"
                       placeholder="스탯을 먼저 고르세요" oninput="filterVsList()" disabled>
                <button type="button" class="search-clear" onclick="clearSearchBox(this)" aria-label="검색어 지우기">&times;</button>
            </span>
            <div class="vs-list-wrap">
                <div class="vs-list">${items}<div id="vs-list-empty" class="champ-list-empty" style="display:none">없음</div></div>
            </div>
        </div>`;
}

// 지금 그래프를 띄워 둔 스탯. 표를 다시 그려도 유지된다.
let openStatKey = null;

function drawStatPanel() {
    const panel = document.getElementById('stat-graph-panel');
    if (!panel) return;
    const rec = championStats[window.currentChampStatsId];
    const v = openStatKey && rec && rec.s[openStatKey];
    if (!v) {
        panel.classList.remove('open'); panel.innerHTML = '';
        // 그래프를 닫으면 겹칠 대상도 없다. vs 상자를 끄고 고른 챔피언도 푼다.
        vsChampId = null;
        document.querySelectorAll('.vs-item').forEach(el => el.classList.remove('on'));
        syncVsBox();
        return;
    }

    const vals = Array.from({ length: 18 }, (_, i) => statAtLevel(v, i + 1));
    // y 축은 **전 챔피언 범위**(18레벨 최대 ~ 1레벨 최소)다.
    // 챔피언·역할군·vs 어느 쪽으로도 안 흔들린다.
    const gr = statGlobalRange(openStatKey);
    const axis = gr ? { top: gr.hi.val, bottom: gr.lo.val } : null;
    const top = gr ? gr.hi.val : (Math.max(...vals) * 1.1 || 1);

    // 겹쳐 그릴 선들. 범례는 column-reverse 라 **DOM 앞이 아래**다 —
    // 비교 챔피언을 맨 앞에 두면 범례 맨 아래 칸에 온다.
    const extras = [];

    // vs 챔피언 (오른쪽 검색 상자에서 고른 챔피언). 평균이 아니라 실제 값이라 실선이다.
    const vsRec = vsChampId && championStats[vsChampId];
    const vsV = vsRec && vsRec.s[openStatKey];
    if (vsV) {
        extras.push({
            label: vsRec.n, color: VS_LINE, solid: true,
            vals: Array.from({ length: 18 }, (_, i) => statAtLevel(vsV, i + 1)),
        });
    }

    // 켠 역할군 중 이 스탯의 표본이 있는 것만 선으로 만든다.
    ROLE_ORDER.filter(r => avgRoles.has(r)).forEach(r => {
        const a = roleAvgVals(r, openStatKey);
        if (a) extras.push({
            role: r, label: (ROLE_SHORT[r] || ROLE_KO[r]) + ' 평균',
            color: ROLE_LINE[r], vals: a.vals, count: a.count,
            off: a.vals.some(x => x > top),   // 천장 밖 → 선이 잘린다. 범례에 적어 준다
        });
    });

    const btns = ROLE_ORDER.map(r => {
        const a = roleAvgVals(r, openStatKey);
        const on = avgRoles.has(r) && a;
        // 표본 수(N명)는 범례가 아니라 여기 말풍선에 적는다. 범례 줄이 길어지면
        // 역할군 버튼 오른쪽과 맞물린다.
        return `<button class="role-btn${on ? ' on' : ''}" data-role="${r}" data-label="${ROLE_KO[r]} 평균${a ? ` (${a.count}명)` : ' (없음)'}"
                        style="--rc:${ROLE_LINE[r]}" onclick="toggleStatAvgRole(this)"
                        aria-label="${ROLE_KO[r]} 평균"${a ? '' : ' disabled'}>
                    <img src="${ROLE_ICON}${r}.png" alt="${ROLE_KO[r]}">
                </button>`;
    }).join('');

    // 비교 챔피언이 이 스탯을 아예 안 가진 경우(가렌의 마나 등). 목록에는 켜져 있는데
    // 선이 없으면 고장 난 것처럼 보이므로 이유를 적어 준다.
    const vsNote = (vsRec && !vsV)
        ? `<span class="savg-item"><em>${vsRec.n}: 해당 스탯 없음</em></span>` : '';

    const legend = vsNote + extras.map(e => `
        <span class="savg-item">
            <i class="savg-swatch${e.solid ? ' solid' : ''}" style="border-top-color:${e.color}"></i>${e.label}
            <b>${fmtStat(e.vals[0])} → ${fmtStat(e.vals[17])}</b>
            ${e.off ? '<em>그래프 밖</em>' : ''}
        </span>`).join('');

    // ★ 범례는 제목 줄 오른쪽 끝에 **아래에서 위로** 쌓인다 (2026-08-12).
    //   position:absolute + column-reverse 라 몇 줄이 되든 그래프가 안 밀린다.
    //   (폰에서는 옆에 놓을 자리가 없어 제목 아래 보통 흐름으로 떨어진다 — style.css 참고)
    panel.classList.add('open');
    panel.innerHTML = `
        <div class="stat-graph-head">
            <div class="sgh-row sgh-main">
                <i class="stat-dot" style="background:${statColorOf(openStatKey)}"></i>
                <div class="sgh-title">
                    <b>${statLabel(openStatKey)}</b>
                    <span>레벨 1 → 18${gr ? ` · 세로축 ${fmtStat(gr.lo.val)}(${gr.lo.name}) ~ ${fmtStat(gr.hi.val)}(${gr.hi.name})` : ''}</span>
                </div>
            </div>
            <div class="sgh-row">
                <span class="savg-title">역할군 평균</span>
                <span class="savg-btns">${btns}</span>
            </div>
        </div>
        ${statGraphHtml(vals, statColorOf(openStatKey), extras, axis)}
        <div class="savg-legend">${legend}</div>`;

    // ★ 범례는 DOM 상 그래프 **뒤**에 두고, 데스크톱에서만 제목 줄 자리로 끌어올린다.
    //   - 폰(정적 배치)에서는 그대로 그래프 아래에 남아 그래프가 안 밀린다.
    //   - 데스크톱에서는 bottom 을 제목 줄 끝에 맞춰야 하는데 제목 줄 높이가 글자
    //     줄바꿈에 따라 달라질 수 있어서 CSS 상수 대신 여기서 재서 넣는다.
    //     (translateY(-100%) 로 위로 자라므로 top 만 정해 주면 된다)
    //   ★ 바닥은 제목 블록 끝이다. 제목 블록 아래쪽에 여백(padding-bottom)을 잡아 두고
    //     거기서부터 위로 쌓는다 — 6역할군 + vs = 7줄이 다 들어가야 하는데,
    //     조상 `.champ-tab-scroll` 이 overflow:auto 라 **패널 위쪽으로 넘어가면 잘린다.**
    const head = panel.querySelector('.stat-graph-head');
    const lg = panel.querySelector('.savg-legend');
    if (head && lg) lg.style.top = head.offsetHeight + 'px';

    syncVsBox();
}

window.toggleStatGraph = function (key) {
    openStatKey = (openStatKey === key) ? null : key;
    document.querySelectorAll('.stat-tname').forEach(b => b.classList.toggle('on', b.dataset.key === openStatKey));
    drawStatPanel();
};

window.renderChampStats = function (champId) {
    const host = document.getElementById('champ-stats-body');
    if (!host) return;
    const rec = (typeof championStats !== 'undefined') ? championStats[champId] : null;
    if (!rec) { host.innerHTML = `<div class="stat-foot">이 챔피언의 스탯 데이터가 없습니다.</div>`; return; }

    const s = rec.s;
    openStatKey = null;
    // 챔피언을 바꾸면 비교 대상도 푼다. 안 그러면 "가렌 vs 가렌" 이 생긴다.
    vsChampId = null;

    // 줄 순서: 체력 / 체력 재생 / 자원 / 자원 재생 / 공격력 / 공격 속도 / 방어력 / 마법 저항력 /
    //          이동 속도 / 사거리.
    //   자원은 챔피언마다 이름이 달라서(마나·기력·분노·투지…) 남는 키를 자동으로 끼워 넣는다.
    const resKeys = Object.keys(s).filter(k => !STAT_COLOR[k]);
    const order = ['체력', '체력 재생(초당)',
        ...resKeys.filter(k => !/재생/.test(k)), ...resKeys.filter(k => /재생/.test(k)),
        '공격력', '공격 속도', '방어력', '마법 저항력', '이동 속도', '사거리'].filter(k => s[k]);

    const row = (k, color, v1, v18, clickable) => `
        <tr class="stat-trow">
            <th scope="row">
                <button class="stat-tname${clickable ? '' : ' flat'}" data-key="${k}"
                        ${clickable ? `onclick="toggleStatGraph('${k}')"` : 'disabled'}>
                    <i class="stat-dot" style="background:${color}"></i>${statLabel(k)}
                </button>
            </th>
            <td>${v1}</td>
            <td class="stat-t18">${v18}</td>
        </tr>`;

    // ★ 안 크는 스탯(대부분의 이동 속도·사거리)도 누를 수 있다. 수평선이어도 그게 정보고,
    //   역할군 평균과 겹쳐 보면 "안 크는데 남들보다 높다/낮다" 가 바로 보인다.
    //   못 누르는 건 아래 자원 없는 챔피언의 "-" 줄뿐이다.
    let rows = order.map(k => {
        const vals = Array.from({ length: 18 }, (_, i) => statAtLevel(s[k], i + 1));
        return row(k, statColorOf(k), fmtStat(vals[0]), fmtStat(vals[17]), true);
    }).join('');

    // ★ 자원을 안 쓰는 챔피언(가렌·리븐·카타리나 등)에도 마나 칸을 만든다.
    //   값은 "-" 다. 챔피언마다 표의 줄 수가 달라지면 옆에 붙는 그래프 칸 높이도 같이 흔들린다.
    if (!resKeys.length) {
        const dash = ['마나', '마나 재생(초당)']
            .map(k => row(k, '#3a4048', '-', '-', false)).join('');
        // 체력 재생 바로 뒤에 끼워 넣는다 (자원이 있는 챔피언과 같은 자리)
        const at = rows.indexOf('</tr>', rows.indexOf('체력 재생')) + 5;
        rows = rows.slice(0, at) + dash + rows.slice(at);
    }

    host.innerHTML = `
        <div class="stat-layout">
            <table class="stat-table">
                <thead><tr><th>스탯</th><th>1레벨</th><th>18레벨</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <div id="stat-graph-panel" class="stat-graph-panel"></div>
            ${vsBoxHtml(champId)}
        </div>
        <div class="stat-foot" id="stat-foot">스탯 이름을 누르면 오른쪽에 1~18레벨 성장 곡선이 나옵니다. 레벨 성장은 직선이 아니라 중간이 완만합니다.<br>그래프 위 역할군 아이콘을 누르면 그 역할군 챔피언들의 레벨별 평균이 점선으로, 오른쪽에서 고른 챔피언은 실선으로 겹쳐집니다.</div>`;
    syncVsBox();
    // ★ 체력을 기본으로 열어 둔다 (2026-08-31, 260830 디자인 5-③) — 그래프 자리가 빈 채로 시작하지 않게.
    //   openStatKey 는 위에서 null 로 초기화됐으므로 toggle 이 곧 "켜기"다
    if (s['체력']) toggleStatGraph('체력');
};

window.switchChampTab = function (event, tabName) {
    document.querySelectorAll('.champ-tab-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.style.color = 'var(--text-muted)'; btn.style.fontWeight = 'normal'; btn.style.borderBottomColor = 'transparent';
    });
    event.currentTarget.classList.add('active');
    event.currentTarget.style.color = '#fff';
    event.currentTarget.style.fontWeight = 'bold';
    event.currentTarget.style.borderBottomColor = 'var(--accent)';

    document.querySelectorAll('.champ-tab-content').forEach(content => content.style.display = 'none');
    const targetTab = document.getElementById(`champ-tab-${tabName}`);
    if (targetTab) targetTab.style.display = 'block';

    // 주소를 탭에 맞춘다 (이력은 안 쌓는다 — champViewUrl 주석 참고)
    champViewTab = CHAMP_TABS.includes(tabName) ? tabName : 'skills';
    syncChampUrl();

    // ★ 스탯 탭이 숨겨진 채로 기본(체력) 그래프가 그려지면 범례 top 계산(offsetHeight)이 0 이라
    //   탭을 열 때 한 번 다시 그린다 (2026-08-31, 기본 선택의 짝)
    if (tabName === 'stats') drawStatPanel();
    // 배경·대사는 열 때 채운다 (배경은 960KB 라 미리 받지 않는다)
    if (tabName === 'lore') renderChampLore();
    if (tabName === 'quotes') renderChampQuotes();
    // 스킨 탭을 열면 나머지 원본 일러스트를 한 장씩 미리 받아 둔다 (위 preloadSkinFulls 주석)
    if (tabName === 'skins') preloadSkinFulls(window.currentSkinList || [], (window.currentSkinIndex || 0) + 1);
};

// ============================================================
//  배경 탭 · 대사 탭 (2026-08-13)
//
//  출처는 라이엇 Universe 이고 `build_champion_lore.js` 가 받아 둔다:
//    public/champion_lore.json  — 배경 전문 173명 (960KB, 여기서만 쓴다)
//    public/champion_quotes.js  — 대표 대사 173명 (18KB, 챔피언 데이터와 같이 받는다)
//
//  ★ Data Dragon 의 `lore` 는 전문이 아니라 짧은 소개(212자)다. 전문은 Universe 에만 있다.
//  ★ 전체 인게임 대사는 공개 데이터에 없다 — 라이엇이 주는 건 픽/밴 음성 파일 두 개뿐이다.
// ============================================================

// ★ 챔피언 하나당 파일 하나다 (`public/lore/<id>.json`, 중앙값 5.4KB / gzip 2.4KB).
//   통짜 하나(gzip 335KB)로 뒀다가 쪼갰다 — 배경을 실제로 열어보는 건 서너 명인데
//   **통짜가 이득이 되려면 한 사람이 140명을 열어봐야 한다.**
//   같은 챔피언을 다시 열면 여기 캐시에서 바로 나간다.
const championLoreCache = {};
const championLorePromises = {};

function loadChampionLore(id) {
    if (championLoreCache[id] !== undefined) return Promise.resolve(championLoreCache[id]);
    if (championLorePromises[id]) return championLorePromises[id];

    championLorePromises[id] = fetch('/lore/' + encodeURIComponent(id) + '.json')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(text => { championLoreCache[id] = text; return text; })
        .catch(e => { delete championLorePromises[id]; throw e; });   // 실패하면 다시 시도할 수 있게
    return championLorePromises[id];
}

window.renderChampLore = async function () {
    const box = document.getElementById('champ-lore-body');
    if (!box || box.dataset.champ === window.currentChampLoreId) return;   // 이미 그린 챔피언이면 그냥 둔다

    const id = window.currentChampLoreId;
    box.dataset.champ = id;

    // ★ 손으로 쓴 글이 있으면 그게 우선이다 (링크 등이 들어 있다). HTML 이라 그대로 넣는다.
    if (typeof customLore !== 'undefined' && customLore[id]) {
        box.innerHTML = customLore[id];
        return;
    }

    box.textContent = '배경 이야기를 불러오는 중...';
    try {
        const text = await loadChampionLore(id);
        if (box.dataset.champ !== id) return;            // 그 사이 다른 챔피언으로 옮겼으면 버린다
        // textContent 로 넣는다 — 생성 때 태그를 벗겨 둔 순수 텍스트고, CSS 가 pre-wrap 이라
        // 빈 줄이 그대로 문단이 된다
        box.textContent = text || window.currentChampShortLore || '배경 이야기가 없습니다.';
    } catch (e) {
        if (box.dataset.champ !== id) return;
        box.textContent = window.currentChampShortLore || '배경 이야기를 불러오지 못했습니다.';
    }
};

window.renderChampQuotes = function () {
    const box = document.getElementById('champ-quotes-body');
    if (!box) return;

    const id = window.currentChampLoreId;
    const key = window.currentChampVoiceKey;
    const q = (typeof championQuotes !== 'undefined' && championQuotes[id]) || null;

    box.innerHTML = `
        ${q ? `
            <blockquote class="champ-quote">
                <p class="champ-quote-text">${escapeHtml(q.q)}</p>
                ${q.a ? `<footer class="champ-quote-author">— ${escapeHtml(q.a)}</footer>` : ''}
            </blockquote>` : ''}
        <div class="champ-voice-row">
            <button type="button" class="champ-voice-btn" onclick="playChampVoice('${key}', 'pick')">
                <span class="champ-voice-icon">▶</span> 챔피언 선택 음성
            </button>
            <button type="button" class="champ-voice-btn" onclick="playChampVoice('${key}', 'ban')">
                <span class="champ-voice-icon">▶</span> 밴 음성
            </button>
        </div>
        <p class="champ-voice-note">
            라이엇이 공개하는 음성은 선택·밴 두 가지입니다. 인게임 대사 전체는 제공되지 않습니다.
        </p>
    `;
};

window.playSkill = function (index) {
    const skill = window.currentChampSkills[index];
    if (!skill) return;

    document.querySelectorAll('.skill-btn').forEach(btn => btn.style.background = 'rgba(255,255,255,0.02)');
    document.querySelectorAll('[id^="skill-img-"]').forEach(img => img.style.borderColor = 'transparent');
    const activeBtn = document.getElementById(`skill-btn-${index}`);
    const activeImg = document.getElementById(`skill-img-${index}`);
    if (activeBtn) activeBtn.style.background = 'rgba(167, 139, 250, 0.1)';
    if (activeImg) activeImg.style.borderColor = 'var(--accent)';

    const iconHeaderEl = document.getElementById('champ-skill-icon-header');
    const iconHeader2El = document.getElementById('champ-skill-icon-header-2');

    if (iconHeaderEl) iconHeaderEl.src = skill.img;

    // ★ 보조 아이콘 표시/숨김 로직
    if (iconHeader2El) {
        if (skill.img2) {
            iconHeader2El.src = skill.img2;
            iconHeader2El.style.display = 'block';
        } else {
            iconHeader2El.style.display = 'none';
            iconHeader2El.src = '';
        }
    }

    // ★ 스킬 이름 옆에는 **기본 아이콘 하나만** 둔다 (2026-08-10 변경).
    //   예전엔 하위 아이콘(재시전·진화·2타…)을 여기에 전부 늘어놨는데,
    //   그러면 "이게 뭘 가리키는 아이콘인지" 를 알 수 없다.
    //   지금은 배열 템플릿이 **구분선 아래 각 파트 옆에** 짝지어 그린다
    //   (가렌 E 의 "재사용 시" 옆처럼). 그래야 아이콘과 설명이 붙어서 뜻이 통한다.
    //   ★ 배열 템플릿이 아직 없는 스킬은 아이콘이 화면에 안 나온다.
    //     문장을 파트로 쪼개면 그때 나온다 — `남은작업.md` 1순위 참고.
    //   ★ 단, **아직 문장을 안 쪼갠 스킬**은 여기 말고는 아이콘을 보여 줄 자리가 없다.
    //     그런 스킬까지 비우면 아이콘이 화면에서 통째로 사라진다. 그래서 배열 템플릿이
    //     없는 스킬만 예전처럼 이름 옆에 붙인다 (문장을 쪼개면 자동으로 여기서 빠진다).
    const iconExtraEl = document.getElementById('champ-skill-icon-extra');
    if (iconExtraEl) {
        const list = (!skill.partTpl && skill.values && Array.isArray(skill.values.icons))
            ? skill.values.icons : [];
        iconExtraEl.innerHTML = list.map(u =>
            `<img src="${u}" style="width: 48px; height: 48px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);" onerror="this.style.display='none'">`
        ).join('');
    }

    // ★ 첫 번째 폼 라벨 (미니 나르·인간 형태…). 폼이 두 개인 챔피언에만 뜬다.
    //   두 번째 폼 박스의 라벨과 짝이다 — 한쪽만 있으면 어느 폼 설명인지 알 수 없다.
    const formEl = document.getElementById('champ-skill-form');
    if (formEl) {
        const f1 = (skill.values && skill.values.form1) || '';
        formEl.textContent = f1;
        formEl.style.display = f1 ? 'block' : 'none';
    }

    const nameEl = document.getElementById('champ-skill-name-header');
    if (nameEl) nameEl.innerHTML = `<span style="color:var(--text-bright); font-weight: normal; font-size: 16px;">[${skill.keyChar}]</span> ${skill.name}`;

    const cooldownEl = document.getElementById('champ-skill-cooldown-header');
    const costEl = document.getElementById('champ-skill-cost-header');
    // ★ 값이 "-" 면 줄을 통째로 숨긴다 (2026-08-24). 인게임 툴팁도 소모값 없는 스킬엔
    //   소모값 줄 자체가 없다. **"없음" 은 숨기지 않는다** — 클라가 "재사용 대기시간 없음"
    //   이라고 일부러 적는 자리다 (바이 W·쉬바나 R·유나라 Q·자이라 W·트위스티드 페이트 E).
    // ★ 값이 이미 "재충전 대기시간 …" 같은 문장이면 라벨을 뺀다 (2026-08-24).
    //   "쿨타임 재충전 대기시간 17…" 처럼 말이 겹쳐서 어색했다 — 클라도 그 자리엔 문장만 쓴다
    //   (갱플랭크 E·닐라 E·밀리오 E·아무무 Q·아지르 W·코르키 R·하이머딩거 Q).
    const metaLine = (label, v, extra) => {
        if (!v || v === '-') return '';
        const skipLabel = label === '쿨타임' && /^[가-힣 ]*대기시간/.test(String(v));
        return `${skipLabel ? '' : label + ' '}${v}${extra || ''}`;
    };
    if (cooldownEl) cooldownEl.innerHTML = metaLine('쿨타임', skill.cooldown, skill.cooldownNote);
    if (costEl) costEl.innerHTML = metaLine('소모값', skill.cost);

    const descTextEl = document.getElementById('champ-skill-desc-text-body');
    if (descTextEl) descTextEl.innerHTML = skill.desc;

    // ★ 두 번째 폼 박스 채우기 / 숨기기
    const box2El = document.getElementById('champ-skill2-box');
    if (box2El) {
        const f2 = skill.form2;
        if (f2) {
            const put = (id, html) => {
                const el = document.getElementById(id);
                if (el) el.innerHTML = html;
            };
            const icon2 = document.getElementById('champ-skill2-icon');
            if (icon2) icon2.src = f2.icon;
            put('champ-skill2-form', f2.label);
            put('champ-skill2-name',
                `<span style="color:var(--text-bright); font-weight: normal; font-size: 16px;">[${skill.keyChar}]</span> ${f2.name}`);
            put('champ-skill2-cooldown', metaLine('쿨타임', f2.cooldown));
            put('champ-skill2-cost', metaLine('소모값', f2.cost));
            put('champ-skill2-desc', f2.desc);
            box2El.style.display = 'block';
        } else {
            box2El.style.display = 'none';
        }
    }

    // ★ 우상단: 사거리·시전시간 등 판정 수치
    //   키를 직접 정해서 넣으므로 순서대로 그대로 뿌린다. 빈 키나 빈 값은 건너뛴다.
    const statsHeaderEl = document.getElementById('champ-skill-stats-header');
    if (statsHeaderEl) {
        let lines = '';
        for (let key in (skill.stats || {})) {
            const v = skill.stats[key];
            if (!key.trim() || v === null || v === undefined || v === '') continue;
            lines += `<div>${key} <span style="color:var(--text-bright); font-weight: 700;">${v}</span></div>`;
        }
        statsHeaderEl.innerHTML = lines;
    }

    // ★ 하단: 피해량과 계수 (구분선 아래)
    const bottomHrEl = document.getElementById('champ-skill-bottom-hr');
    const customBottomEl = document.getElementById('champ-skill-custom-bottom');

    const vals = skill.values || {};
    const damageLines = ['v1', 'v2']
        .map(k => vals[k])
        .filter(v => v !== null && v !== undefined && String(v).trim() !== '');

    if (damageLines.length > 0) {
        if (customBottomEl) {
            customBottomEl.innerHTML = damageLines
                .map(v => `<div class="skill-damage-line">${v}</div>`)
                .join('');
        }
        if (bottomHrEl) bottomHrEl.style.display = 'block';
    } else {
        if (customBottomEl) customBottomEl.innerHTML = '';
        if (bottomHrEl) bottomHrEl.style.display = 'none';
    }

    // ★ 예시 영상. **없는 스킬이 있다** — 라이엇이 안 만든 자리다 (이즈리얼 패시브가 그렇다).
    //   예전엔 그냥 src 를 꽂아서 실패하면 **검은 네모만 남았다.**
    //   지금은 숨겨 두고 성공했을 때만 보여 준다.
    // ★★ 호스트를 `lol.dyn.riotcdn.net` 으로 바꿨다 (2026-08-23). 라이엇 공식 챔피언 페이지가 지금 쓰는 곳이다.
    //   옛 cloudfront 는 **갱신이 멈춘 사본**이었다 — 전수 대조(865건)에서 836건은 ETag 가 같지만
    //   쉬바나 Q/W/E/R 은 2026-03 리워크 판이 새 호스트에만 있고, 로크·신 짜오 영상 10개와
    //   쉬바나·헤카림·트리스타나 패시브는 새 호스트에만 존재한다. 옛 호스트에만 있는 건 0건.
    //   케넨처럼 "영상이 옛날 것" 인 챔피언은 두 호스트가 같은 파일(2016-07 업로드)이라 라이엇에 더 새 게 없다.
    const VIDEO_BASE = 'https://lol.dyn.riotcdn.net/x/videos/champion-abilities';
    const setVideo = (el, id) => {
        if (!el) return;
        const url = `${VIDEO_BASE}/${window.currentChampPaddedKey}/ability_${window.currentChampPaddedKey}_${id}.webm`;
        if (el.dataset.want === url) return;      // 같은 영상이면 다시 안 건드린다
        el.dataset.want = url;
        el.style.display = 'none';
        el.onloadeddata = () => { if (el.dataset.want === url) el.style.display = 'block'; };
        el.onerror = () => { el.style.display = 'none'; };
        el.src = url;
        el.play().catch(() => { });
    };

    // ★ 라이엇이 파일 번호를 어긋나게 올린 자리 (2026-08-12 전수 조사).
    //   173챔피언 x P/Q/W/E/R x 1~5 를 전부 두드려 본 결과, 슬롯당 영상은 하나뿐이고
    //   두 번째 영상(Q2·W2·E2·R2)은 폼이 둘인 5명(나르·엘리스·제이스·니달리·렉사이)에만 있다.
    //   자헨만 Q 영상이 `Q1` 이 아니라 `Q2` 로 올라가 있어서 우리 화면에서 통째로 안 나왔다.
    //   (로크·신 짜오는 옛 호스트엔 없었고 새 호스트(2026-08-23 전환)엔 있다)
    const VIDEO_ID_FIX = { '0904': { Q1: 'Q2' } };   // 4자리 키 -> { 원래id: 실제id }
    const fixId = (id) => (VIDEO_ID_FIX[window.currentChampPaddedKey] || {})[id] || id;

    setVideo(document.getElementById('champ-skill-video'), fixId(skill.id));

    // 두 번째 폼도 자기 영상이 따로 있다 (나르 메가 Q2·W2·E2 등)
    const v2El = document.getElementById('champ-skill2-video');
    if (v2El) {
        if (skill.form2) setVideo(v2El, fixId(skill.keyChar + '2'));
        else { v2El.style.display = 'none'; v2El.removeAttribute('src'); delete v2El.dataset.want; }
    }
};

window.playChampVoice = function (champKey, type) {
    let audioPlayer = document.getElementById('champ-voice-player');
    if (!audioPlayer) {
        audioPlayer = document.createElement('audio');
        audioPlayer.id = 'champ-voice-player';
        document.body.appendChild(audioPlayer);
    }

    const baseUrl = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/ko_kr/v1/';
    audioPlayer.src = type === 'pick' ? `${baseUrl}champion-choose-vo/${champKey}.ogg` : `${baseUrl}champion-ban-vo/${champKey}.ogg`;
    audioPlayer.volume = 0.5;

    audioPlayer.play().catch(err => {
        showErrorToast("해당 챔피언의 음성 파일을 불러올 수 없습니다.");
    });
};

// ============================================================
//  스킨 탭 (2026-08-13)
//
//  왼쪽에 얼굴 중심 썸네일을 세로로 쌓고, 누르면 오른쪽에 원본 일러스트가 뜬다.
//  골격은 스킬 탭(.champ-skill-layout)과 같다.
//
//  ★ 데이터는 CommunityDragon 이다. Data Dragon 은 스플래시 한 장뿐이라
//    "얼굴 중심" 판본도, 한국어 스킨 설명도 없다.
//    CD `ko_kr/v1/champions/<숫자키>.json` 이 스킨마다 경로 4종을 직접 알려준다:
//      splashPath(1280x720 얼굴 중심) / uncenteredSplashPath(1215x717 원본)
//      tilePath(380 정사각) / loadScreenPath(308x560 세로)
//  ★ 스킨 번호는 연속이 아니다 — 가렌은 86011 다음이 86013 이다(86012 는 없다).
//    그래서 번호를 세서 만들지 말고 CD 가 준 목록을 그대로 쓴다
// ============================================================

const CD_ASSET_BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';

// ★ 등급 보석 아이콘. 라이엇이 이름으로 올려 둔 6종이 전부다 (2026-08-13 디렉터리 확인).
//   `kRare`(19개)·`kNoRarity`(832개)는 파일이 아예 없다 — 인게임에서도 보석이 없는 등급이라
//   빈칸으로 두는 게 맞다. `rare.png` 는 404 다.
const SKIN_GEM = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/rarity-gem-icons/';
const SKIN_RARITY_GEM = {
    kEpic: 'epic', kLegendary: 'legendary', kMythic: 'mythic',
    kUltimate: 'ultimate', kExalted: 'exalted', kTranscendent: 'transcendent'
};

function skinGemUrl(rarity) {
    const g = SKIN_RARITY_GEM[rarity];
    return g ? SKIN_GEM + g + '.png' : null;
}

// 신화 정수 아이콘. 경로는 CD 의 `v1/lolcurrency.json` 이 알려준다
//   (`lol_mythic_essence` → mythic-essence-icon.svg). 15x18 짜리 svg 고 그라데이션이
//   파일 안에 들어 있어서 어두운 배경에서도 그대로 보인다.
const ME_ICON = CD_ASSET_BASE + 'assets/currencies/images/mythic-essence-icon.svg';

// ★ 가격은 `public/skin_prices.js`(build_skin_prices.js 생성)에서 온다.
//   숫자 = RP, "m150" = 150 신화 정수, 키 없음 = 판매 대상이 아님(배틀패스·랭크 보상 등).
//   ★ 등급으로 가격을 추측하면 안 된다 — 전설 123개 중 2개가 975 고,
//     궁극 7개 중 하나가 2775 다. 반드시 이 표를 볼 것
//   ★ HTML 을 돌려준다. 값이 우리가 만든 표의 **숫자**라 이스케이프할 게 없고,
//     신화 정수는 글자 대신 아이콘으로 나가야 해서 태그가 필요하다
function skinPriceHtml(champKey, skinNum) {
    const v = (typeof skinPrices !== 'undefined' && skinPrices[champKey] || {})[skinNum];
    if (v === undefined) return '';
    if (typeof v === 'number') return v + 'RP';
    return Number(String(v).slice(1)) + ` <img class="me-icon" src="${ME_ICON}" alt="신화 정수" title="신화 정수">`;
}

// ★ CD 가 주는 경로는 `/lol-game-data/assets/ASSETS/Characters/...` 꼴인데
//   실제 파일은 **전부 소문자**다. 대문자를 그대로 붙이면 404 가 난다
function cdAssetUrl(p) {
    return p ? CD_ASSET_BASE + String(p).replace('/lol-game-data/assets/', '').toLowerCase() : null;
}

// 실패하면 null 을 돌려준다 — 부르는 쪽이 DD 스플래시로 물러난다.
// (클래식(Jade_) 챔피언은 CD 에 그 숫자키가 없을 수 있다)
async function fetchCdSkins(champKey) {
    try {
        const res = await fetch(`https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/ko_kr/v1/champions/${champKey}.json`);
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data.skins) || data.skins.length === 0) return null;

        return data.skins.map(s => ({
            // ★ id 를 남긴다 (2026-08-17). 신화상점에서 넘어올 때 `catalogId` 와 맞춰 볼 열쇠다 —
            //   스킨 id = 챔피언숫자키 x 1000 + 스킨번호 라 상점이 주는 값과 그대로 맞는다.
            id: s.id,
            num: s.id % 1000,       // 주소에 담는 스킨 번호 (`/champions/Shen/skins/49`)
            name: s.isBase ? '기본 스킨' : s.name,
            thumb: cdAssetUrl(s.splashPath),
            // 원본이 없는 스킨이 있을 수 있으니 얼굴 중심 판본으로 물러난다
            full: cdAssetUrl(s.uncenteredSplashPath) || cdAssetUrl(s.splashPath),
            desc: s.description || '',
            gem: skinGemUrl(s.rarity),
            // ★ 크로마도 같은 파일에 들어 있다 — 추가 요청이 0 이다 (2026-08-13).
            //   `colors` 는 6972개 **전부**에 있어서 색점은 이미지 없이 그릴 수 있고,
            //   그림(`chromaPath`)은 270x303 투명 배경 **3D 모델 렌더**다.
            //   장당 82KB 라 카직스(25개)면 2MB — **눌렀을 때만 받는다**
            chromas: (s.chromas || []).map(c => ({
                id: c.id,               // 신화상점 크로마 상품의 catalogId 와 맞춰 본다
                name: c.name || '',
                img: cdAssetUrl(c.chromaPath),
                colors: Array.isArray(c.colors) ? c.colors : [],
                desc: c.description || ''
            })),
            // ★ 기본 스킨엔 가격을 안 붙인다 (2026-08-13). 위키의 `cost` 가 기본 스킨 자리에선
            //   **스킨값이 아니라 챔피언 가격**이다 (이렐리아·트런들 등 880 짜리가 그 예다).
            //   "기본 스킨 - 880RP" 로 내보내면 없는 상품을 파는 말이 된다.
            //   스킨 id = 챔피언숫자키 x 1000 + 스킨번호. 가격표가 그 두 값으로 짜여 있다
            price: s.isBase ? '' : skinPriceHtml(Math.floor(s.id / 1000), s.id % 1000)
        }));
    } catch (e) {
        return null;
    }
}

// 색점 하나의 배경. 라이엇이 색을 1~2개 준다 — 두 개면 대각선으로 반씩 나눈다.
function chromaDotBg(colors) {
    if (!colors.length) return '#555';
    if (colors.length === 1 || colors[0] === colors[1]) return colors[0];
    return `linear-gradient(135deg, ${colors[0]} 0 50%, ${colors[1]} 50% 100%)`;
}

// ★ 크로마 그림은 여기서 처음 받는다 (색점은 값이라 공짜지만 그림은 82KB 다).
//   같은 점을 다시 누르면 원래 일러스트로 돌아간다.
window.selectChroma = function (i) {
    const skin = (window.currentSkinList || [])[window.currentSkinIndex];
    if (!skin) return;

    const same = window.currentChromaIndex === i;
    window.currentChromaIndex = same ? -1 : i;

    const img = document.getElementById('skin-view-img');
    const nameSpan = document.getElementById('skin-chroma-name');
    const c = skin.chromas[window.currentChromaIndex];

    // ★ 크로마 렌더는 270x303 세로 인물이라 cover 로 채우면 얼굴이 잘린다.
    //   일러스트(가로)와 렌더(세로)가 같은 칸을 쓰므로 맞춰서 바꿔 준다
    // ★ 토큰을 올려 둔다 — selectSkin 이 걸어 둔 "원본 도착하면 바꿔 끼우기" 가
    //   방금 고른 크로마를 덮어쓰지 않게 (2026-08-19)
    ++skinViewToken;
    img.classList.toggle('is-chroma', !!c);
    img.src = c ? c.img : skin.full;

    // 크로마일 때만 원래 일러스트를 흐리게 뒤에 깐다 (빈 좌우를 메운다)
    const bg = document.getElementById('skin-view-bg');
    if (bg) bg.style.backgroundImage = c ? `url("${skin.full}")` : '';

    // ★ 크로마 이름은 "도자기 럭스 (장미석)" 꼴이 6972개 중 6971개다.
    //   괄호 안 색 이름만 뽑으면 스킨 이름이 반복되지 않는다.
    //   (유일한 예외인 "2017 월드 챔피언십 애쉬 크로마" 는 통째로 쓴다)
    if (nameSpan) {
        const m = c && c.name.match(/\(([^)]+)\)\s*$/);
        nameSpan.textContent = c ? ' · ' + (m ? m[1] : c.name) : '';
    }

    document.querySelectorAll('.chroma-dot').forEach(el =>
        el.classList.toggle('active', Number(el.dataset.i) === window.currentChromaIndex));
};

// ============================================================
//  스킨 그림 로딩 최적화 (2026-08-19)
//    큰 그림(uncentered 일러스트, 장당 ~185KB)이 클릭할 때마다 새로 내려와서
//    "누르고 한 박자 기다리는" 느낌이 났다. 두 가지로 잡는다:
//    ① 누르는 즉시 **목록 썸네일(이미 받아 둔 그림)** 을 먼저 걸고, 원본이
//       도착하면 바꿔 끼운다 — 빈 칸/이전 스킨이 걸려 있는 시간이 0 이 된다.
//    ② 스킨 탭을 여는 순간부터 나머지 원본을 **한 장씩 차례로** 미리 받는다.
//       (동시에 다 받으면 지금 보는 그림까지 느려지므로 순차다.)
//       브라우저 캐시에 들어가므로 몇 초 뒤부터는 어떤 스킨을 눌러도 즉시 뜬다.
// ============================================================
let skinViewToken = 0;      // 늦게 도착한 원본이 다음 스킨을 덮어쓰지 않게 하는 표
let skinPreloadToken = 0;   // 챔피언을 바꾸면 이전 챔피언 예열을 중단한다

function preloadSkinFulls(list, startIdx) {
    const token = ++skinPreloadToken;
    const queue = [];
    for (let i = 0; i < (list || []).length; i++) {
        const idx = (startIdx + i) % list.length;   // 보고 있는 스킨 다음 것부터
        if (list[idx] && list[idx].full) queue.push(list[idx].full);
    }
    let i = 0;
    const next = () => {
        if (token !== skinPreloadToken || i >= queue.length) return;
        const img = new Image();
        img.onload = img.onerror = () => setTimeout(next, 80);
        img.src = queue[i++];
    };
    next();
}

window.selectSkin = function (index) {
    const list = window.currentSkinList;
    if (!list || !list[index]) return;

    window.currentSkinIndex = index;
    window.currentChromaIndex = -1;      // 스킨을 바꾸면 크로마 선택도 푼다

    // 주소에 스킨 번호를 담는다 (`/champions/Shen/skins/49`). 이력은 안 쌓는다.
    //   ★ 번호는 배열 자리가 아니라 **스킨 번호**다 — 가렌은 86011 다음이 86013 이라
    //     자리를 담으면 목록이 바뀔 때 엉뚱한 스킨이 열린다.
    if (champViewTab === 'skins') {
        champViewSkin = Number.isInteger(list[index].num) ? list[index].num : -1;
        syncChampUrl();
    }
    document.querySelectorAll('.skin-item').forEach(el => {
        el.classList.toggle('active', Number(el.dataset.i) === index);
    });

    const skin = list[index];
    const img = document.getElementById('skin-view-img');
    if (img) {
        img.classList.remove('is-chroma');
        // ★ "썸네일 먼저 → 원본 교체" 는 **폰에서만** 한다 (2026-08-19 2차).
        //   PC 는 이미 캐시된 원본도 한 프레임 얼굴 중심(썸네일) 구도가 번쩍여서 롤백했다 —
        //   PC 는 어차피 아래 preloadSkinFulls 예열 덕에 곧바로 뜬다.
        //   폰은 회선이 느려 빈 화면이 길어지는 쪽이 더 나빠서 그대로 둔다.
        //   토큰은 "늦게 도착한 원본이 다음에 고른 스킨을 덮어쓰는" 경주 방지다.
        const want = ++skinViewToken;
        const mobile = window.matchMedia('(max-width: 768px)').matches;
        if (mobile && skin.thumb && skin.thumb !== skin.full) {
            img.src = skin.thumb;
            const pre = new Image();
            pre.onload = () => { if (want === skinViewToken) img.src = skin.full; };
            pre.src = skin.full;
        } else {
            img.src = skin.full;
        }
    }
    // 스킨을 바꾸면 크로마도 풀리므로 흐린 배경도 같이 지운다
    const bgEl = document.getElementById('skin-view-bg');
    if (bgEl) bgEl.style.backgroundImage = '';

    // 크로마 점은 그림 **오른쪽에 세로줄**로 붙는다. 없는 스킨이 절반이라
    //   (2111개 중 1037개만 있다) 통째로 접는다.
    const col = document.getElementById('skin-chroma-col');
    if (col) {
        if (skin.chromas && skin.chromas.length) {
            col.innerHTML = skin.chromas.map((c, i) =>
                `<button type="button" class="chroma-dot" data-i="${i}" onclick="selectChroma(${i})"`
                + ` title="${escapeHtml(c.name)}${c.desc ? ' — ' + escapeHtml(c.desc) : ''}"`
                + ` style="background:${chromaDotBg(c.colors)}"></button>`).join('');
            col.classList.remove('is-empty');
        } else {
            // ★ 크로마가 없어도 **칸은 남긴다.** 없앴다 만들었다 하면 가운데 정렬이라
            //   스킨을 넘길 때마다 그림이 좌우로 15px 씩 튄다.
            //   비어 있다는 표시만 해 두고(폰에서는 이 클래스로 접는다) 자리는 지킨다
            col.innerHTML = '';
            col.classList.add('is-empty');
        }
    }

    // (등급 아이콘) 이름 - 가격.  가격을 모르는 스킨은 " - " 까지 통째로 뺀다
    const nameEl = document.getElementById('skin-view-name');
    if (nameEl) {
        nameEl.innerHTML =
            (skin.gem ? `<img class="skin-gem skin-gem-lg" src="${skin.gem}" alt="">` : '')
            + escapeHtml(skin.name)
            // price 는 skinPriceHtml 이 만든 HTML 이라 이스케이프하면 안 된다 (아이콘 태그가 들어 있다)
            + (skin.price ? ` <span class="skin-view-price">- ${skin.price}</span>` : '')
            // 고른 크로마의 색 이름이 여기 들어간다. 줄을 새로 만들지 않아 높이를 안 먹는다
            + `<span class="skin-chroma-name" id="skin-chroma-name"></span>`;
    }

    // 설명이 없는 스킨이 많다(2146개 중 315개가 빈칸). 없으면 줄을 통째로 접는다
    const descEl = document.getElementById('skin-view-desc');
    if (descEl) {
        descEl.textContent = skin.desc;
        descEl.style.display = skin.desc ? 'block' : 'none';
    }
};

// ==========================================
// [9] 닉네임 자동완성 & 태그 후보 목록
// ==========================================
let acTimer = null;
let acItems = [];
let acIndex = -1;
let acSeq = 0;

// 입력 가중치 (한글 2점, 그 외 1점) — 서버 규칙과 동일
function inputWeight(str) {
    let w = 0;
    for (const ch of String(str)) w += /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch) ? 2 : 1;
    return w;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const TIER_SHORT = {
    IRON: 'I', BRONZE: 'B', SILVER: 'S', GOLD: 'G', PLATINUM: 'P',
    EMERALD: 'E', DIAMOND: 'D', MASTER: 'M', GRANDMASTER: 'GM', CHALLENGER: 'C'
};
const DIV_NUM = { I: '1', II: '2', III: '3', IV: '4' };

function shortTier(tier, rank) {
    const t = String(tier || '').toUpperCase();
    if (!TIER_SHORT[t]) return '–';
    if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(t)) return TIER_SHORT[t];
    return TIER_SHORT[t] + (DIV_NUM[String(rank || '').toUpperCase()] || '');
}

function fullTierText(tier, rank, lp) {
    const t = String(tier || '').toUpperCase();
    if (!t || t === 'UNRANKED') return null;
    const div = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(t) ? '' : ` ${rank || ''}`;
    const name = t.charAt(0) + t.slice(1).toLowerCase();
    return `${name}${div} - ${lp ?? 0}LP`;
}

function hideAutocomplete() {
    const box = document.getElementById('autocomplete-dropdown');
    if (box) box.style.display = 'none';
    acItems = [];
    acIndex = -1;
}

function renderAutocomplete(list, typed) {
    const box = document.getElementById('autocomplete-dropdown');
    if (!box) return;

    if (!list || list.length === 0) { hideAutocomplete(); return; }

    // 즐겨찾기 드롭다운(공통)과 동시에 뜨지 않도록
    const fav = document.getElementById('dogu-search-dropdown');
    if (fav) fav.classList.remove('open');

    acItems = list;
    acIndex = -1;

    const typedLen = typed.split('#')[0].length;

    box.innerHTML = list.map((it, i) => {
        const [namePart, tag] = it.displayName.split('#');
        const head = escapeHtml(namePart.slice(0, typedLen));
        const rest = escapeHtml(namePart.slice(typedLen));
        const sub = fullTierText(it.tier, it.rank, it.lp)
            || (it.level ? `Level ${it.level}` : '전적 정보 없음');
        const icon = it.iconId != null
            ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/${it.iconId}.png`
            : `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/29.png`;

        return `
            <div class="ac-item" data-index="${i}" onclick="pickAutocomplete(${i})">
                <img class="ac-icon" src="${icon}" onerror="this.style.visibility='hidden'">
                <div class="ac-body">
                    <div class="ac-name"><span class="ac-hl">${head}</span>${rest}<span class="ac-tag">#${escapeHtml(tag || '')}</span></div>
                    <div class="ac-sub">${escapeHtml(sub)}</div>
                </div>
            </div>`;
    }).join('');

    box.style.display = 'block';
}

function highlightAcItem() {
    document.querySelectorAll('#autocomplete-dropdown .ac-item').forEach((el, i) => {
        el.classList.toggle('active', i === acIndex);
    });
}

window.pickAutocomplete = function (i) {
    const item = acItems[i];
    if (!item) return;
    document.getElementById('dogu-search-input').value = item.displayName;
    hideAutocomplete();
    executeSearch();
};

async function fetchAutocomplete(value) {
    const namePart = value.split('#')[0].trim();
    if (inputWeight(namePart) < 4) { hideAutocomplete(); return; }

    const seq = ++acSeq;
    try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(namePart)}`);
        if (!res.ok) { hideAutocomplete(); return; }
        const list = await res.json();

        if (seq !== acSeq) return;                       // 늦게 도착한 응답 무시
        const now = document.getElementById('dogu-search-input').value.trim();
        if (now.split('#')[0].trim() !== namePart) return;

        renderAutocomplete(list, namePart);
    } catch (e) {
        hideAutocomplete();
    }
}

// 태그 후보 목록 페이지
async function showCandidates(name) {
    hideAllContainers();
    const box = document.getElementById('candidates-container');
    box.style.display = 'block';
    box.innerHTML = `<div class="cand-wrap"><div style="text-align:center; padding:80px 0; color:var(--text-muted);">검색 중입니다...</div></div>`;
    window.scrollTo(0, 0);

    let list = [];
    try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(name)}&exact=1`);
        if (res.ok) list = await res.json();
    } catch (e) { }

    if (!list || list.length === 0) {
        box.innerHTML = `
            <div class="cand-wrap">
                <div style="text-align:center; padding:70px 20px; color:var(--text-muted); line-height:1.9;">
                    <div style="font-size:18px; color:#fff; margin-bottom:12px;">'${escapeHtml(name)}' 님을 찾지 못했습니다.</div>
                    태그까지 함께 입력하면 정확하게 찾을 수 있습니다.<br>
                    <span style="font-size:13px; color:var(--text-faint);">예) ${escapeHtml(name)}#KR1</span>
                </div>
            </div>`;
        return;
    }

    const rows = list.map(it => {
        const [namePart, tag] = it.displayName.split('#');
        const t = String(it.tier || '').toUpperCase();
        const cls = TIER_SHORT[t] ? `t-${t.toLowerCase()}` : '';
        const lpText = fullTierText(it.tier, it.rank, it.lp) || (it.level ? `Level ${it.level}` : '');
        const safe = it.displayName.replace(/'/g, "\\'");

        return `
            <div class="cand-item" onclick="document.getElementById('dogu-search-input').value='${escapeHtml(safe)}'; executeSearch();">
                <span class="cand-badge ${cls}">${shortTier(it.tier, it.rank)}</span>
                <span class="cand-name">${escapeHtml(namePart)}<span class="ac-tag">#${escapeHtml(tag || '')}</span></span>
                <span class="cand-lp">${escapeHtml(lpText)}</span>
            </div>`;
    }).join('');

    box.innerHTML = `
        <div class="cand-wrap">
            <div class="cand-count"><b>${list.length}</b>개의 결과가 있습니다.</div>
            <div class="cand-list">${rows}</div>
        </div>`;
}

// 입력 이벤트 연결 (디바운스 0.2초)
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('dogu-search-input');
    if (!input) return;

    input.addEventListener('input', () => {
        const value = input.value.trim();
        if (acTimer) clearTimeout(acTimer);

        if (!value) { hideAutocomplete(); return; }
        acTimer = setTimeout(() => fetchAutocomplete(value), 200);
    });

    input.addEventListener('keydown', (e) => {
        const box = document.getElementById('autocomplete-dropdown');
        const open = box && box.style.display === 'block' && acItems.length > 0;

        if (e.key === 'Escape') { hideAutocomplete(); return; }
        if (!open) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            acIndex = (acIndex + 1) % acItems.length;
            highlightAcItem();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            acIndex = acIndex <= 0 ? acItems.length - 1 : acIndex - 1;
            highlightAcItem();
        } else if (e.key === 'Enter' && acIndex >= 0) {
            e.preventDefault();
            pickAutocomplete(acIndex);
        }
    });

    document.addEventListener('click', (e) => {
        const wrapper = document.querySelector('.dogu-search-wrapper');
        if (wrapper && !wrapper.contains(e.target)) hideAutocomplete();
    });
});

// ==========================================
// [10] 전적 더 보기
// ==========================================
window.matchOffset = 0;
let isLoadingMore = false;

function renderLoadMore(hasMore) {
    const area = document.getElementById('load-more-area');
    if (!area) return;

    if (!hasMore) {
        // 애초에 전적이 0개면 위쪽에 "전적 데이터가 없습니다"가 이미 떠 있다.
        // "더 이상"은 뭔가 불러온 뒤에나 맞는 말이라 이때는 아무것도 그리지 않는다.
        const hasAnyMatch = document.querySelector('.match-wrapper');
        area.innerHTML = hasAnyMatch
            ? `<div class="load-more-end">더 이상 불러올 전적이 없습니다.</div>`
            : '';
        return;
    }
    area.innerHTML = `<button class="load-more-btn" id="load-more-btn" onclick="loadMoreMatches()">+ 10게임 더 보기</button>`;
}

window.loadMoreMatches = async function () {
    if (isLoadingMore) return;

    const puuid = window.currentPuuid;
    if (!puuid) return;

    const btn = document.getElementById('load-more-btn');
    isLoadingMore = true;
    if (btn) { btn.disabled = true; btn.textContent = "불러오는 중..."; }

    try {
        const res = await fetch(`/api/matches/${puuid}?start=${window.matchOffset}&count=10`);

        if (res.status === 429) {
            showErrorToast("서버 요청이 많아 지연되고 있습니다.\n잠시 후 다시 시도해주세요.");
            if (btn) { btn.disabled = false; btn.textContent = "+ 10게임 더 보기"; }
            return;
        }
        if (!res.ok) throw new Error("불러오기 실패");

        const data = await res.json();
        const newMatches = data.history || [];

        if (newMatches.length === 0) {
            renderLoadMore(false);
            return;
        }

        // 챔피언 스킬 정보 미리 확보 (스킬 빌드 표에 필요)
        window.champDetailCache = window.champDetailCache || {};
        const uniqueChamps = [...new Set(newMatches.map(m => m.championName))];
        await Promise.all(uniqueChamps.map(async champName => {
            if (window.champDetailCache[champName]) return;
            try {
                const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion/${champName}.json`);
                const d = await r.json();
                window.champDetailCache[champName] = d.data[champName].spells.map(sp => ({ img: sp.image.full, max: sp.maxrank }));
            } catch (e) { }
        }));

        allMatches = allMatches.concat(newMatches);
        window.matchOffset += newMatches.length;

        renderMatches(newMatches, true);
        renderLoadMore(data.hasMore !== false);

        // 새로 추가된 항목에도 현재 필터(큐 + 챔피언)를 그대로 적용
        applyMatchFilters();

    } catch (e) {
        console.error("더 보기 실패:", e);
        showErrorToast("전적을 더 불러오지 못했습니다.\n잠시 후 다시 시도해주세요.");
        if (btn) { btn.disabled = false; btn.textContent = "+ 10게임 더 보기"; }
    } finally {
        isLoadingMore = false;
    }
};

// ==========================================
// [11] 경기 링크 (/summoner/<라이엇 ID>/<경기 번호>)
// ==========================================

// 주소로 받은 경기 하나를 펼쳐서 보여준다.
//   ★ 검색은 최근 20판만 받아오므로 그보다 오래된 경기는 "더 보기"를 눌러 가며 찾는다.
//     3번(=30판 추가, 총 50판)까지만 시도한다 — 그 이상은 라이엇 호출만 늘어난다.
//   ★ pendingMatchId 를 맨 앞에서 비운다. 안 비우면 전적 갱신 때마다 다시 펼쳐진다.
async function openPendingMatch() {
    const matchId = window.pendingMatchId;
    if (!matchId) return;
    window.pendingMatchId = null;

    const findWrapper = () => [...document.querySelectorAll('.match-wrapper')]
        .find(w => w.dataset.matchId === matchId);

    for (let tries = 0; ; tries++) {
        const wrapper = findWrapper();
        if (wrapper) {
            // 토글 버튼과 같은 순서로 연다 — 첫 탭을 눌러야 상세가 만들어진다
            if (!wrapper.classList.contains('open')) {
                const firstTab = wrapper.querySelector('.detail-tab-btn');
                if (firstTab) firstTab.click();
                wrapper.classList.add('open');
            }
            wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        // 더 받을 게 없으면(버튼이 사라졌으면) 그만둔다
        if (tries >= 3 || !document.getElementById('load-more-btn')) break;
        await loadMoreMatches();
    }

    showErrorToast("링크에 담긴 경기를 찾지 못했습니다.\n너무 오래된 전적일 수 있습니다.");
}

// 경기 주소를 클립보드에 넣는다.
//   ★ navigator.clipboard 는 HTTPS(또는 localhost)에서만 된다. 안 되는 환경을 위해
//     textarea + execCommand 폴백을 둔다.
//   ★ 이름은 라이엇이 준 정본(currentProfileName, "이름#태그")을 쓴다. 검색창에 친
//     글자를 쓰면 대소문자가 제각각인 주소가 돌아다니게 된다.
window.copyMatchLink = async function (e, btn, matchId) {
    e.stopPropagation();   // 이 버튼은 토글 버튼 위에 겹쳐 있다. 안 막으면 상세까지 열린다

    const name = currentProfileName || decodeURIComponent(window.location.pathname.split('/')[2] || '');
    if (!name) return;
    const url = `${window.location.origin}/summoner/${encodeURIComponent(name)}/${matchId}`;

    let ok = true;
    try {
        await navigator.clipboard.writeText(url);
    } catch (err) {
        try {
            const ta = document.createElement('textarea');
            ta.value = url;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand('copy');
            ta.remove();
        } catch (e2) {
            ok = false;
        }
    }

    btn.classList.add(ok ? 'copied' : 'copy-failed');
    setTimeout(() => btn.classList.remove('copied', 'copy-failed'), 1600);
};

// ============================================================
// 로딩 스켈레톤 (2026-08-31, 260830 디자인 7번)
// "…불러오는 중" 한 줄 대신 올 내용의 모양을 그린다. 모양 CSS 는 style.css 의 .skel* 절.
// 함수 선언이라 파일 끝에 있어도 호이스팅으로 어디서든 불린다.
// ============================================================

// 표 뼈대 — 랭킹·통계처럼 [아이콘·이름 ……… 숫자 셋] 줄이 이어지는 자리
function skelTableHtml(rows = 12, rowH = 36) {
    let r = '';
    for (let i = 0; i < rows; i++) {
        r += `<div class="skel-row" style="height:${rowH}px">
            <div class="skel skel-ico"></div>
            <div class="skel" style="width:${130 + (i * 37) % 90}px"></div>
            <div class="skel" style="width:56px;margin-left:auto"></div>
            <div class="skel" style="width:56px"></div>
            <div class="skel" style="width:56px"></div>
        </div>`;
    }
    return `<div class="skel-box">${r}</div>`;
}

// 전적검색 뼈대 — 프로필 카드 + 요약 상자 + 경기 카드들
function skelSummonerHtml() {
    const cards = Array.from({ length: 5 }, () =>
        `<div class="skel" style="height:96px;border-radius:12px;margin-bottom:10px"></div>`).join('');
    return `<div style="min-height:100vh">
        <div class="skel" style="height:150px;border-radius:12px;margin-bottom:20px"></div>
        <div class="skel" style="height:180px;border-radius:12px;margin-bottom:20px"></div>
        ${cards}
    </div>`;
}

// 도감 뼈대 — 탭 칩 줄 + [목록 | 상세] 두 상자
function skelCodexHtml() {
    const chips = Array.from({ length: 4 }, () =>
        `<div class="skel" style="width:92px;height:36px;border-radius:8px"></div>`).join('');
    return `<div style="display:flex;gap:10px;margin-bottom:14px">${chips}</div>
        <div class="skel-split" style="height:62vh">
            <div class="skel" style="flex:0 0 56%;border-radius:12px"></div>
            <div class="skel" style="flex:1;border-radius:12px"></div>
        </div>`;
}

// 챔피언 페이지 뼈대 — 탭 칩 줄 + [왼쪽 목록 | 오른쪽 상세]
function skelChampHtml() {
    const chips = Array.from({ length: 4 }, () =>
        `<div class="skel" style="width:92px;height:36px;border-radius:8px"></div>`).join('');
    return `<div style="display:flex;gap:10px;margin-bottom:14px">${chips}</div>
        <div class="skel-split" style="height:70vh">
            <div class="skel" style="flex:0 0 250px;border-radius:12px"></div>
            <div class="skel" style="flex:1;border-radius:12px"></div>
        </div>`;
}

// 통계 탭 뼈대 — ★ 제목 줄은 진짜로 그린다 (2026-08-31 지적: 제목까지 뭉개졌다가 바뀌면 어색하다.
//   랭킹은 머리가 바로 뜨고 표만 뼈대라 자연스러웠다 — 그 모양에 맞춘 것). 부제·드롭다운 자리만 뼈대.
function skelStatsPageHtml() {
    return `
        <div class="stats-header">
            <h1 class="ranking-title">챔피언 통계</h1>
            <p class="stats-sub"><span class="skel" style="display:inline-block;width:220px;height:13px;vertical-align:middle"></span></p>
        </div>
        <div class="stats-controls"><div class="skel" style="width:140px;height:38px;border-radius:8px;margin:0 auto"></div></div>
        <div style="min-height:100vh">${skelTableHtml(12, 48)}</div>`;
}

// 통계 상세(빌드 페이지) 뼈대 — 툴바 + 카드 두 열. 툴바가 이미 그려진 자리(lx-body)는 withBar=false
function skelLxHtml(withBar = true) {
    return `${withBar ? '<div class="skel" style="height:64px;border-radius:12px;margin-bottom:14px"></div>' : ''}
        <div class="skel-split">
            <div class="skel-col">
                <div class="skel" style="height:260px;border-radius:12px"></div>
                <div class="skel" style="height:200px;border-radius:12px"></div>
            </div>
            <div class="skel-col">
                <div class="skel" style="height:150px;border-radius:12px"></div>
                <div class="skel" style="height:310px;border-radius:12px"></div>
            </div>
        </div>`;
}
