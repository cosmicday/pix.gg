require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const NodeCache = require('node-cache');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// [초기 설정] 메모리 캐시 설정 (TTL: 300초)
const myCache = new NodeCache({ stdTTL: 300 }); 
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.API_KEY;
let currentVersion = "14.4.1"; // Data Dragon API 통신 실패 시 사용할 기본 버전

// ==========================================
// 1. Data Dragon 버전 관리 로직
// ==========================================
async function updateVersion() {
    try {
        const res = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json');
        currentVersion = res.data[0];
        console.log(`[System] Data Dragon 최신 버전 로드 완료: ${currentVersion}`);
    } catch (e) {
        console.error("[System] 버전 정보 갱신 실패. 기본 버전을 사용합니다.");
    }
}
updateVersion();

// ==========================================
// 2. 전적 검색 API (/api/summoner/:name)
// ==========================================
app.get('/api/summoner/:name', async (req, res) => {
    const summonerName = req.params.name;

    // 2-1. 캐시 데이터 확인
    const cachedData = myCache.get(summonerName);
    if (cachedData) {
        console.log(`[API] 전적 검색 캐시 적중: ${summonerName}`);
        cachedData.expireAt = myCache.getTtl(summonerName);
        return res.json(cachedData);
    }

    try {
        // 2-2. 파라미터 검증 (GameName#TagLine)
        const [gameName, tagLine] = summonerName.split('#');
        if (!gameName || !tagLine) {
            return res.status(400).json({ error: "닉네임#태그 형식으로 입력해주세요." });
        }

        // 2-3. Account-V1 (Riot ID를 통해 PUUID 획득)
        const accountUrl = `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}?api_key=${API_KEY}`;
        const { data: accountData } = await axios.get(accountUrl);
        const targetPuuid = accountData.puuid;

        // 2-4. Summoner-V4 & League-V4 (프로필 및 랭크 정보 동시 조회)
        const summonerUrl = `https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${targetPuuid}?api_key=${API_KEY}`;
        const leagueUrl = `https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${targetPuuid}?api_key=${API_KEY}`;
        
        const [summonerRes, leagueRes] = await Promise.all([
            axios.get(summonerUrl),
            axios.get(leagueUrl)
        ]);
        
        const realLevel = summonerRes.data.summonerLevel;
        const realIconId = summonerRes.data.profileIconId;
        const rankData = leagueRes.data.find(entry => entry.queueType === 'RANKED_SOLO_5x5') || null;

        // ==========================================
        // [신규 기능 1] DB에 오늘의 티어/LP 기록 저장 및 과거 기록 조회 (그래프용)
        // ==========================================
        let historyRecords = [];
        if (db) {
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD 형식
            if (rankData) {
                await db.run(
                    `INSERT INTO lp_history (puuid, date, tier, rank, lp) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(puuid, date) DO UPDATE SET tier=excluded.tier, rank=excluded.rank, lp=excluded.lp`,
                    [targetPuuid, today, rankData.tier, rankData.rank, rankData.leaguePoints]
                );
            }
            // 유저의 과거 LP 기록 모두 불러오기
            historyRecords = await db.all(
                `SELECT date, tier, rank, lp FROM lp_history WHERE puuid = ? ORDER BY date ASC`,
                [targetPuuid]
            );
        }
        // ==========================================

        // 2-5. Match-V5 (최근 10게임 Match ID 조회)
        const matchUrl = `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${targetPuuid}/ids?start=0&count=10&api_key=${API_KEY}`;
        const { data: matchIds } = await axios.get(matchUrl);

        // 2-6. Match-Detail (각 게임의 상세 데이터 가공)
        const history = await Promise.all(matchIds.map(async (matchId) => {
            try {
                const detailUrl = `https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${API_KEY}`;
                const { data: detail } = await axios.get(detailUrl);
                const p = detail.info.participants.find(participant => participant.puuid === targetPuuid);

                if (!p) return null;

                // 큐 타입 분류
                let queueType = "일반";
                if (detail.info.queueId === 420) queueType = "솔로랭크";
                else if (detail.info.queueId === 440) queueType = "자유랭크";
                else if (detail.info.queueId === 450) queueType = "칼바람";
                else if (detail.info.queueId === 1700) queueType = "아레나";

                // KDA 및 킬 관여율(KP) 계산
                const kdaCalc = p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(2);
                const teamKills = detail.info.participants
                    .filter(x => x.teamId === p.teamId)
                    .reduce((sum, x) => sum + x.kills, 0);
                const kp = teamKills === 0 ? 0 : Math.round(((p.kills + p.assists) / teamKills) * 100);

                // 참가자 명단 추출
                const blueTeam = detail.info.participants.filter(x => x.teamId === 100).map(x => x.championName);
                const redTeam = detail.info.participants.filter(x => x.teamId === 200).map(x => x.championName);

                // 시간 및 날짜 포맷팅
                const durationMin = Math.floor(detail.info.gameDuration / 60);
                const durationSec = detail.info.gameDuration % 60;
                const timeDiff = Date.now() - detail.info.gameEndTimestamp;
                const daysAgo = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
                let dateStr = daysAgo === 0 ? "오늘" : (daysAgo > 30 ? "1개월 전" : `${daysAgo}일 전`);

                // CS 및 기타 통계 계산
                const totalCs = p.totalMinionsKilled + p.neutralMinionsKilled;
                const csPerMin = (totalCs / (detail.info.gameDuration / 60)).toFixed(1);

                // 연속 킬 뱃지
                let multiKill = "";
                if (p.pentaKills > 0) multiKill = "펜타킬";
                else if (p.quadraKills > 0) multiKill = "쿼드라킬";
                else if (p.tripleKills > 0) multiKill = "트리플킬";
                else if (p.doubleKills > 0) multiKill = "더블킬";

                // ========================================================
                // [신규 기능 2] 10명 플레이어의 전체 상세 데이터를 프론트엔드로 전달
                // ========================================================
                const detailedParticipants = detail.info.participants.map(part => {
                    let pChampName = part.championName;
                    if (pChampName === "FiddleSticks") pChampName = "Fiddlesticks"; // 이미지 엑박 방지 처리

                    return {
                        puuid: part.puuid,
                        isSearchedUser: part.puuid === targetPuuid,
                        teamId: part.teamId,
                        win: part.win,
                        championName: pChampName,
                        summonerName: part.riotIdGameName ? `${part.riotIdGameName}#${part.riotIdTagLine}` : (part.summonerName || "알 수 없음"),
                        kills: part.kills, deaths: part.deaths, assists: part.assists,
                        damage: part.totalDamageDealtToChampions,
                        gold: part.goldEarned,
                        cs: part.totalMinionsKilled + part.neutralMinionsKilled,
                        wardsPlaced: part.wardsPlaced || 0,
                        wardsKilled: part.wardsKilled || 0,
                        visionWards: part.visionWardsBoughtInGame || 0,
                        item0: part.item0, item1: part.item1, item2: part.item2, item3: part.item3, item4: part.item4, item5: part.item5, item6: part.item6,
                        spell1: part.summoner1Id, spell2: part.summoner2Id,
                        mainRune: part.perks.styles[0]?.style, subRune: part.perks.styles[1]?.style,
                        champLevel: part.champLevel
                    };
                });
                // ========================================================

                return {
                    queueType, win: p.win, 
                    championName: p.championName, champLevel: p.champLevel,
                    kills: p.kills, deaths: p.deaths, assists: p.assists, kda: kdaCalc, kp,
                    spell1: p.summoner1Id, spell2: p.summoner2Id,
                    mainRune: p.perks.styles[0]?.style, subRune: p.perks.styles[1]?.style,
                    item0: p.item0, item1: p.item1, item2: p.item2, item3: p.item3, item4: p.item4, item5: p.item5, item6: p.item6,
                    totalCs, csPerMin, goldEarned: p.goldEarned, visionScore: p.visionScore, controlWards: p.visionWardsBoughtInGame,
                    multiKill, firstBlood: p.firstBloodKill,
                    durationMin, durationSec, dateStr,
                    timestamp: detail.info.gameEndTimestamp, 
                    blueTeam, redTeam,
                    participants: detailedParticipants // [추가됨] 10인 데이터 탑재
                };
            } catch (err) {
                return null;
            }
        }));

        // 2-7. 데이터 정제 및 최종 응답 객체 생성
        const cleanHistory = history.filter(Boolean);

        const finalData = {
            version: currentVersion,
            profile: {
                name: `${gameName}#${tagLine}`,
                level: realLevel,
                icon: `https://ddragon.leagueoflegends.com/cdn/${currentVersion}/img/profileicon/${realIconId}.png`,
                tier: rankData ? rankData.tier : 'UNRANKED',
                rank: rankData ? rankData.rank : '',
                leaguePoints: rankData ? rankData.leaguePoints : 0
            },
            history: cleanHistory,
            lpHistory: historyRecords // [추가됨] 프론트엔드로 전달할 그래프 데이터
        };

        // 2-8. 결과 캐싱 및 응답
        myCache.set(summonerName, finalData);
        finalData.expireAt = myCache.getTtl(summonerName);
        console.log(`[API] 전적 데이터 로드 완료: ${summonerName}`);
        res.json(finalData);

    } catch (error) {
        if (error.response) {
            console.error(`[Error] API 통신 오류: ${error.config.url} (Status: ${error.response.status})`);
            if (error.response.status === 404) {
                return res.status(404).json({ error: "소환사를 찾을 수 없습니다. 닉네임을 다시 확인해주세요." });
            }
        } else {
            console.error("[Error] 서버 내부 오류:", error.message);
        }
        res.status(500).json({ error: "데이터 처리 중 문제가 발생했습니다." });
    }
});


