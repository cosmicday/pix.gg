require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const NodeCache = require('node-cache');
const mongoose = require('mongoose');

// ==========================================
// [1] 초기 설정 및 전역 변수
// ==========================================
const app = express();
const myCache = new NodeCache({ stdTTL: 300 }); 
const API_KEY = process.env.API_KEY;

let currentVersion = "14.4.1"; 
let challengerList = []; 
let resolvedNames = {};  
let isFetchingNames = false; 

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// [2] MongoDB 연결 및 스키마 정의
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB 연결 성공!'))
    .catch((err) => console.error('❌ MongoDB 연결 실패:', err));

// 매치 캐싱용 (전적 20게임 상세 정보)
const matchSchema = new mongoose.Schema({
    matchId: { type: String, required: true, unique: true }, 
    detail: { type: Object, required: true }, 
    timeline: { type: Object }
});
const MatchCache = mongoose.model('MatchCache', matchSchema);

// 소환사 닉네임 캐싱용 (챌린저 랭킹 속도 향상)
const summonerSchema = new mongoose.Schema({
    puuid: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    updatedAt: { type: Number, required: true }
});
const SummonerCache = mongoose.model('SummonerCache', summonerSchema);

// ==========================================
// [3] 백그라운드 스케줄러 (캐시 갱신 및 랭킹 관리)
// ==========================================

// 3-1. 서버 시작 시 MongoDB에서 닉네임/전적 메타데이터 로드
async function loadResolvedNames() {
    try {
        const summoners = await SummonerCache.find({});
        summoners.forEach(s => resolvedNames[s.puuid] = { displayName: s.displayName, updatedAt: s.updatedAt });
        
        console.log(`[System] MongoDB 닉네임 연동 완료: ${summoners.length}명 로드`);
        console.log(`[System] MongoDB 전적 연동 완료: ${await MatchCache.countDocuments()}게임 로드`);
    } catch (err) {
        console.error("[System] MongoDB 초기 데이터 로드 실패:", err.message);
    }
}

// 3-2. 최신 Data Dragon 버전 갱신
async function updateVersion() {
    try {
        const res = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json');
        currentVersion = res.data[0];
        console.log(`[System] Data Dragon 최신 버전 로드 완료: ${currentVersion}`);
    } catch (e) {
        console.error("[System] 버전 갱신 실패. 기본 버전을 사용합니다.");
    }
}

// 3-3. 상위 1500명 명단 조회 (챌린저/그랜드마스터/마스터)
async function updateChallengerList() {
    try {
        const [challengerRes, gmRes, masterRes] = await Promise.all([
            axios.get(`https://kr.api.riotgames.com/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5?api_key=${API_KEY}`),
            axios.get(`https://kr.api.riotgames.com/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5?api_key=${API_KEY}`),
            axios.get(`https://kr.api.riotgames.com/lol/league/v4/masterleagues/by-queue/RANKED_SOLO_5x5?api_key=${API_KEY}`)
        ]).catch(e => {
            console.error("[Task Error] 일부 랭킹 API 호출 실패:", e.message);
            return [null, null, null];
        });

        let combinedEntries = [];
        if (challengerRes?.data?.entries) combinedEntries.push(...challengerRes.data.entries);
        if (gmRes?.data?.entries) combinedEntries.push(...gmRes.data.entries);
        if (masterRes?.data?.entries) combinedEntries.push(...masterRes.data.entries);

        if (combinedEntries.length > 0) {
            // LP 내림차순 정렬 후 1500명 컷
            challengerList = combinedEntries.sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, 1500);
            console.log(`[Task] 랭킹 명단 갱신 완료 (총 ${challengerList.length}명)`);
        }
    } catch (err) {
        console.error("[Task Error] 랭킹 명단 로드 실패:", err.message);
    }
}

