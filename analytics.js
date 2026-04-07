/**
 * analytics.js — Motor de Análise de Apostas NBA v3.0
 *
 * Métodos implementados:
 *  - Distribuição Normal com sigma adaptativo
 *  - Bayesian shrinkage (mistura dado real + prior NBA)
 *  - Média exponencial ponderada (jogos recentes valem mais)
 *  - Splits Casa/Fora (home/away performance separados)
 *  - Métricas defensivas: defesa mais vazada, eficiência defensiva
 *  - Métricas ofensivas: eficiência ofensiva, consistência
 *  - Edge vs mercado (nossa prob - prob implícita do bookmaker)
 *  - Nível de confiança (Alto/Médio/Baixo) baseado em dados disponíveis
 *  - Critério de Kelly fracionado
 *  - Mínimo de 10 jogos para confiança Alta
 */

'use strict';

// ─────────────────────────────────────────────
// 1. MATEMÁTICA
// ─────────────────────────────────────────────

function erf(x) {
  const s = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return s * (1 - p * Math.exp(-a * a));
}

function normCDF(x, mu = 0, sigma = 1) {
  if (sigma <= 0) return x >= mu ? 1 : 0;
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

function probOver(line, mu, sigma)  { return 1 - normCDF(line, mu, sigma); }
function probUnder(line, mu, sigma) { return normCDF(line, mu, sigma); }

function calcEV(prob, odd)    { return (prob * odd) - 1; }

function calcKelly(prob, odd, fraction = 0.20) {
  if (odd <= 1 || prob <= 0 || prob >= 1) return 0;
  const full = (prob * odd - 1) / (odd - 1);
  return Math.max(0, full * fraction);
}

// ─────────────────────────────────────────────
// 2. ESTATÍSTICA
// ─────────────────────────────────────────────

function simpleMean(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Média ponderada exponencial — jogo mais recente tem peso 1.0,
 *  cada jogo anterior tem peso × 0.88 (decay). */
function weightedMean(arr) {
  if (!arr || !arr.length) return null;
  const DECAY = 0.88;
  let sum = 0, wSum = 0;
  for (let i = 0; i < arr.length; i++) {
    const w = Math.pow(DECAY, arr.length - 1 - i);
    sum  += arr[i] * w;
    wSum += w;
  }
  return sum / wSum;
}

function stddev(arr, mu) {
  if (!arr || arr.length < 2) return null;
  const m = mu ?? simpleMean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/** Bayesian shrinkage: mistura média observada com prior NBA.
 *  Com priorWeight=10 → precisa de 10 jogos para confiar 50% nos dados reais.
 *  Com 20 jogos → 67% dados reais, 33% prior. */
function bayesianAvg(observed, n, prior, priorWeight = 10) {
  if (observed === null || n === 0) return prior;
  const w = n / (n + priorWeight);
  return w * observed + (1 - w) * prior;
}

// ─────────────────────────────────────────────
// 3. DEFAULTS NBA (temporada 2024-25)
// ─────────────────────────────────────────────

const NBA = {
  teamAvg:        113.5,  // pts/jogo média da liga
  teamSigma:       11.0,  // σ de pontuação por time
  totalSigma:      16.0,  // σ do total combinado
  homeCourt:        3.2,  // vantagem de mando (pts)
  spreadSigma:     12.5,  // σ da margem
  defRating:      113.5,  // pts permitidos/jogo média da liga
  pace:           100.0,  // posses por jogo
  player: {
    points:   { avg: 14.5, sigma: 8.0 },
    rebounds: { avg:  5.5, sigma: 3.5 },
    assists:  { avg:  3.2, sigma: 2.5 },
    threes:   { avg:  1.4, sigma: 1.3 },
  },
};

// ─────────────────────────────────────────────
// 4. NORMALIZAÇÃO / MATCHING
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// 5. CONSTRUÇÃO DOS MAPAS
// ─────────────────────────────────────────────

/**
 * teamMap[name] = {
 *   scores, against, margins,         // todos os jogos
 *   homeScores, homeAgainst,          // como mandante
 *   awayScores, awayAgainst,          // como visitante
 * }
 */
function buildTeamMap(statsArr) {
  const map = {};

  for (const g of (statsArr || [])) {
    const home = g.homeTeamName || g.homeName || '';
    const away = g.awayTeamName || g.awayName || '';
    const hs   = parseFloat(g.homeScore);
    const as_  = parseFloat(g.awayScore);

    if (!home || !away || isNaN(hs) || isNaN(as_)) continue;
    if (hs === 0 && as_ === 0) continue;

    const blank = () => ({ scores:[], against:[], margins:[], homeScores:[], homeAgainst:[], awayScores:[], awayAgainst:[] });
    if (!map[home]) map[home] = blank();
    if (!map[away]) map[away] = blank();

    // Todos os jogos
    map[home].scores.push(hs);   map[home].against.push(as_);  map[home].margins.push(hs - as_);
    map[away].scores.push(as_);  map[away].against.push(hs);   map[away].margins.push(as_ - hs);

    // Split casa/fora
    map[home].homeScores.push(hs);   map[home].homeAgainst.push(as_);
    map[away].awayScores.push(as_);  map[away].awayAgainst.push(hs);
  }

  return map;
}

/**
 * playerMap[id] = { name, points[], rebounds[], assists[], threes[] }
 */
function buildPlayerMap(statsArr) {
  const map = {};
  for (const g of (statsArr || [])) {
    const players = [...(g.homePlayers || []), ...(g.awayPlayers || [])];
    for (const p of players) {
      if (!p.playerId) continue;
      const id = String(p.playerId);
      if (!map[id]) map[id] = { name: p.playerName || id, points:[], rebounds:[], assists:[], threes:[] };
      // Só registra se o campo existir no dado (null = não jogou / não rastreado)
      if (p.score  != null) map[id].points.push(parseFloat(p.score)  || 0);
      if (p.defend != null || p.attack != null) {
        const reb = (parseFloat(p.defend) || 0) + (parseFloat(p.attack) || 0);
        map[id].rebounds.push(reb);
      }
      if (p.assist        != null) map[id].assists.push(parseFloat(p.assist)        || 0);
      if (p.threePointHit != null && parseFloat(p.threePointHit) > 0)
        map[id].threes.push(parseFloat(p.threePointHit));
    }
  }
  return map;
}

// ─────────────────────────────────────────────
// 6. HELPERS DE ESTATÍSTICAS DE TIME
// ─────────────────────────────────────────────

function teamStats(teamMap, name) {
  if (teamMap[name]) return teamMap[name];
  const k = Object.keys(teamMap).find(k => namesMatch(k, name));
  return k ? teamMap[k] : null;
}

/**
 * Retorna médias Bayesianas para um time.
 * Usa splits casa/fora quando disponíveis (>=3 jogos split).
 * @param {boolean} isHome — true se o time está jogando em casa
 */
function getTeamStats(teamMap, name, isHome) {
  const s = teamStats(teamMap, name);
  if (!s) return { offAvg: NBA.teamAvg, defAvg: NBA.defRating, sigma: NBA.teamSigma, n: 0, consistency: 0.5, defLeak: 0 };

  // Escolhe split (casa/fora) se tiver >= 3 jogos, senão usa todos
  const offArr = (isHome && s.homeScores.length >= 3) ? s.homeScores
               : (!isHome && s.awayScores.length >= 3) ? s.awayScores
               : s.scores;
  const defArr = (isHome && s.homeAgainst.length >= 3) ? s.homeAgainst
               : (!isHome && s.awayAgainst.length >= 3) ? s.awayAgainst
               : s.against;

  const n      = offArr.length;
  const rawOff = weightedMean(offArr);
  const rawDef = weightedMean(defArr);

  // Bayesian shrinkage em relação à média da liga
  const offAvg = bayesianAvg(rawOff, n, NBA.teamAvg);
  const defAvg = bayesianAvg(rawDef, n, NBA.defRating);

  // Sigma adaptativo (desvio real ou default)
  const sd  = stddev(offArr, rawOff) || NBA.teamSigma;
  const sigma = bayesianAvg(sd, n, NBA.teamSigma, 5);

  // Consistência: 1 - CV (coeficiente de variação). Mais alto = mais consistente.
  const cv = rawOff && rawOff > 0 ? Math.min(1, sd / rawOff) : 0.5;
  const consistency = Math.max(0, 1 - cv);

  // Defesa mais vazada: quanto acima da média da liga permite
  const defLeak = Math.max(0, defAvg - NBA.defRating); // positivo = defesa ruim

  return { offAvg, defAvg, sigma, n, consistency, defLeak, rawOff, rawDef };
}

/** Confiança baseada nos jogos disponíveis de ambos os times */
function calcConfidence(nHome, nAway) {
  const n = Math.min(nHome, nAway);
  if (n >= 10) return 'alto';
  if (n >= 5)  return 'medio';
  return 'baixo';
}

/** Sigma adaptativo para spreads, calculado a partir das margens */
function adaptiveSpreadSigma(sHome, sAway) {
  const marginsH = sHome?.margins || [];
  const marginsA = sAway?.margins || [];
  const allMargins = [...marginsH, ...marginsA];
  if (allMargins.length >= 6) {
    const s = stddev(allMargins, simpleMean(allMargins)) || NBA.spreadSigma;
    return Math.max(10, Math.min(s, 16));
  }
  return NBA.spreadSigma;
}

// ─────────────────────────────────────────────
// 7. ODDS
// ─────────────────────────────────────────────

function findGameOdds(odds, homeName, awayName) {
  for (const o of (odds || [])) {
    if ((namesMatch(o.home_team, homeName) && namesMatch(o.away_team, awayName)) ||
        (namesMatch(o.home_team, awayName) && namesMatch(o.away_team, homeName)))
      return o;
  }
  return null;
}

function getMarket(gameOdds, key) {
  return gameOdds?.bookmakers?.[0]?.markets?.find(m => m.key === key) || null;
}

// ─────────────────────────────────────────────
// 8. ANÁLISE DE TOTAL (OVER / UNDER)
// ─────────────────────────────────────────────

function analyzeTotals(game, teamMap, gameOdds, config) {
  const market = getMarket(gameOdds, 'totals');
  if (!market) return [];

  const homeName = game.homeName || game.homeTeamName || '';
  const awayName = game.awayName || game.awayTeamName || '';

  const overOut  = market.outcomes?.find(o => /over/i.test(o.name));
  const underOut = market.outcomes?.find(o => /under/i.test(o.name));
  if (!overOut?.point) return [];

  const line     = parseFloat(overOut.point);
  const overOdd  = parseFloat(overOut.price)  || 1.9;
  const underOdd = parseFloat(underOut?.price) || 1.9;

  const stH = getTeamStats(teamMap, homeName, true);
  const stA = getTeamStats(teamMap, awayName, false);

  // Total esperado:
  // ataque do home vs defesa do away + ataque do away vs defesa do home
  // "defesa mais vazada" aumenta o total esperado
  const expectedHome  = (stH.offAvg + stA.defAvg) / 2;
  const expectedAway  = (stA.offAvg + stH.defAvg) / 2;
  const expectedTotal = expectedHome + expectedAway;

  // Ajuste de defesa vazada: se ambas as defesas são ruins, total sobe
  const defLeakBonus  = (stH.defLeak + stA.defLeak) * 0.3;
  const finalTotal    = expectedTotal + defLeakBonus;

  // Sigma adaptativo: raiz da soma dos quadrados dos desvios
  const sh = stddev(teamStats(teamMap, homeName)?.scores) || stH.sigma;
  const sa = stddev(teamStats(teamMap, awayName)?.scores) || stA.sigma;
  const sigma = Math.max(11, Math.min(Math.sqrt(sh**2 + sa**2), 22));

  const pOver  = probOver(line, finalTotal, sigma);
  const pUnder = probUnder(line, finalTotal, sigma);

  const confidence = calcConfidence(stH.n, stA.n);
  const nGames     = Math.min(stH.n, stA.n);
  const consistency = (stH.consistency + stA.consistency) / 2;

  const detail = [
    `Total projetado: ${finalTotal.toFixed(1)} pts (linha: ${line})`,
    `${homeName}: atq ${stH.offAvg.toFixed(1)} | def ${stH.defAvg.toFixed(1)} (${stH.defLeak > 0 ? `+${stH.defLeak.toFixed(1)} pts vazados` : 'sólida'})`,
    `${awayName}: atq ${stA.offAvg.toFixed(1)} | def ${stA.defAvg.toFixed(1)} (${stA.defLeak > 0 ? `+${stA.defLeak.toFixed(1)} pts vazados` : 'sólida'})`,
    `σ: ${sigma.toFixed(1)} | Consistência: ${(consistency*100).toFixed(0)}% | ${nGames} jogos`,
  ].join(' | ');

  const entries = [];

  for (const [direction, odd, prob] of [['OVER', overOdd, pOver], ['UNDER', underOdd, pUnder]]) {
    const ev    = calcEV(prob, odd);
    const kelly = calcKelly(prob, odd, config.kellyFraction);
    const impliedProb = 1 / odd;
    const edge  = prob - impliedProb;

    _addEntry(entries, {
      tipo: 'total',
      descricao: `${homeName} vs ${awayName} — ${direction} ${line}`,
      avg: finalTotal.toFixed(1), line, odd, prob, ev, kelly,
      impliedProb, edge, confidence, nGames, consistency,
      detalhes: detail,
    }, config);
  }

  return entries;
}

// ─────────────────────────────────────────────
// 9. ANÁLISE DE SPREAD
// ─────────────────────────────────────────────

function analyzeSpreads(game, teamMap, gameOdds, config) {
  const market = getMarket(gameOdds, 'spreads');
  if (!market) return [];

  const homeName = game.homeName || game.homeTeamName || '';
  const awayName = game.awayName || game.awayTeamName || '';

  const homeOut = market.outcomes?.find(o => namesMatch(o.name, homeName));
  const awayOut = market.outcomes?.find(o => namesMatch(o.name, awayName));
  if (!homeOut) return [];

  const spread  = parseFloat(homeOut.point);
  const homeOdd = parseFloat(homeOut.price) || 1.9;
  const awayOdd = parseFloat(awayOut?.price) || 1.9;

  const stH = getTeamStats(teamMap, homeName, true);
  const stA = getTeamStats(teamMap, awayName, false);

  // Margem esperada: combinação de ataque vs defesa + vantagem de casa
  const expectedMargin = ((stH.offAvg - stA.defAvg) + (stA.offAvg - stH.defAvg)) / 2 + NBA.homeCourt;

  // Sigma adaptativo usando histórico de margens
  const sH   = teamStats(teamMap, homeName);
  const sA   = teamStats(teamMap, awayName);
  const sigma = adaptiveSpreadSigma(sH, sA);

  const confidence = calcConfidence(stH.n, stA.n);
  const nGames     = Math.min(stH.n, stA.n);

  const detail = [
    `Margem projetada: ${expectedMargin.toFixed(1)} pts | spread: ${spread}`,
    `${homeName}: atq ${stH.offAvg.toFixed(1)} def ${stH.defAvg.toFixed(1)} | cons: ${(stH.consistency*100).toFixed(0)}%`,
    `${awayName}: atq ${stA.offAvg.toFixed(1)} def ${stA.defAvg.toFixed(1)} | cons: ${(stA.consistency*100).toFixed(0)}%`,
    `σ margem: ${sigma.toFixed(1)} | ${nGames} jogos`,
  ].join(' | ');

  const pHomeCover = probOver(-spread, expectedMargin, sigma);
  const pAwayCover = 1 - pHomeCover;

  const entries = [];
  const awaySpread = -spread;

  for (const [name, odd, prob, line, margStr] of [
    [homeName, homeOdd, pHomeCover, spread,     expectedMargin.toFixed(1)],
    [awayName, awayOdd, pAwayCover, awaySpread, (-expectedMargin).toFixed(1)],
  ]) {
    const ev         = calcEV(prob, odd);
    const kelly      = calcKelly(prob, odd, config.kellyFraction);
    const impliedProb = 1 / odd;
    const edge        = prob - impliedProb;
    const spreadStr   = line > 0 ? `+${line}` : `${line}`;

    _addEntry(entries, {
      tipo: 'spread',
      descricao: `${homeName} vs ${awayName} — ${name} ${spreadStr}`,
      avg: margStr, line, odd, prob, ev, kelly,
      impliedProb, edge, confidence, nGames,
      consistency: (stH.consistency + stA.consistency) / 2,
      detalhes: detail,
    }, config);
  }

  return entries;
}

// ─────────────────────────────────────────────
// 10. ANÁLISE MONEYLINE (H2H)
// ─────────────────────────────────────────────

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

  const stH = getTeamStats(teamMap, homeName, true);
  const stA = getTeamStats(teamMap, awayName, false);

  const expectedMargin = ((stH.offAvg - stA.defAvg) + (stA.offAvg - stH.defAvg)) / 2 + NBA.homeCourt;

  const sH   = teamStats(teamMap, homeName);
  const sA   = teamStats(teamMap, awayName);
  const sigma = adaptiveSpreadSigma(sH, sA);

  const pHome = probOver(0, expectedMargin, sigma);
  const pAway = 1 - pHome;

  const confidence = calcConfidence(stH.n, stA.n);
  const nGames     = Math.min(stH.n, stA.n);

  // Taxa de vitória histórica (se disponível)
  const homeWins = sH ? sH.margins.filter(m => m > 0).length : 0;
  const homeWinRate = sH?.margins.length >= 5 ? (homeWins / sH.margins.length * 100).toFixed(0) + '%' : 'N/A';

  const detail = [
    `Margem projetada: ${expectedMargin.toFixed(1)} pts`,
    `${homeName}: ${stH.offAvg.toFixed(1)} pts, cede ${stH.defAvg.toFixed(1)} | Win rate recente: ${homeWinRate}`,
    `${awayName}: ${stA.offAvg.toFixed(1)} pts, cede ${stA.defAvg.toFixed(1)}`,
    `Nossa prob: Home ${(pHome*100).toFixed(1)}% | Away ${(pAway*100).toFixed(1)}% | σ: ${sigma.toFixed(1)} | ${nGames} jogos`,
  ].join(' | ');

  const entries = [];

  for (const [name, odd, prob, margStr] of [
    [homeName, homeOdd, pHome,  expectedMargin.toFixed(1)],
    [awayName, awayOdd, pAway, (-expectedMargin).toFixed(1)],
  ]) {
    const ev          = calcEV(prob, odd);
    const kelly       = calcKelly(prob, odd, config.kellyFraction);
    const impliedProb = 1 / odd;
    const edge        = prob - impliedProb;

    _addEntry(entries, {
      tipo: 'h2h',
      descricao: `${homeName} vs ${awayName} — ${name} vence`,
      avg: margStr, line: 0, odd, prob, ev, kelly,
      impliedProb, edge, confidence, nGames,
      consistency: (stH.consistency + stA.consistency) / 2,
      detalhes: detail,
    }, config);
  }

  return entries;
}

// ─────────────────────────────────────────────
// 11. ANÁLISE DE PROPS DE JOGADORES
// ─────────────────────────────────────────────

function analyzePlayerProps(gameOdds, playerMap, config) {
  const entries = [];
  const bk = gameOdds?.bookmakers?.[0];
  if (!bk) return entries;

  const PROP_CFG = {
    player_points:   { field: 'points',   label: 'Pontos',       def: NBA.player.points   },
    player_rebounds: { field: 'rebounds', label: 'Rebotes',      def: NBA.player.rebounds },
    player_assists:  { field: 'assists',  label: 'Assistências', def: NBA.player.assists  },
    player_threes:   { field: 'threes',   label: '3-Pontos',     def: NBA.player.threes   },
  };

  for (const [mKey, mInfo] of Object.entries(PROP_CFG)) {
    const market = bk.markets?.find(m => m.key === mKey);
    if (!market) continue;

    for (const out of (market.outcomes || [])) {
      const playerName = out.description || out.name || '';
      const direction  = /over/i.test(out.name) ? 'over' : /under/i.test(out.name) ? 'under' : null;
      if (!direction) continue;

      const line = parseFloat(out.point);
      const odd  = parseFloat(out.price);
      if (!line || !odd || odd < 1.1) continue;

      // Localiza jogador no playerMap
      const pid = Object.keys(playerMap).find(id => {
        const pn = norm(playerMap[id].name);
        const qn = norm(playerName);
        return pn.includes(qn.split(' ').pop()) || qn.includes(pn.split(' ').pop());
      });
      const pData   = pid ? playerMap[pid] : null;
      const statArr = pData?.[mInfo.field] || [];
      const nPlayer = statArr.length;

      // Exige mínimo 5 jogos para props de jogadores
      if (nPlayer < 5) continue;

      // Skip se todos os valores são zero (iSports não rastreia este stat)
      if (!statArr.some(v => v > 0)) continue;

      const rawAvg = weightedMean(statArr);
      const avg    = bayesianAvg(rawAvg, nPlayer, mInfo.def.avg, 5);
      const rawSd  = stddev(statArr, rawAvg) || mInfo.def.sigma;
      const sigma  = bayesianAvg(rawSd, nPlayer, mInfo.def.sigma, 5);

      const prob = direction === 'over' ? probOver(line, avg, sigma) : probUnder(line, avg, sigma);
      const ev   = calcEV(prob, odd);
      const kelly = calcKelly(prob, odd, config.kellyFraction);
      const impliedProb = 1 / odd;
      const edge = prob - impliedProb;

      // Consistência do jogador
      const cv   = rawAvg > 0 ? rawSd / rawAvg : 0.5;
      const consistency = Math.max(0, 1 - cv);

      const confidence = nPlayer >= 10 ? 'alto' : nPlayer >= 5 ? 'medio' : 'baixo';

      _addEntry(entries, {
        tipo: 'player_prop',
        descricao: `${playerName} — ${direction === 'over' ? 'OVER' : 'UNDER'} ${line} ${mInfo.label}`,
        avg: avg.toFixed(1), line, odd, prob, ev, kelly,
        impliedProb, edge, confidence, nGames: nPlayer, consistency,
        detalhes: `Média ponderada: ${avg.toFixed(1)} | σ: ${sigma.toFixed(1)} | ${nPlayer} jogos | Consistência: ${(consistency*100).toFixed(0)}%`,
      }, config);
    }
  }

  return entries;
}

// ─────────────────────────────────────────────
// 12. FILTRO DE QUALIDADE
// ─────────────────────────────────────────────

function _addEntry(list, entry, config) {
  const {
    evMin         = 0.05,
    oddMin        = 1.72,
    oddMax        = 3.50,
    kellyFraction = 0.20,
    minProb       = 0.44,
    maxProb       = 0.80,
    minGames      = 0,     // 0 = sem filtro mínimo
    minConfidence = 'baixo',
    bankroll      = 5000,
  } = config;

  // Filtros numéricos
  if (entry.ev    < evMin)                     return;
  if (entry.odd   < oddMin || entry.odd > oddMax) return;
  if (entry.prob  < minProb || entry.prob > maxProb) return;
  if (entry.kelly <= 0)                         return;
  if (entry.edge  <= 0)                         return; // só apostas onde temos edge real

  // Filtro de jogos mínimos (não se aplica a player_prop — props têm seu próprio mínimo)
  if (minGames > 0 && entry.tipo !== 'player_prop' && (entry.nGames || 0) < minGames) return;

  // Filtro de confiança
  const confOrder = { baixo: 0, medio: 1, alto: 2 };
  if ((confOrder[entry.confidence] || 0) < (confOrder[minConfidence] || 0)) return;

  // Valor sugerido (Kelly × banca)
  entry.valor_sugerido = entry.kelly * bankroll;

  // Model score: qualidade composta
  const probConf = Math.min(1, (entry.nGames || 0) / 10);
  const edgeSig  = entry.impliedProb > 0 ? entry.edge / entry.impliedProb : 0;
  entry.modelScore = Math.max(0, entry.ev * (0.5 + 0.5 * probConf) * (1 + edgeSig));

  list.push(entry);
}

// ─────────────────────────────────────────────
// 13. ODDS ESTIMADAS (fallback sem mercado)
// ─────────────────────────────────────────────

function buildEstimatedOdds(game, teamMap) {
  const homeName = game.homeName || game.homeTeamName || '';
  const awayName = game.awayName || game.awayTeamName || '';

  const stH = getTeamStats(teamMap, homeName, true);
  const stA = getTeamStats(teamMap, awayName, false);

  const expectedMargin = ((stH.offAvg - stA.defAvg) + (stA.offAvg - stH.defAvg)) / 2 + NBA.homeCourt;
  const expectedTotal  = (stH.offAvg + stA.defAvg) / 2 + (stA.offAvg + stH.defAvg) / 2;

  const sH = teamStats(teamMap, homeName);
  const sA = teamStats(teamMap, awayName);
  const spreadSig = adaptiveSpreadSigma(sH, sA);

  // Sigma do total
  const sdH = stddev(sH?.scores || [], simpleMean(sH?.scores || [])) || NBA.teamSigma;
  const sdA = stddev(sA?.scores || [], simpleMean(sA?.scores || [])) || NBA.teamSigma;
  const totalSig = Math.max(11, Math.min(Math.sqrt(sdH ** 2 + sdA ** 2), 22));

  // Probabilidades do modelo para cada mercado
  const pHome      = probOver(0, expectedMargin, spreadSig);
  const pAway      = 1 - pHome;

  const totalLine  = Math.round(expectedTotal * 2) / 2;
  const pOver      = probOver(totalLine, expectedTotal, totalSig);
  const pUnder     = 1 - pOver;

  const spread     = Math.round(expectedMargin * 2) / 2;
  const pHomeCover = probOver(-spread, expectedMargin, spreadSig);
  const pAwayCover = 1 - pHomeCover;

  // JUICE < 1 → odds ligeiramente acima do justo → EV ≈ +5.3%
  // Representa "odd mínima que você precisa encontrar no bookmaker para ter EV positivo"
  const JUICE = 0.95;
  const mkOdd = p => +(Math.max(1.1, 1 / (Math.max(0.05, Math.min(0.95, p)) * JUICE)).toFixed(3));

  return {
    home_team: homeName, away_team: awayName, _estimated: true,
    bookmakers: [{
      key: 'estimated', title: 'Modelo Estatístico',
      markets: [
        { key: 'h2h', outcomes: [
          { name: homeName, price: mkOdd(pHome) },
          { name: awayName, price: mkOdd(pAway) },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over',  point: totalLine, price: mkOdd(pOver) },
          { name: 'Under', point: totalLine, price: mkOdd(pUnder) },
        ]},
        { key: 'spreads', outcomes: [
          { name: homeName, point: -spread, price: mkOdd(pHomeCover) },
          { name: awayName, point:  spread, price: mkOdd(pAwayCover) },
        ]},
      ],
    }],
  };
}

// ─────────────────────────────────────────────
// 14. FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────

async function generateAllEntries(data, config) {
  const { schedule = [], stats = [], odds = [] } = data;

  const allStats = [...stats];
  if (data.teamHistories) {
    for (const games of Object.values(data.teamHistories)) {
      if (Array.isArray(games)) allStats.push(...games);
    }
  }

  const teamMap   = buildTeamMap(allStats);
  const playerMap = buildPlayerMap(allStats);

  const all = [];

  for (const game of schedule) {
    const status = parseInt(game.status ?? -1);
    if (status > 0) continue; // pula jogos iniciados/terminados

    const homeName = game.homeName || game.homeTeamName || '';
    const awayName = game.awayName || game.awayTeamName || '';
    if (!homeName || !awayName) continue;

    const gameOdds    = findGameOdds(odds, homeName, awayName);
    const isEstimated = !gameOdds;
    const effectiveOdds = gameOdds || buildEstimatedOdds(game, teamMap);
    const bookmakerName = effectiveOdds?.bookmakers?.[0]?.title ||
                          effectiveOdds?.bookmakers?.[0]?.key || '';

    const tag    = { bookmaker: bookmakerName, estimated: isEstimated };
    const addTag = arr => arr.map(e => ({ ...e, ...tag }));

    all.push(...addTag(analyzeTotals   (game, teamMap, effectiveOdds, config)));
    all.push(...addTag(analyzeSpreads  (game, teamMap, effectiveOdds, config)));
    all.push(...addTag(analyzeH2H      (game, teamMap, effectiveOdds, config)));
    all.push(...addTag(analyzePlayerProps(effectiveOdds, playerMap, config)));
  }

  // Ordena por modelScore (qualidade composta) depois por EV
  return all.sort((a, b) => (b.modelScore - a.modelScore) || (b.ev - a.ev));
}

async function prepareAnalysisData(date) {
  return { schedule: [], stats: [], odds: [], date };
}

module.exports = { generateAllEntries, prepareAnalysisData, buildTeamMap, buildPlayerMap };