// ==========================================
// 3. 백그라운드 스케줄러 및 DB 로직 (랭킹 데이터용)
// ==========================================
let db;
let challengerList = []; 
let resolvedNames = {};  
let isFetchingNames = false; 

// 3-1. SQLite DB 초기화
async function initDB() {
    db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS summoners (
            puuid TEXT PRIMARY KEY,
            displayName TEXT,
            updatedAt INTEGER
        )
    `);

    // [신규 기능 1] 날짜별 LP 기록용 테이블 생성
    await db.exec(`
        CREATE TABLE IF NOT EXISTS lp_history (
            puuid TEXT,
            date TEXT,
            tier TEXT,
            rank TEXT,
            lp INTEGER,
            PRIMARY KEY (puuid, date)
        )
    `);
    
    const rows = await db.all('SELECT * FROM summoners');
    rows.forEach(row => {
        resolvedNames[row.puuid] = {
            displayName: row.displayName,
            updatedAt: row.updatedAt
        };
    });
    console.log(`[System] DB 연동 완료: 기존 저장된 유저 데이터 ${rows.length}건 로드`);
}
initDB();

// 3-2. 챌린저 티어 명단(300명) 조회
async function updateChallengerList() {
    try {
        const url = `https://kr.api.riotgames.com/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5?api_key=${API_KEY}`;
        const res = await axios.get(url);
        if (res.data && res.data.entries) {
            challengerList = res.data.entries.sort((a, b) => b.leaguePoints - a.leaguePoints);
            console.log("[Task] 챌린저 명단 갱신 완료");
        }
    } catch (err) {
        console.error("[Task Error] 챌린저 명단 로드 실패:", err.message);
    }
}