// 3-4. 닉네임 변환 (10명씩 백그라운드 갱신)
async function resolveNamesInBackground() {
    if (challengerList.length === 0 || isFetchingNames) return;
    isFetchingNames = true;

    const now = Date.now();
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

    // 업데이트가 필요하거나 캐시에 없는 타겟 10명 추출
    const targets = challengerList.filter(p => {
        const saved = resolvedNames[p.puuid];
        return !saved || (now - saved.updatedAt > THREE_DAYS);
    }).slice(0, 10);

    if (targets.length > 0) {
        console.log(`[Task] 백그라운드 닉네임 변환 시작 (${targets.length}건 진행)`);
        for (const p of targets) {
            try {
                const accRes = await axios.get(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-puuid/${p.puuid}?api_key=${API_KEY}`);
                if (accRes.data.gameName) {
                    const dName = `${accRes.data.gameName}#${accRes.data.tagLine}`;
                    const updateTime = Date.now();
                    
                    resolvedNames[p.puuid] = { displayName: dName, updatedAt: updateTime };
                    
                    await SummonerCache.findOneAndUpdate(
                        { puuid: p.puuid },
                        { displayName: dName, updatedAt: updateTime },
                        { upsert: true }
                    );

                    myCache.del('challenger_ranking_data');
                }
            } catch (err) { /* Rate Limit 무시 */ }
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
        console.log("[Task] 백그라운드 닉네임 변환 완료");
    }
    isFetchingNames = false;
}

// 스케줄러 실행
async function startJobs() {
    await loadResolvedNames(); 
    await updateVersion();
    await updateChallengerList(); 
    await resolveNamesInBackground(); 
    
    setInterval(updateChallengerList, 600 * 1000); 
    setInterval(resolveNamesInBackground, 60 * 1000);
}
startJobs();

// ==========================================
// [4] API 라우터
// ==========================================

// 4-1. 전적 검색 (핵심 API)
app.get('/api/summoner/:name', async (req, res) => {
    const summonerName = req.params.name;
    const cachedData = myCache.get(summonerName);

    if (cachedData) {
        console.log(`[API] 전적 검색 메모리 캐시 적중: ${summonerName}`);
        cachedData.expireAt = myCache.getTtl(summonerName);
        return res.json(cachedData);
    }

    try {
        const [gameName, tagLine] = summonerName.split('#');
        if (!gameName || !tagLine) return res.status(400).json({ error: "닉네임#태그 형식으로 입력해주세요." });

        // 계정 정보 및 소환사 정보 호출
        const accountUrl = `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}?api_key=${API_KEY}`;
        const { data: accountData } = await axios.get(accountUrl);
        const targetPuuid = accountData.puuid;

        const [summonerRes, leagueRes, matchIdsRes] = await Promise.all([
            axios.get(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${targetPuuid}?api_key=${API_KEY}`),
            axios.get(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${targetPuuid}?api_key=${API_KEY}`),
            axios.get(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${targetPuuid}/ids?start=0&count=30&api_key=${API_KEY}`)
        ]);
        
        const realLevel = summonerRes.data.summonerLevel;
        const realIconId = summonerRes.data.profileIconId;
        const rankData = leagueRes.data.find(entry => entry.queueType === 'RANKED_SOLO_5x5') || null;
        const matchIds = matchIdsRes.data;

        // DB 캐싱 매치 확인
        const cachedMatches = await MatchCache.find({ matchId: { $in: matchIds } });
        const cachedMatchIds = cachedMatches.map(m => m.matchId);
        const matchesToFetch = matchIds.filter(id => !cachedMatchIds.includes(id));
        
        console.log(`[DB Cache] ${summonerName}: 30게임 중 DB에서 ${cachedMatchIds.length}게임 로드, 신규 ${matchesToFetch.length}게임 요청`);

        // 신규 매치 데이터 호출 및 DB 저장
        const newMatchesData = await Promise.all(matchesToFetch.map(async (matchId, index) => {
            try {
                await new Promise(r => setTimeout(r, index * 150));
                const [detailRes, timelineRes] = await Promise.all([
                    axios.get(`https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${API_KEY}`),
                    axios.get(`https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline?api_key=${API_KEY}`).catch(() => ({ data: null }))
                ]);
                
                MatchCache.create({ matchId, detail: detailRes.data, timeline: timelineRes.data }).catch(e => console.error("DB 저장 에러:", e.message));
                return { detail: detailRes.data, timeline: timelineRes.data };
            } catch (err) {
                return null;
            }
        }));

        // 모든 매치 통합 및 정렬
        let allMatchDetails = [...cachedMatches.map(m => ({ detail: m.detail, timeline: m.timeline })), ...newMatchesData].filter(m => m?.detail);
        allMatchDetails.sort((a, b) => b.detail.info.gameEndTimestamp - a.detail.info.gameEndTimestamp);

        // 클라이언트 전송용 데이터 정제
        const history = allMatchDetails.map(({ detail, timeline }) => {
            const p = detail.info.participants.find(part => part.puuid === targetPuuid);
            if (!p) return null;

            // 큐 타입 매핑
            const queueMap = { 420: "솔로랭크", 440: "자유랭크", 450: "칼바람", 1700: "아레나" };
            const queueType = queueMap[detail.info.queueId] || "일반";

            // 시간 및 스탯 계산
            const durationMin = Math.floor(detail.info.gameDuration / 60);
            const durationSec = detail.info.gameDuration % 60;
            const daysAgo = Math.floor((Date.now() - detail.info.gameEndTimestamp) / (1000 * 60 * 60 * 24));
            const dateStr = daysAgo === 0 ? "오늘" : (daysAgo > 30 ? "1개월 전" : `${daysAgo}일 전`);
            
            const kdaCalc = p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(2);
            const teamKills = detail.info.participants.filter(x => x.teamId === p.teamId).reduce((sum, x) => sum + x.kills, 0);
            const kp = teamKills === 0 ? 0 : Math.round(((p.kills + p.assists) / teamKills) * 100);
            const totalCs = p.totalMinionsKilled + p.neutralMinionsKilled;
            const csPerMin = durationMin > 0 ? (totalCs / durationMin).toFixed(1) : "0.0";

            let multiKill = p.pentaKills ? "펜타킬" : (p.quadraKills ? "쿼드라킬" : (p.tripleKills ? "트리플킬" : (p.doubleKills ? "더블킬" : "")));

            const team100Kills = detail.info.participants.filter(x => x.teamId === 100).reduce((sum, x) => sum + x.kills, 0);
            const team200Kills = detail.info.participants.filter(x => x.teamId === 200).reduce((sum, x) => sum + x.kills, 0);

            // 참여자 10명 세부 정보
            const detailedParticipants = detail.info.participants.map(part => {
                const pTeamKills = part.teamId === 100 ? team100Kills : team200Kills;
                return {
                    puuid: part.puuid, isSearchedUser: part.puuid === targetPuuid, teamId: part.teamId, win: part.win, champLevel: part.champLevel, 
                    championName: part.championName === "FiddleSticks" ? "Fiddlesticks" : part.championName, visionScore: part.visionScore,
                    summonerName: part.riotIdGameName ? `${part.riotIdGameName}#${part.riotIdTagline}` : (part.summonerName || "알 수 없음"),
                    kills: part.kills, deaths: part.deaths, assists: part.assists, damage: part.totalDamageDealtToChampions, damageTaken: part.totalDamageTaken, 
                    kp: pTeamKills === 0 ? 0 : Math.round(((part.kills + part.assists) / pTeamKills) * 100), gold: part.goldEarned,
                    cs: part.totalMinionsKilled + part.neutralMinionsKilled, wardsPlaced: part.wardsPlaced || 0, wardsKilled: part.wardsKilled || 0, visionWards: part.visionWardsBoughtInGame || 0,
                    item0: part.item0, item1: part.item1, item2: part.item2, item3: part.item3, item4: part.item4, item5: part.item5, item6: part.item6, 
                    item7: (part.roleBoundItem || part.item7 || part.playerAugment1 || 0), spell1: part.summoner1Id, spell2: part.summoner2Id,
                    mainRune: part.perks?.styles?.[0]?.style || null, subRune: part.perks?.styles?.[1]?.style || null
                };
            });

            // 룬 및 타임라인 데이터
            const myRunes = p.perks?.styles ? {
                primaryStyle: p.perks.styles[0].style, primarySelections: p.perks.styles[0].selections.map(s => s.perk),
                subStyle: p.perks.styles[1].style, subSelections: p.perks.styles[1].selections.map(s => s.perk),
                statPerks: p.perks.statPerks ? [p.perks.statPerks.offense, p.perks.statPerks.flex, p.perks.statPerks.defense] : []
            } : null;

            let myTimeline = { skills: [], items: [] };
            let goldFrames = null;
            
            if (timeline?.info?.frames) {
                goldFrames = { labels: [], blue: [], red: [] };
                timeline.info.frames.forEach((frame, idx) => {
                    goldFrames.labels.push(`${idx}분`);
                    let blueGold = 0, redGold = 0;
                    if (frame.participantFrames) {
                        for(let i=1; i<=5; i++) blueGold += frame.participantFrames[i]?.totalGold || 0;
                        for(let i=6; i<=10; i++) redGold += frame.participantFrames[i]?.totalGold || 0;
                    }
                    goldFrames.blue.push(blueGold);
                    goldFrames.red.push(redGold);

                    if (frame.events) {
                        frame.events.forEach(event => {
                            if (event.participantId === p.participantId) {
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
            }

            return {
                matchId: detail.metadata.matchId, queueType, win: p.win, championName: p.championName === "FiddleSticks" ? "Fiddlesticks" : p.championName, champLevel: p.champLevel, 
                kills: p.kills, deaths: p.deaths, assists: p.assists, kda: kdaCalc, kp, spell1: p.summoner1Id, spell2: p.summoner2Id,
                mainRune: myRunes?.primaryStyle, subRune: myRunes?.subStyle, item0: p.item0, item1: p.item1, item2: p.item2, item3: p.item3, item4: p.item4, item5: p.item5, item6: p.item6, 
                item7: (p.roleBoundItem || p.item7 || p.playerAugment1 || 0), totalCs, csPerMin, goldEarned: p.goldEarned, visionScore: p.visionScore, controlWards: p.visionWardsBoughtInGame, 
                multiKill, firstBlood: p.firstBloodKill, durationMin, durationSec, dateStr, timestamp: detail.info.gameEndTimestamp, 
                blueTeam: detail.info.participants.filter(x => x.teamId === 100).map(x => x.championName), 
                redTeam: detail.info.participants.filter(x => x.teamId === 200).map(x => x.championName), 
                participants: detailedParticipants, goldFrames, myRunes, myTimeline 
            };
        }).filter(Boolean);

        const finalData = {
            puuid: targetPuuid,
            version: currentVersion,
            profile: {
                name: `${gameName}#${tagLine}`, level: realLevel, icon: `https://ddragon.leagueoflegends.com/cdn/${currentVersion}/img/profileicon/${realIconId}.png`,
                tier: rankData?.tier || 'UNRANKED', rank: rankData?.rank || '', leaguePoints: rankData?.leaguePoints || 0,
                wins: rankData?.wins || 0, losses: rankData?.losses || 0 // ★ 이 줄이 추가되었습니다!
            },
            history: history
        };

        myCache.set(summonerName, finalData);
        finalData.expireAt = myCache.getTtl(summonerName);
        console.log(`[API] 전적 데이터 처리 완료: ${summonerName}`);
        res.json(finalData);

    } catch (error) {
        if (error.response?.status === 429) {
            console.log(`[API] 429 한도 초과. ${summonerName} DB 폴백 시도...`);
            try {
                const [gameName] = req.params.name.split('#');
                const safeName = gameName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\s+/g, '');
                const flexibleRegex = new RegExp("^" + safeName.split('').join('\\s*') + "$", "i");
                
                const fallbackMatches = await MatchCache.find({
                    "detail.info.participants": {
                        $elemMatch: { $or: [{ riotIdGameName: { $regex: flexibleRegex } }, { summonerName: { $regex: flexibleRegex } }] }
                    }
                }).sort({ "detail.info.gameEndTimestamp": -1 }).limit(30);

                if (fallbackMatches?.length > 0) {
                    let targetPuuid = "", profileIconId = 1;
                    const history = fallbackMatches.map(m => {
                        const p = m.detail.info.participants.find(part => {
                            const pRiot = (part.riotIdGameName || "").replace(/\s+/g, '').toLowerCase();
                            const pSumm = (part.summonerName || "").replace(/\s+/g, '').toLowerCase();
                            return pRiot === safeName.toLowerCase() || pSumm === safeName.toLowerCase();
                        });
                        
                        if (!p) return null;
                        targetPuuid = p.puuid;
                        if (p.profileIcon) profileIconId = p.profileIcon;

                        const queueMap = { 420: "솔로랭크", 440: "자유랭크", 450: "칼바람", 1700: "아레나" };
                        const queueType = queueMap[m.detail.info.queueId] || "일반";

                        const durationMin = Math.floor(m.detail.info.gameDuration / 60);
                        const teamKills = m.detail.info.participants.filter(x => x.teamId === p.teamId).reduce((sum, x) => sum + x.kills, 0);

                        return {
                            matchId: m.detail.metadata.matchId, queueType, win: p.win, championName: p.championName === "FiddleSticks" ? "Fiddlesticks" : p.championName,
                            champLevel: p.champLevel, kills: p.kills, deaths: p.deaths, assists: p.assists,
                            kda: p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(2),
                            kp: teamKills === 0 ? 0 : Math.round(((p.kills + p.assists) / teamKills) * 100),
                            spell1: p.summoner1Id, spell2: p.summoner2Id, mainRune: p.perks?.styles?.[0]?.style || null, subRune: p.perks?.styles?.[1]?.style || null,
                            item0: p.item0, item1: p.item1, item2: p.item2, item3: p.item3, item4: p.item4, item5: p.item5, item6: p.item6, item7: (p.roleBoundItem || p.item7 || p.playerAugment1 || 0),
                            totalCs: p.totalMinionsKilled + p.neutralMinionsKilled, csPerMin: durationMin > 0 ? ((p.totalMinionsKilled + p.neutralMinionsKilled) / durationMin).toFixed(1) : "0.0",
                            goldEarned: p.goldEarned, visionScore: p.visionScore, controlWards: p.visionWardsBoughtInGame, durationMin, durationSec: m.detail.info.gameDuration % 60,
                            dateStr: "과거 전적", timestamp: m.detail.info.gameEndTimestamp, participants: []
                        };
                    }).filter(Boolean);

                    if (history.length > 0) {
                        console.log(`[API] 429 폴백 성공. DB에서 ${history.length}게임 반환`);
                        return res.json({
                            puuid: targetPuuid, version: currentVersion,
                            profile: { name: req.params.name, level: "정보없음", icon: `https://ddragon.leagueoflegends.com/cdn/${currentVersion}/img/profileicon/${profileIconId}.png`, tier: "서버 지연", rank: "", leaguePoints: 0 },
                            history, isCachedFallback: true
                        });
                    }
                }
            } catch (fallbackErr) { console.error("[Fallback Error]", fallbackErr); }
            return res.status(429).json({ error: "조회 한도를 초과했습니다. 잠시 후 다시 시도해주세요." });
        }

        console.error(`[Error] API 통신 오류: ${error.message}`);
        if (error.response?.status === 404) return res.status(404).json({ error: "소환사를 찾을 수 없습니다. 닉네임을 다시 확인해주세요." });
        res.status(500).json({ error: "데이터 처리 중 문제가 발생했습니다." });
    }
});

// 4-2. 유저 모스트 챔피언 API
app.get('/api/mastery/:puuid', async (req, res) => {
    try {
        const response = await axios.get(`https://kr.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${req.params.puuid}/top?count=7`, { headers: { 'X-Riot-Token': API_KEY } });
        res.json(response.data);
    } catch (error) {
        console.error("마스터리 조회 에러:", error.response?.data || error.message);
        res.status(500).json({ error: '마스터리 데이터를 불러오지 못했습니다.' });
    }
});

// 4-3. 통계 데이터 (로컬 JSON) API
app.get('/api/champion-stats', (req, res) => {
    try {
        res.json(require('./stats_data.json'));
    } catch (error) {
        console.error('[Error] 통계 데이터 로드 실패:', error.message);
        res.status(500).json({ error: "통계 데이터를 불러오지 못했습니다." });
    }
});

// 4-4. 챌린저 랭킹 API
app.get('/api/ranking', async (req, res) => {
    const cachedRanking = myCache.get('challenger_ranking_data');
    if (cachedRanking) return res.json(cachedRanking);
    if (challengerList.length === 0) return res.status(503).json({ error: "랭킹 데이터를 수집 중입니다. 잠시 후 다시 시도해주세요." });

    const processedPlayers = challengerList.map(p => ({
        displayName: resolvedNames[p.puuid]?.displayName || `User-${String(p.puuid).substring(0, 8)}`,
        leaguePoints: p.leaguePoints || 0,
        wins: p.wins || 0,
        losses: p.losses || 0
    }));

    const finalRankingData = { tier: "CHALLENGER", players: processedPlayers };
    myCache.set('challenger_ranking_data', finalRankingData, 600);
    res.json(finalRankingData);
});

// ==========================================
// [5] 프론트엔드 라우팅 및 서버 구동
// ==========================================
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(3000, () => console.log('[System] 서버 실행 중: http://localhost:3000'));