/**
 * analytics.js — Motor de Análise de Apostas NBA
 * Modelos: Distribuição Normal, Critério de Kelly, Expected Value
 *
 * Mercados cobertos:
 *  - Total (Over/Under) do jogo
 *  - Spread (handicap)
 *  - Moneyline (1×2)
 *  - Props de jogadores (pontos, rebotes, assistências, 3-pontos)
 */

'use strict';

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

function normCDF(x, mu = 0, sigma = 1) {
  if (sigma <= 0) return x >= mu ? 1 : 0;
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

function probOver(line, mu, sigma) { return 1 - normCDF(line, mu, sigma); }
function probUnder(line, mu, sigma) { return normCDF(line, mu, sigma); }
function calcEV(prob, odd) { return (prob * odd) - 1; }
function calcKelly(prob, odd, fraction = 0.25) {
  if (odd <= 1 || prob <= 0 || prob >= 1) return 0;
  const full = (prob * odd - 1) / (odd - 1);
  return Math.max(0, full * fraction);
}

function mean(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr, mu) {
  if (!arr || arr.length < 2) return null;
  const m = mu ?? mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

const NBA = {
  teamAvg: 113.5, teamSigma: 11.0, totalSigma: 16.0, homeCourt: 3.2, spreadSigma: 12.5,
  player: {
    points:   { avg: 14.5, sigma: 8.0 },
    rebounds: { avg:  5.5, sigma: 3.5 },
    assists:  { avg:  3.2, sigma: 2.5 },
    threes:   { avg:  1.4, sigma: 1.3 },
  },
};

function norm(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function namesMatch(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  const la = na.split(' ').pop(), lb = nb.split(' ').pop();
  return la.length > 3 && la === lb;
}

function buildTeamMap(statsArr) {
  const map = {};
  for (const g of (statsArr || [])) {
    const home = g.homeTeamName || g.homeName || '';
    const away = g.awayTeamName || g.awayName || '';
    const hs = parseFloat(g.homeScore);
    const as_ = parseFloat(g.awayScore);
    if (!home || !away || isNaN(hs) || isNaN(as_)) continue;
    if (hs === 0 && as_ === 0) continue;
    if (!map[home]) map[home] = { scores: [], against: [] };
    if (!map[away]) map[away] = { scores: [], against: [] };
    map[home].scores.push(hs); map[home].against.push(as_);
    map[away].scores.push(as_); map[away].against.push(hs);
  }
  return map;
}

function buildPlayerMap(statsArr) {
  const map = {};
  for (const g of (statsArr || [])) {
    const players = [...(g.homePlayers || []), ...(g.awayPlayers || [])];
    for (const p of players) {
      if (!p.playerId) continue;
      const id = String(p.playerId);
      if (!map[id]) map[id] = { name: p.playerName || id, points: [], rebounds: [], assists: [], threes: [] };
      if (p.score != null) map[id].points.push(parseFloat(p.score) || 0);
      map[id].rebounds.push((parseFloat(p.defend) || 0) + (parseFloat(p.attack) || 0));
      if (p.assist != null) map[id].assists.push(parseFloat(p.assist) || 0);
      if (p.threePointHit != null) map[id].threes.push(parseFloat(p.threePointHit) || 0);
    }
  }
  return map;
}

function findGameOdds(odds, homeName, awayName) {
  for (const o of (odds || [])) {
    if ((namesMatch(o.home_team, homeName) && namesMatch(o.away_team, awayName)) ||
        (namesMatch(o.home_team, awayName) && namesMatch(o.away_team, homeName))) return o;
  }
  return null;
}

function getMarket(gameOdds, key) {
  return gameOdds?.bookmakers?.[0]?.markets?.find(m => m.key === key) || null;
}

function teamStats(teamMap, name) {
  if (teamMap[name]) return teamMap[name];
  const key = Object.keys(teamMap).find(k => namesMatch(k, name));
  return key ? teamMap[key] : null;
}

function avgFor(teamMap, name) {
  const s = teamStats(teamMap, name);
  return s?.scores?.length > 0 ? mean(s.scores) : null;
}

function avgAgainst(teamMap, name) {
  const s = teamStats(teamMap, name);
  return s?.against?.length > 0 ? mean(s.against) : null;
}

function _addEntry(list, entry, config) {
  entry.valor_sugerido = entry.kelly * config.bankroll;
  if (entry.ev < config.evMin) return;
  if (entry.odd < config.oddMin) return;
  if (entry.prob < 0.25 || entry.prob > 0.92) return;
  if (entry.kelly <= 0) return;
  list.push(entry);
}

function analyzeTotals(game, teamMap, gameOdds, config) {
  const market = getMarket(gameOdds, 'totals');
  if (!market) return [];
  const homeName = game.homeName || game.homeTeamName || '';
  const awayName = game.awayName || game.awayTeamName || '';
  const overOut = market.outcomes?.find(o => /over/i.test(o.name));
  const underOut = market.outcomes?.find(o => /under/i.test(o.name));
  if (!overOut?.point) return [];
  const line = parseFloat(overOut.point);
  const overOdd = parseFloat(overOut.price) || 1.9;
  const underOdd = parseFloat(underOut?.price) || 1.9;
  const homeAvg = avgFor(teamMap, homeName) ?? (NBA.teamAvg + NBA.homeCourt / 2);
  const awayAvg = avgFor(teamMap, awayName) ?? (NBA.teamAvg - NBA.homeCourt / 2);
  const homeAgainst = avgAgainst(teamMap, homeName) ?? NBA.teamAvg;
  const awayAgainst = avgAgainst(teamMap, awayName) ?? NBA.teamAvg;
  const expectedHome = (homeAvg + awayAgainst) / 2;
  const expectedAway = (awayAvg + homeAgainst) / 2;
  const expectedTotal = expectedHome + expectedAway;
  const hStat = teamStats(teamMap, homeName);
  const aStat = teamStats(teamMap, awayName);
  let sigma = NBA.totalSigma;
  if (hStat?.scores?.length >= 3 && aStat?.scores?.length >= 3) {
    const sh = stddev(hStat.scores) || NBA.teamSigma;
    const sa = stddev(aStat.scores) || NBA.teamSigma;
    sigma = Math.max(10, Math.min(Math.sqrt(sh ** 2 + sa ** 2), 22));
  }
  const pOver = probOver(line, expectedTotal, sigma);
  const pUnder = probUnder(line, expectedTotal, sigma);
  const entries = [];
  const detail = `Total esperado ${expectedTotal.toFixed(1)} | ${homeName}: ${expectedHome.toFixed(1)} | ${awayName}: ${expectedAway.toFixed(1)} | σ: ${sigma.toFixed(1)}`;
  _addEntry(entries, { tipo: 'total', descricao: `${homeName} vs ${awayName} — OVER ${line}`, avg: expectedTotal.toFixed(1), line, odd: overOdd, prob: pOver, ev: calcEV(pOver, overOdd), kelly: calcKelly(pOver, overOdd, config.kellyFraction), detalhes: detail }, config);
  _addEntry(entries, { tipo: 'total', descricao: `${homeName} vs ${awayName} — UNDER ${line}`, avg: expectedTotal.toFixed(1), line, odd: underOdd, prob: pUnder, ev: calcEV(pUnder, underOdd), kelly: calcKelly(pUnder, underOdd, config.kellyFraction), detalhes: detail }, config);
  return entries;
}

function analyzeSpreads(game, teamMap, gameOdds, config) {
  const market = getMarket(gameOdds, 'spreads');
  if (!market) return [];
  const homeName = game.homeName || game.homeTeamName || '';
  const awayName = game.awayName || game.awayTeamName || '';
  const homeOut = market.outcomes?.find(o => namesMatch(o.name, homeName));
  const awayOut = market.outcomes?.find(o => namesMatch(o.name, awayName));
  if (!homeOut) return [];
  const spread = parseFloat(homeOut.point);
  const homeOdd = parseFloat(homeOut.price) || 1.9;
  const awayOdd = parseFloat(awayOut?.price) || 1.9;
  const homeAvg = avgFor(teamMap, homeName) ?? (NBA.teamAvg + NBA.homeCourt / 2);
  const awayAvg = avgFor(teamMap, awayName) ?? (NBA.teamAvg - NBA.homeCourt / 2);
  const homeAgainst = avgAgainst(teamMap, homeName) ?? NBA.teamAvg;
  const awayAgainst = avgAgainst(teamMap, awayName) ?? NBA.teamAvg;
  const expectedMargin = ((homeAvg - awayAgainst) + (awayAvg - homeAgainst)) / 2 + NBA.homeCourt;
  const sigma = NBA.spreadSigma;
  const pHomeCover = probOver(-spread, expectedMargin, sigma);
  const pAwayCover = 1 - pHomeCover;
  const entries = [];
  const detail = `Margem esperada ${expectedMargin.toFixed(1)} pts | Home: ${homeAvg.toFixed(1)} | Away: ${awayAvg.toFixed(1)}`;
  _addEntry(entries, { tipo: 'spread', descricao: `${homeName} ${spread > 0 ? '+' : ''}${spread} (Spread)`, avg: expectedMargin.toFixed(1), line: spread, odd: homeOdd, prob: pHomeCover, ev: calcEV(pHomeCover, homeOdd), kelly: calcKelly(pHomeCover, homeOdd, config.kellyFraction), detalhes: detail }, config);
  _addEntry(entries, { tipo: 'spread', descricao: `${awayName} +${-spread} (Spread)`, avg: (-expectedMargin).toFixed(1), line: -spread, odd: awayOdd, prob: pAwayCover, ev: calcEV(pAwayCover, awayOdd), kelly: calcKelly(pAwayCover, awayOdd, config.kellyFraction), detalhes: detail }, config);
  return entries;
}

function analyzeH2H(game, teamMap, gameOdds, config) {
  const market = getMarket(gameOdds, 'h2h');
  if (!market) return [];
  const homeName = game.homeName || game.homeTeamName || '';
  const awayName = game.awayName || game.awayTeamName || '';
  const homeOut = market.outcomes?.find(o => namesMatch(o.name, homeName));
  const awayOut = market.outcomes?.find(o => namesMatch(o.name, awayName));
  if (!homeOut || !awayOut) return [];
  const homeOdd = parseFloat(homeOut.price);
  const awayOdd = parseFloat(awayOut.price);
  if (!homeOdd || !awayOdd || homeOdd < 1.01 || awayOdd < 1.01) return [];
  const homeAvg = avgFor(teamMap, homeName) ?? (NBA.teamAvg + NBA.homeCourt / 2);
  const awayAvg = avgFor(teamMap, awayName) ?? (NBA.teamAvg - NBA.homeCourt / 2);
  const homeAgainst = avgAgainst(teamMap, homeName) ?? NBA.teamAvg;
  const awayAgainst = avgAgainst(teamMap, awayName) ?? NBA.teamAvg;
  const expectedMargin = ((homeAvg - awayAgainst) + (awayAvg - homeAgainst)) / 2 + NBA.homeCourt;
  const sigma = NBA.spreadSigma;
  const pHome = probOver(0, expectedMargin, sigma);
  const pAway = 1 - pHome;
  const entries = [];
  const detail = `Margem esperada ${expectedMargin.toFixed(1)} pts | Home: ${(pHome*100).toFixed(1)}% | Away: ${(pAway*100).toFixed(1)}%`;
  _addEntry(entries, { tipo: 'h2h', descricao: `${homeName} vence (Moneyline)`, avg: expectedMargin.toFixed(1), line: 0, odd: homeOdd, prob: pHome, ev: calcEV(pHome, homeOdd), kelly: calcKelly(pHome, homeOdd, config.kellyFraction), detalhes: detail }, config);
  _addEntry(entries, { tipo: 'h2h', descricao: `${awayName} vence (Moneyline)`, avg: (-expectedMargin).toFixed(1), line: 0, odd: awayOdd, prob: pAway, ev: calcEV(pAway, awayOdd), kelly: calcKelly(pAway, awayOdd, config.kellyFraction), detalhes: detail }, config);
  return entries;
}

function analyzePlayerProps(gameOdds, playerMap, config) {
  const entries = [];
  const bk = gameOdds?.bookmakers?.[0];
  if (!bk) return entries;
  const PROPS = {
    player_points:   { field: 'points',   label: 'Pontos',       def: NBA.player.points   },
    player_rebounds: { field: 'rebounds', label: 'Rebotes',      def: NBA.player.rebounds },
    player_assists:  { field: 'assists',  label: 'Assistências', def: NBA.player.assists  },
    player_threes:   { field: 'threes',   label: '3-Pontos',     def: NBA.player.threes   },
  };
  for (const [mKey, mInfo] of Object.entries(PROPS)) {
    const market = bk.markets?.find(m => m.key === mKey);
    if (!market) continue;
    for (const out of (market.outcomes || [])) {
      const playerName = out.description || out.name || '';
      const direction = /over/i.test(out.name) ? 'over' : /under/i.test(out.name) ? 'under' : null;
      if (!direction) continue;
      const line = parseFloat(out.point);
      const odd = parseFloat(out.price);
      if (!line || !odd || odd < 1.1) continue;
      const pid = Object.keys(playerMap).find(id =>
        norm(playerMap[id].name).includes(norm(playerName).split(' ').pop()) ||
        norm(playerName).includes(norm(playerMap[id].name).split(' ').pop())
      );
      const statArr = pid ? playerMap[pid][mInfo.field] : null;
      const avg = statArr?.length > 0 ? mean(statArr) : mInfo.def.avg;
      const sigma = statArr?.length >= 3 ? (stddev(statArr, avg) || mInfo.def.sigma) : mInfo.def.sigma;
      const prob = direction === 'over' ? probOver(line, avg, sigma) : probUnder(line, avg, sigma);
      _addEntry(entries, { tipo: 'player_prop', descricao: `${playerName} — ${direction === 'over' ? 'OVER' : 'UNDER'} ${line} ${mInfo.label}`, avg: avg.toFixed(1), line, odd, prob, ev: calcEV(prob, odd), kelly: calcKelly(prob, odd, config.kellyFraction), detalhes: `Média: ${avg.toFixed(1)} | σ: ${sigma.toFixed(1)} | ${statArr?.length || 0} jogo(s)` }, config);
    }
  }
  return entries;
}

async function generateAllEntries(data, config) {
  const { schedule = [], stats = [], odds = [] } = data;
  const allStats = [...stats];
  if (data.teamHistories) {
    for (const games of Object.values(data.teamHistories)) {
      if (Array.isArray(games)) allStats.push(...games);
    }
  }
  const teamMap = buildTeamMap(allStats);
  const playerMap = buildPlayerMap(allStats);
  const all = [];
  for (const game of schedule) {
    const status = parseInt(game.status ?? -1);
    if (status > 0) continue;
    const homeName = game.homeName || game.homeTeamName || '';
    const awayName = game.awayName || game.awayTeamName || '';
    if (!homeName || !awayName) continue;
    const gameOdds = findGameOdds(odds, homeName, awayName);
    all.push(...analyzeTotals(game, teamMap, gameOdds, config));
    all.push(...analyzeSpreads(game, teamMap, gameOdds, config));
    all.push(...analyzeH2H(game, teamMap, gameOdds, config));
    all.push(...analyzePlayerProps(gameOdds, playerMap, config));
  }
  return all.sort((a, b) => b.ev - a.ev);
}

async function prepareAnalysisData(date, ctx) {
  return { schedule: [], stats: [], odds: [], date };
}

module.exports = { generateAllEntries, prepareAnalysisData, buildTeamMap, buildPlayerMap };