// 3-3. PUUID를 Riot ID(GameName#TagLine)로 변환하여 DB에 저장 (Rate Limit 방지용)
async function resolveNamesInBackground() {
    if (challengerList.length === 0 || isFetchingNames) return;
    isFetchingNames = true;

    const now = Date.now();
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

    // 미수집 상태이거나 업데이트 후 3일이 경과한 데이터만 필터링 (최대 30건)
    const targets = challengerList.filter(p => {
        const saved = resolvedNames[p.puuid];
        if (!saved) return true; 
        if (now - saved.updatedAt > THREE_DAYS) return true; 
        return false;
    }).slice(0, 30);

    if (targets.length > 0) {
        console.log(`[Task] 백그라운드 닉네임 변환 작업 시작 (${targets.length}건 진행)`);
        
        for (const p of targets) {
            try {
                const accRes = await axios.get(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-puuid/${p.puuid}?api_key=${API_KEY}`);
                
                if (accRes.data.gameName) {
                    const dName = `${accRes.data.gameName}#${accRes.data.tagLine}`;
                    const updateTime = Date.now();
                    
                    // 메모리 및 DB 업데이트
                    resolvedNames[p.puuid] = { displayName: dName, updatedAt: updateTime };
                    await db.run(
                        `INSERT INTO summoners (puuid, displayName, updatedAt) VALUES (?, ?, ?)
                         ON CONFLICT(puuid) DO UPDATE SET displayName=excluded.displayName, updatedAt=excluded.updatedAt`,
                        [p.puuid, dName, updateTime]
                    );
                }
            } catch (err) {
                // Rate Limit 등 통신 오류 발생 시 해당 항목 스킵
            }
            // API 호출 제한(Rate Limit) 준수를 위한 지연 (1.2초)
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
        console.log("[Task] 백그라운드 닉네임 변환 작업 1사이클 완료");
    }
    isFetchingNames = false;
}

// 3-4. 서버 시작 시 초기 작업 및 스케줄러 등록
async function startJobs() {
    await updateChallengerList(); 
    await resolveNamesInBackground(); 
    
    // 주기적 실행: 명단 갱신(10분), 닉네임 변환(2분)
    setInterval(updateChallengerList, 600 * 1000); 
    setInterval(resolveNamesInBackground, 120 * 1000);
}
startJobs();


// ==========================================
// 4. 랭킹 조회 API (/api/ranking)
// ==========================================
app.get('/api/ranking', async (req, res) => {
    const RANK_CACHE_KEY = 'challenger_ranking_data';

    const cachedRanking = myCache.get(RANK_CACHE_KEY);
    if (cachedRanking) {
        return res.json(cachedRanking);
    }

    if (challengerList.length === 0) {
        return res.status(503).json({ error: "랭킹 데이터를 수집 중입니다. 잠시 후 다시 시도해주세요." });
    }

    // 데이터 매핑: 수집된 닉네임이 없을 경우 임시 ID 부여
    const processedPlayers = challengerList.map(p => {
        const saved = resolvedNames[p.puuid];
        const dName = saved ? saved.displayName : `User-${String(p.puuid).substring(0, 8)}`;
        
        return {
            displayName: dName,
            leaguePoints: p.leaguePoints || 0,
            wins: p.wins || 0,
            losses: p.losses || 0
        };
    });

    const finalRankingData = {
        tier: "CHALLENGER",
        players: processedPlayers
    };

    myCache.set(RANK_CACHE_KEY, finalRankingData, 600);
    res.json(finalRankingData);
});

// ==========================================
// [신규] 통계 데이터 로컬 제공 API (/api/champion-stats)
// ==========================================
app.get('/api/champion-stats', (req, res) => {
    try {
        // 방금 만든 stats_data.json 파일을 불러와서 제공합니다.
        const statsData = require('./stats_data.json');
        res.json(statsData);
    } catch (error) {
        console.error('[Error] 로컬 통계 데이터 파일을 찾을 수 없거나 읽기 실패:', error.message);
        res.status(500).json({ error: "통계 데이터를 불러오지 못했습니다. stats_data.json 파일을 확인해주세요." });
    }
});

// ==========================================
// 5. 프론트엔드 라우팅 (SPA 지원용)
// ==========================================
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 서버 구동
app.listen(3000, () => console.log('[System] 서버 실행 중: http://localhost:3000'));