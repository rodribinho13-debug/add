/**
 * NBA Analytics System — Backend Proxy
 * COM MELHORIAS: Cache, Bet365 exclusivo, endpoint para bot
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = 3000;

// ========== SEGURANÇA: use variáveis de ambiente ==========
// Crie um arquivo .env na raiz com:
// ISPORTS_KEY=suachave
// ODDS_KEY=suachave
// Caso não exista, usa as fornecidas (mas NUNCA commite)
try { require('dotenv').config(); } catch(e) {}
const ISPORTS_KEY   = process.env.ISPORTS_KEY   || 'dFAjm3gu69q7Bv2C';
const ODDS_KEY      = process.env.ODDS_KEY      || 'c639b61784bb9f40e7a700b13716cd6e';
// =========================================================

const ISPORTS_HOST  = 'api.isportsapi.com';
const ISPORTS_HOST2 = 'api2.isportsapi.com';
const NBA_LEAGUE_ID = '155';

// ─── Contador de requisições diárias (iSports) ───────────────
const reqCounter = {
  date:  '',
  count: 0,
  LIMIT: 180,               // margem de segurança abaixo das 200 diárias
  _check() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.date) { this.date = today; this.count = 0; }
  },
  increment() {
    this._check();
    this.count++;
    const pct = Math.round((this.count / this.LIMIT) * 100);
    if (this.count >= this.LIMIT)
      console.error(`🚨 LIMITE DE ${this.LIMIT} REQ ATINGIDO! Próxima janela: amanhã.`);
    else if (pct >= 80)
      console.warn(`⚠️  Uso da API iSports: ${this.count}/${this.LIMIT} (${pct}%)`);
    return this.count;
  },
  canMake(n = 1) {
    this._check();
    return (this.count + n) <= this.LIMIT;
  },
  status() {
    this._check();
    return { used: this.count, limit: this.LIMIT, remaining: this.LIMIT - this.count, date: this.date };
  },
};

// Cache simples (em memória)
const cache = new Map();
function getCache(key, ttlSec = 3600) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlSec * 1000) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── HTTP/HTTPS fetch com timeout ─────────────────────────
function fetchJSON(targetUrl, timeoutMs=12000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch(e) { return reject(new Error('URL invalida: ' + targetUrl)); }

    const transport = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': 'NBA-Analytics/1.0', 'Accept': 'application/json' },
      timeout:  timeoutMs,
    };

    const req = transport.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: null, raw: data.slice(0,300) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── iSports helpers ──────────────────────────────────────
function iSportsURL(host, path, params) {
  const qs = Object.entries({ api_key: ISPORTS_KEY, ...params })
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `http://${host}${path}?${qs}`;
}

async function iSportsFetch(path, params, timeoutMs=12000) {
  const cacheKey = `iSports_${path}_${JSON.stringify(params)}`;
  const cached = getCache(cacheKey, 3600);
  if (cached) return cached;

  // Verifica limite diário antes de fazer requisição real
  if (!reqCounter.canMake(1)) {
    console.error('[iSports] Limite diário atingido — retornando cache expirado ou vazio.');
    const old = cache.get(cacheKey);
    if (old) return old.data; // usa cache antigo mesmo expirado
    return { status: 429, body: null };
  }

  try {
    reqCounter.increment();
    const r = await fetchJSON(iSportsURL(ISPORTS_HOST, path, params), timeoutMs);
    if(r.status === 200 && r.body) {
      setCache(cacheKey, r);
      return r;
    }
    throw new Error('Status ' + r.status);
  } catch(e) {
    console.log(`[iSports] fallback api2 (${e.message})`);
    reqCounter.increment();
    const r2 = await fetchJSON(iSportsURL(ISPORTS_HOST2, path, params), timeoutMs);
    if(r2.status === 200 && r2.body) setCache(cacheKey, r2);
    return r2;
  }
}

// ─── iSports Odds (tentativa — endpoint pode não existir neste plano) ────────
async function fetchISportsOddsForGame(matchId) {
  try {
    const r = await iSportsFetch('/sport/basketball/odds', { matchId }, 8000);
    // Verifica se é uma resposta real (não erro 404/403)
    if (r.status === 200 && r.body != null) {
      const list = extractList(r.body);
      return list.length ? list[0] : (typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : null);
    }
    return null;
  } catch(e) {
    return null; // endpoint inexistente — silencioso
  }
}

/**
 * Converte raw iSports odds para o formato esperado por analytics.js:
 * { home_team, away_team, bookmakers: [{ key, title, markets: [...] }] }
 */
function parseISportsOdds(game, raw) {
  if (!raw) return null;

  // Se for array, pega o primeiro elemento
  const data = Array.isArray(raw) ? raw[0] : raw;
  if (!data) return null;

  const h2hOutcomes    = [];
  const spreadsOutcomes = [];
  const totalsOutcomes  = [];

  // ── h2h ──────────────────────────────────────────────────
  // formato eu: { eu: { home, away } }
  if (data.eu && (data.eu.home != null || data.eu.away != null)) {
    if (data.eu.home != null) h2hOutcomes.push({ name: game.homeName, price: parseFloat(data.eu.home) });
    if (data.eu.away != null) h2hOutcomes.push({ name: game.awayName, price: parseFloat(data.eu.away) });
  }
  // formato 1x2: { '1x2': { home, away, draw } }
  const ox = data['1x2'];
  if (ox && (ox.home != null || ox.away != null) && h2hOutcomes.length === 0) {
    if (ox.home != null) h2hOutcomes.push({ name: game.homeName, price: parseFloat(ox.home) });
    if (ox.away != null) h2hOutcomes.push({ name: game.awayName, price: parseFloat(ox.away) });
  }

  // ── spreads ───────────────────────────────────────────────
  // formato asia: { asia: { handicap, home, away } }
  if (data.asia && (data.asia.home != null || data.asia.away != null)) {
    const hdp = data.asia.handicap != null ? parseFloat(data.asia.handicap) : 0;
    if (data.asia.home != null) spreadsOutcomes.push({ name: game.homeName, price: parseFloat(data.asia.home), point: hdp });
    if (data.asia.away != null) spreadsOutcomes.push({ name: game.awayName, price: parseFloat(data.asia.away), point: -hdp });
  }
  // formato handicap: { handicap: { hdp, home, away } }
  if (data.handicap && spreadsOutcomes.length === 0) {
    const hdp = data.handicap.hdp != null ? parseFloat(data.handicap.hdp) : 0;
    if (data.handicap.home != null) spreadsOutcomes.push({ name: game.homeName, price: parseFloat(data.handicap.home), point: hdp });
    if (data.handicap.away != null) spreadsOutcomes.push({ name: game.awayName, price: parseFloat(data.handicap.away), point: -hdp });
  }

  // ── totals ────────────────────────────────────────────────
  // formato bigSmall: { bigSmall: { goals, over, under } }
  if (data.bigSmall && (data.bigSmall.over != null || data.bigSmall.under != null)) {
    const pt = data.bigSmall.goals != null ? parseFloat(data.bigSmall.goals) : null;
    if (data.bigSmall.over  != null) totalsOutcomes.push({ name: 'Over',  price: parseFloat(data.bigSmall.over),  point: pt });
    if (data.bigSmall.under != null) totalsOutcomes.push({ name: 'Under', price: parseFloat(data.bigSmall.under), point: pt });
  }
  // formato total: { total: { total, over, under } }
  if (data.total && totalsOutcomes.length === 0 && (data.total.over != null || data.total.under != null)) {
    const pt = data.total.total != null ? parseFloat(data.total.total) : null;
    if (data.total.over  != null) totalsOutcomes.push({ name: 'Over',  price: parseFloat(data.total.over),  point: pt });
    if (data.total.under != null) totalsOutcomes.push({ name: 'Under', price: parseFloat(data.total.under), point: pt });
  }

  // Nenhuma odd encontrada
  if (h2hOutcomes.length === 0 && spreadsOutcomes.length === 0 && totalsOutcomes.length === 0) {
    return null;
  }

  const markets = [];
  if (h2hOutcomes.length)    markets.push({ key: 'h2h',     outcomes: h2hOutcomes });
  if (spreadsOutcomes.length) markets.push({ key: 'spreads', outcomes: spreadsOutcomes });
  if (totalsOutcomes.length)  markets.push({ key: 'totals',  outcomes: totalsOutcomes });

  return {
    id:         String(game.matchId || ''),
    home_team:  game.homeName,
    away_team:  game.awayName,
    bookmakers: [{ key: 'isports', title: 'iSports', markets }],
    _source:    'isports',
  };
}

// ─── The Odds API com filtro Bet365 ───────────────────────
function oddsURL(path, params) {
  const qs = Object.entries({ apiKey: ODDS_KEY, ...params })
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `https://api.the-odds-api.com${path}?${qs}`;
}

// Prioridade de bookmakers (melhores odds para o apostador)
const BOOK_PRIORITY = ['bet365','draftkings','fanduel','betmgm','betrivers','unibet','pinnacle','williamhill'];

// ─── ActionNetwork (API pública, sem autenticação) ────────
// Retorna odds de DraftKings(15), FanDuel(30), BetMGM(76), Caesars(75), PointsBet(123)
async function fetchActionNetworkOdds(date) {
  const cacheKey = `actionnet_${date}`;
  const cached = getCache(cacheKey, 1800);
  if (cached && cached.length > 0) return cached;

  const url = `https://api.actionnetwork.com/web/v1/scoreboard/nba?period=game&bookIds=15,30,76,75,123&date=${date}`;
  let r;
  try {
    r = await fetchJSON(url, 10000);
  } catch(e) {
    console.warn(`[actionnet] ${e.message}`);
    return [];
  }
  if (r.status !== 200 || !r.body) return [];

  const games = r.body.games || [];
  const result = [];

  for (const g of games) {
    const homeName = g.home_team?.full_name || g.home_team?.abbr || '';
    const awayName = g.away_team?.full_name || g.away_team?.abbr || '';
    if (!homeName || !awayName) continue;

    const markets = [];
    // Pega as odds de cada livro disponível, prefere DraftKings (id=15) ou FanDuel (id=30)
    const books   = g.odds || [];
    const bookOrder = [15, 30, 76, 75, 123]; // DK, FD, BetMGM, Caesars, PB
    const book    = bookOrder.map(id => books.find(b => b.book_id === id)).find(Boolean) || books[0];
    if (!book) continue;

    // Moneyline (h2h)
    if (book.ml_home != null && book.ml_away != null) {
      const toDecimal = ml => ml > 0 ? +(ml/100 + 1).toFixed(3) : +(100/Math.abs(ml) + 1).toFixed(3);
      markets.push({ key: 'h2h', outcomes: [
        { name: homeName, price: toDecimal(book.ml_home) },
        { name: awayName, price: toDecimal(book.ml_away) },
      ]});
    }
    // Total (over/under)
    if (book.total != null && book.over != null) {
      const toDecimal = ml => ml > 0 ? +(ml/100 + 1).toFixed(3) : +(100/Math.abs(ml) + 1).toFixed(3);
      markets.push({ key: 'totals', outcomes: [
        { name: 'Over',  point: book.total, price: toDecimal(book.over)  },
        { name: 'Under', point: book.total, price: toDecimal(book.under || book.over) },
      ]});
    }
    // Spread
    if (book.spread_home != null && book.home_spread != null) {
      const toDecimal = ml => ml > 0 ? +(ml/100 + 1).toFixed(3) : +(100/Math.abs(ml) + 1).toFixed(3);
      markets.push({ key: 'spreads', outcomes: [
        { name: homeName, point:  book.home_spread,  price: toDecimal(book.spread_home) },
        { name: awayName, point: -book.home_spread,  price: toDecimal(book.spread_away || book.spread_home) },
      ]});
    }

    if (!markets.length) continue;
    result.push({
      home_team: homeName, away_team: awayName,
      bookmakers: [{ key: 'draftkings', title: 'DraftKings/FanDuel', markets }],
      _source: 'actionnetwork',
    });
  }

  if (result.length > 0) {
    setCache(cacheKey, result);
    console.log(`[actionnet] ${result.length} jogos com odds (DK/FD/BetMGM)`);
  }
  return result;
}

// ─── DraftKings API direta (pública, sem autenticação) ────
// NBA league 42648 | Game Lines category 583 | subcategory 4517
async function fetchDraftKingsOdds() {
  const cacheKey = 'dk_nba_odds';
  const cached = getCache(cacheKey, 1800);
  if (cached && cached.length > 0) return cached;

  const url = 'https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/42648/categories/583/subcategories/4517';
  let r;
  try {
    r = await fetchJSON(url, 12000);
  } catch(e) {
    console.warn(`[draftkings] ${e.message}`);
    return [];
  }
  if (r.status !== 200 || !r.body) return [];

  const evGroup    = r.body.eventGroup || {};
  const events     = evGroup.events || [];
  const categories = evGroup.offerCategories || [];

  // Mapa eventId → {home, away}
  const evMap = {};
  for (const ev of events) {
    if (ev.eventId) evMap[ev.eventId] = { home: ev.teamName1 || '', away: ev.teamName2 || '' };
  }

  // Mapa eventId → {h2h, spreads, totals}
  const offersMap = {};
  const amToDecimal = ml => {
    const m = parseFloat(ml);
    if (!m || m === 0) return null;
    return m > 0 ? +(m / 100 + 1).toFixed(3) : +(100 / Math.abs(m) + 1).toFixed(3);
  };

  for (const cat of categories) {
    for (const sub of (cat.offerSubcategoryDescriptors || [])) {
      for (const offerGroup of (sub.offerSubcategory?.offers || [])) {
        const group = Array.isArray(offerGroup) ? offerGroup : [offerGroup];
        for (const offer of group) {
          const eid  = offer.eventId;
          if (!eid || !evMap[eid]) continue;
          if (!offersMap[eid]) offersMap[eid] = {};

          const label    = (offer.label || '').toLowerCase();
          const outcomes = (offer.outcomes || []).filter(o => o.oddsDecimal || o.oddsAmerican);

          if (label.includes('moneyline') || label === 'money line') {
            offersMap[eid].h2h = outcomes.map(o => ({
              name:  o.label || '',
              price: parseFloat(o.oddsDecimal) || amToDecimal(o.oddsAmerican) || 0,
            })).filter(o => o.price > 1);

          } else if (label.includes('spread') || label.includes('point spread')) {
            offersMap[eid].spreads = outcomes.map(o => ({
              name:  o.label || '',
              price: parseFloat(o.oddsDecimal) || amToDecimal(o.oddsAmerican) || 0,
              point: parseFloat(o.line) || 0,
            })).filter(o => o.price > 1);

          } else if (label.includes('total')) {
            offersMap[eid].totals = outcomes.map(o => ({
              name:  o.label || '',    // 'Over' / 'Under'
              price: parseFloat(o.oddsDecimal) || amToDecimal(o.oddsAmerican) || 0,
              point: parseFloat(o.line) || 0,
            })).filter(o => o.price > 1);
          }
        }
      }
    }
  }

  const result = [];
  for (const [eid, teams] of Object.entries(evMap)) {
    if (!teams.home || !teams.away) continue;
    const offers  = offersMap[eid] || {};
    const markets = [];
    if ((offers.h2h     || []).length >= 2) markets.push({ key: 'h2h',     outcomes: offers.h2h });
    if ((offers.spreads || []).length >= 2) markets.push({ key: 'spreads', outcomes: offers.spreads });
    if ((offers.totals  || []).length >= 2) markets.push({ key: 'totals',  outcomes: offers.totals });
    if (!markets.length) continue;
    result.push({
      home_team: teams.home, away_team: teams.away,
      bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets }],
      _source: 'draftkings',
    });
  }

  if (result.length > 0) {
    setCache(cacheKey, result);
    console.log(`[draftkings] ${result.length} jogos com odds`);
  }
  return result;
}

// ─── FanDuel API direta (pública) ─────────────────────────
async function fetchFanDuelOdds() {
  const cacheKey = 'fd_nba_odds';
  const cached = getCache(cacheKey, 1800);
  if (cached && cached.length > 0) return cached;

  // FanDuel endpoint para NBA
  const url = 'https://sbapi.fanduel.com/v1/sports/nba/events?regionCode=US&_ak=FhMFpcPWXMeyZxOx&betTypes=money-line,asian-handicap,over-under&includePrice=true';
  let r;
  try {
    r = await fetchJSON(url, 12000);
  } catch(e) {
    console.warn(`[fanduel] ${e.message}`);
    return [];
  }
  if (r.status !== 200 || !r.body) return [];

  const events = r.body.attachments?.events
    ? Object.values(r.body.attachments.events)
    : (r.body.events || []);

  const markets = r.body.attachments?.markets
    ? Object.values(r.body.attachments.markets)
    : [];

  const result = [];

  for (const ev of events) {
    if (ev.eventType !== 'MATCH' && ev.eventTypeId) continue; // só partidas regulares
    const runners = ev.runners || [];
    const home = runners.find(rn => rn.runnerOrder === 1)?.runnerName || ev.homeTeam || '';
    const away = runners.find(rn => rn.runnerOrder === 2)?.runnerName || ev.awayTeam || '';
    if (!home || !away) continue;

    const evMarkets = markets.filter(m => m.eventId === ev.eventId);
    const mktList   = [];

    for (const mkt of evMarkets) {
      const mktType  = (mkt.marketType || mkt.bettingType || '').toLowerCase();
      const runners2 = mkt.runners || [];
      const toDecimal = price => {
        if (price > 10) return +(price / 100 + 1).toFixed(3); // american
        if (price >= 1) return +price.toFixed(3); // already decimal
        return null;
      };

      if (mktType.includes('money') || mktType.includes('win')) {
        const outs = runners2.map(rn => ({
          name: rn.runnerName || '',
          price: toDecimal(rn.lastPriceTraded || rn.handicap || 0),
        })).filter(o => o.price > 1);
        if (outs.length >= 2) mktList.push({ key: 'h2h', outcomes: outs });

      } else if (mktType.includes('handicap') || mktType.includes('spread')) {
        const outs = runners2.map(rn => ({
          name: rn.runnerName || '',
          price: toDecimal(rn.lastPriceTraded || 0),
          point: parseFloat(rn.handicap || 0),
        })).filter(o => o.price > 1);
        if (outs.length >= 2) mktList.push({ key: 'spreads', outcomes: outs });

      } else if (mktType.includes('total') || mktType.includes('over')) {
        const outs = runners2.map(rn => ({
          name:  rn.runnerName || '',
          price: toDecimal(rn.lastPriceTraded || 0),
          point: parseFloat(mkt.line || rn.handicap || 0),
        })).filter(o => o.price > 1);
        if (outs.length >= 2) mktList.push({ key: 'totals', outcomes: outs });
      }
    }

    if (!mktList.length) continue;
    result.push({
      home_team: home, away_team: away,
      bookmakers: [{ key: 'fanduel', title: 'FanDuel', markets: mktList }],
      _source: 'fanduel',
    });
  }

  if (result.length > 0) {
    setCache(cacheKey, result);
    console.log(`[fanduel] ${result.length} jogos com odds`);
  }
  return result;
}

async function fetchOddsWithBet365(sport = 'basketball_nba', regions = 'us,eu,uk', markets = 'h2h,totals,spreads') {
  const cacheKey = `odds_${sport}_${markets}`;
  const cached = getCache(cacheKey, 1800); // 30 min
  if (cached && cached.length > 0) return cached; // não usa cache vazio

  let r;
  try {
    r = await fetchJSON(oddsURL(`/v4/sports/${sport}/odds`, { regions, markets, oddsFormat: 'decimal' }));
  } catch(e) {
    console.error(`[odds] Erro na requisição: ${e.message}`);
    return [];
  }

  if (r.status !== 200) {
    console.error(`[odds] Status ${r.status} — resposta: ${JSON.stringify(r.body || r.raw || '').slice(0,200)}`);
    return [];
  }
  if (!Array.isArray(r.body)) {
    console.error(`[odds] Resposta não é array: ${JSON.stringify(r.body).slice(0,200)}`);
    return [];
  }
  if (r.body.length === 0) {
    console.warn(`[odds] Array vazio recebido (sem jogos na API para ${sport})`);
    return []; // não cacheamos vazio
  }

  // Para cada jogo: prefere Bet365, senão usa o melhor bookmaker disponível
  const result = r.body
    .map(game => {
      const books = game.bookmakers || [];
      if (!books.length) return null;
      // Escolhe Bet365 se disponível, senão o primeiro da lista de prioridade, senão qualquer um
      const chosen =
        books.find(b => b.key === 'bet365') ||
        BOOK_PRIORITY.map(k => books.find(b => b.key === k)).find(Boolean) ||
        books[0];
      return { ...game, bookmakers: [chosen], _bookmaker: chosen.key };
    })
    .filter(Boolean);

  setCache(cacheKey, result);
  console.log(`[odds] ${result.length} jogos com odds (regiões: us,eu,uk)`);
  return result;
}

// ─── Helpers ──────────────────────────────────────────────
function sendJSON(res, data, status=200) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

function extractList(body) {
  if(!body) return [];
  if(Array.isArray(body)) return body;
  if(Array.isArray(body.data)) return body.data;
  if(Array.isArray(body.list)) return body.list;
  if(typeof body === 'object') {
    const vals = Object.values(body);
    const arr = vals.find(v => Array.isArray(v));
    if(arr) return arr;
  }
  return [];
}

// ─── Whitelist dos 30 times da NBA ────────────────────────
const NBA_TEAM_KEYWORDS = new Set([
  'hawks','celtics','nets','hornets','bulls','cavaliers','cavs',
  'mavericks','mavs','nuggets','pistons','warriors','rockets','pacers',
  'clippers','lakers','grizzlies','heat','bucks','timberwolves','wolves',
  'pelicans','knicks','thunder','magic','76ers','sixers','suns',
  'blazers','kings','spurs','raptors','jazz','wizards',
]);
const NBA_TEAM_FULL = new Set([
  'atlanta hawks','boston celtics','brooklyn nets','charlotte hornets',
  'chicago bulls','cleveland cavaliers','dallas mavericks','denver nuggets',
  'detroit pistons','golden state warriors','houston rockets','indiana pacers',
  'la clippers','los angeles clippers','los angeles lakers','memphis grizzlies',
  'miami heat','milwaukee bucks','minnesota timberwolves','new orleans pelicans',
  'new york knicks','oklahoma city thunder','orlando magic','philadelphia 76ers',
  'phoenix suns','portland trail blazers','sacramento kings','san antonio spurs',
  'toronto raptors','utah jazz','washington wizards',
]);
// Abreviações de 2-4 letras usadas pelo iSports na API de stats (ex: LAL, GSW, BOS)
const NBA_TEAM_ABBR = new Set([
  'atl','bos','bkn','cha','chi','cle','dal','den','det','gsw',
  'hou','ind','lac','lal','mem','mia','mil','min','nop','nyk',
  'okc','orl','phi','phx','por','sac','sas','tor','uta','was',
  'njn','noo','nola','gs','sa','no','ny','la',
]);
function isNBATeam(name) {
  if (!name) return false;
  const n = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (NBA_TEAM_FULL.has(n)) return true;
  // Abreviação de 2-4 letras (LAL, GSW, etc.)
  if (n.length >= 2 && n.length <= 4 && NBA_TEAM_ABBR.has(n)) return true;
  const last = n.split(' ').pop();
  // >=2 chars para aceitar "76ers", "nets", etc.
  return last.length >= 2 && NBA_TEAM_KEYWORDS.has(last);
}

// Abreviação → nome completo (para normalizar stats do iSports antes de passar ao analytics)
const NBA_ABBR_FULL = {
  atl:'Atlanta Hawks',bos:'Boston Celtics',bkn:'Brooklyn Nets',njn:'Brooklyn Nets',
  cha:'Charlotte Hornets',chi:'Chicago Bulls',cle:'Cleveland Cavaliers',
  dal:'Dallas Mavericks',den:'Denver Nuggets',det:'Detroit Pistons',
  gsw:'Golden State Warriors',gs:'Golden State Warriors',
  hou:'Houston Rockets',ind:'Indiana Pacers',lac:'LA Clippers',
  lal:'Los Angeles Lakers',mem:'Memphis Grizzlies',mia:'Miami Heat',
  mil:'Milwaukee Bucks',min:'Minnesota Timberwolves',nop:'New Orleans Pelicans',
  noo:'New Orleans Pelicans',no:'New Orleans Pelicans',nola:'New Orleans Pelicans',
  nyk:'New York Knicks',ny:'New York Knicks',okc:'Oklahoma City Thunder',
  orl:'Orlando Magic',phi:'Philadelphia 76ers',phx:'Phoenix Suns',
  por:'Portland Trail Blazers',sac:'Sacramento Kings',sas:'San Antonio Spurs',
  sa:'San Antonio Spurs',tor:'Toronto Raptors',uta:'Utah Jazz',was:'Washington Wizards',
};
/** Normaliza nome de time: converte abreviações para nome completo */
function normalizeTeamName(name) {
  if (!name) return name;
  const k = name.toLowerCase().replace(/[^a-z]/g, '');
  return NBA_ABBR_FULL[k] || name;
}

function isNBA(m) {
  const lgName = (m.leagueName || m.league_name || '').toLowerCase().trim();
  const lid    = String(m.leagueId || m.league_id || '');

  // 1. Verifica pela liga
  if (lid === NBA_LEAGUE_ID || lgName === 'nba' || lgName.includes('national basketball association')) {
    return true;
  }
  // 2. Verifica se AMBOS os times são da NBA (lida com liga sem label)
  const home = m.homeTeamName || m.homeName || '';
  const away = m.awayTeamName || m.awayName || '';
  return isNBATeam(home) && isNBATeam(away);
}

// ========== NOVA LÓGICA DE ANÁLISE (reutilizada pelo bot) ==========
// (As funções de probabilidade, EV, Kelly foram movidas para analytics.js)
// Aqui no server apenas agregamos os dados brutos.
// ====================================================================

// ─── API Routes ───────────────────────────────────────────
async function handleAPI(pathname, query, res) {
  try {
    // Rota original /api/schedule
    if (pathname === '/api/schedule') {
      const date = query.date || new Date().toISOString().slice(0,10);
      const r = await iSportsFetch('/sport/basketball/schedule/basic', { date });
      const all = extractList(r.body);
      const nba = all.filter(isNBA);
      console.log(`[schedule] ${date}: ${all.length} total → ${nba.length} NBA`);
      return sendJSON(res, { ok: true, data: nba, date });
    }

    // /api/stats (igual)
    if (pathname === '/api/stats') {
      const date = query.date || new Date().toISOString().slice(0,10);
      const r = await iSportsFetch('/sport/basketball/stats', { date });
      return sendJSON(res, { ok: true, data: extractList(r.body) });
    }

    // /api/stats/match
    if (pathname === '/api/stats/match') {
      const { matchId } = query;
      if (!matchId) return sendJSON(res, { ok: false, error: 'matchId required' }, 400);
      const r = await iSportsFetch('/sport/basketball/stats', { matchId });
      return sendJSON(res, { ok: true, data: extractList(r.body) });
    }

    // /api/history (time)
    if (pathname === '/api/history') {
      const { teamId, days } = query;
      const results = [];
      const today = new Date();
      for (let i = 1; i <= Math.min(parseInt(days)||14, 30); i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = d.toISOString().slice(0,10);
        try {
          const r = await iSportsFetch('/sport/basketball/schedule/basic', { date: dateStr }, 8000);
          extractList(r.body).filter(isNBA).forEach(m => {
            const hid = String(m.homeId || m.homeTeamId || '');
            const aid = String(m.awayId || m.awayTeamId || '');
            if(hid === String(teamId) || aid === String(teamId)) results.push(m);
          });
          if(results.length >= 15) break;
        } catch(e) {}
      }
      return sendJSON(res, { ok: true, data: results });
    }

    // /api/player-history
    if (pathname === '/api/player-history') {
      const { playerId, days } = query;
      const results = [];
      const today = new Date();
      for (let i = 1; i <= Math.min(parseInt(days)||10, 20); i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = d.toISOString().slice(0,10);
        try {
          const r = await iSportsFetch('/sport/basketball/stats', { date: dateStr }, 8000);
          for (const match of extractList(r.body)) {
            const all = [...(match.homePlayers||[]), ...(match.awayPlayers||[])];
            const p = all.find(pl => String(pl.playerId) === String(playerId));
            if(p) results.push({ matchId: match.matchId, date: dateStr, ...p });
          }
          if(results.length >= 15) break;
        } catch(e) {}
      }
      return sendJSON(res, { ok: true, data: results });
    }

    // /api/odds – agora retorna apenas Bet365
    if (pathname === '/api/odds') {
      const sport = query.sport || 'basketball_nba';
      const odds = await fetchOddsWithBet365(sport);
      return sendJSON(res, { ok: true, data: odds });
    }

    // /api/player-props (mantém original, mas podemos filtrar Bet365 se existir)
    if (pathname === '/api/player-props') {
      const { eventId } = query;
      if (!eventId) return sendJSON(res, { ok: false, error: 'eventId required' }, 400);
      const r = await fetchJSON(oddsURL(
        `/v4/sports/basketball_nba/events/${eventId}/odds`,
        { regions: 'us', markets: 'player_points,player_rebounds,player_assists,player_threes', oddsFormat: 'decimal' }
      ));
      // Filtra Bet365 se disponível
      let data = r.body || {};
      if (data.bookmakers) {
        const bet365 = data.bookmakers.find(b => b.key === 'bet365');
        if (bet365) data.bookmakers = [bet365];
      }
      return sendJSON(res, { ok: true, data });
    }

    // /api/analysis – versão melhorada com odds Bet365 e mais informações
    if (pathname === '/api/analysis') {
      const date = query.date || new Date().toISOString().slice(0,10);
      const [statsRes, oddsData] = await Promise.allSettled([
        iSportsFetch('/sport/basketball/stats', { date }),
        fetchOddsWithBet365('basketball_nba'),
      ]);

      const statsData = statsRes.status === 'fulfilled' ? extractList(statsRes.value.body) : [];
      const odds = oddsData.status === 'fulfilled' ? oddsData.value : [];

      // Constrói schedule a partir dos stats (como já fazia)
      const schedule = statsData.map(m => ({
        matchId:    String(m.matchId || m.id || ''),
        homeId:     String(m.homeTeamId || m.homeId || ''),
        awayId:     String(m.awayTeamId || m.awayId || ''),
        homeName:   m.homeTeamName || m.homeName || 'Time A',
        awayName:   m.awayTeamName || m.awayName || 'Time B',
        homeScore:  m.homeScore,
        awayScore:  m.awayScore,
        status:     m.status != null ? m.status : -1,
        matchTime:  m.matchTime || m.startTime || null,
        location:   m.location || m.stadium || m.arena || '',
        leagueName: m.leagueName || 'NBA',
        leagueId:   String(m.leagueId || ''),
      })).filter(isNBA);

      console.log(`[analysis] ${date}: ${statsData.length} stats / ${schedule.length} NBA / ${odds.length} odds (Bet365)`);

      return sendJSON(res, {
        ok: true, schedule, stats: statsData, odds, date,
        _debug: { totalStats: statsData.length, nbaGames: schedule.length }
      });
    }

    // /api/recent-stats — stats dos últimos N dias (máx 7, cuida do limite de 200 req)
    if (pathname === '/api/recent-stats') {
      const days = Math.min(parseInt(query.days) || 5, 7);
      const combined = [];
      const today = new Date();
      for (let i = 1; i <= days; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        if (!reqCounter.canMake(1)) {
          console.warn(`[recent-stats] Limite próximo — parando em ${i-1} dias`);
          break;
        }
        try {
          const r = await iSportsFetch('/sport/basketball/stats', { date: dateStr }, 8000);
          combined.push(...extractList(r.body));
        } catch(e) { console.warn(`[recent-stats] ${dateStr}: ${e.message}`); }
      }
      return sendJSON(res, { ok: true, data: combined, days });
    }

    // /api/request-status — mostra uso do limite diário da iSports
    if (pathname === '/api/request-status') {
      return sendJSON(res, { ok: true, ...reqCounter.status() });
    }

    // /api/bot/daily — retorna entradas calculadas pelo analytics engine
    if (pathname === '/api/bot/daily') {
      const date = query.date || new Date().toISOString().slice(0,10);
      const analytics = require('./analytics.js');

      // Parâmetros de filtro (todos configuráveis pelo dashboard)
      const evMin         = parseFloat(query.minEV)          || 0.05;
      const oddMin        = parseFloat(query.minOdd)         || 1.72;
      const oddMax        = parseFloat(query.maxOdd)         || 3.50;
      const bankroll      = parseFloat(query.bankroll)       || 5000;
      const kellyFraction = parseFloat(query.kellyFraction)  || 0.20;
      const minProb       = parseFloat(query.minProb)        || 0.44;
      const maxProb       = parseFloat(query.maxProb)        || 0.80;
      const minGames      = parseInt(query.minGames)         || 0;
      const minConfidence = query.minConfidence              || 'baixo';

      // 1. Schedule de HOJE + histórico de stats (paralelo)
      const [schedRes, recentRes] = await Promise.allSettled([
        iSportsFetch('/sport/basketball/schedule/basic', { date }),
        (async () => {
          const arr = [];
          const maxDays = Math.min(parseInt(query.historyDays) || 20, 28);
          for (let i = 1; i <= maxDays; i++) {
            const d = new Date(date);
            d.setDate(d.getDate() - i);
            const ds = d.toISOString().slice(0, 10);
            if (!reqCounter.canMake(1)) {
              console.warn(`[bot/daily] Limite próximo — histórico parou em ${i-1} dias`);
              break;
            }
            try {
              // leagueId=155 pré-filtra NBA no servidor; isNBA é rede de segurança local
              const r = await iSportsFetch('/sport/basketball/stats', { date: ds, leagueId: NBA_LEAGUE_ID }, 8000);
              const games = extractList(r.body);
              const nba = games.filter(isNBA);
              // Se isNBA bloqueou tudo (ex: nomes abreviados sem leagueId no retorno),
              // usa jogos com placar real — provavelmente já são NBA (leagueId filtrou)
              const toAdd = nba.length > 0 ? nba : games.filter(g => {
                const hs = parseFloat(g.homeScore), as_ = parseFloat(g.awayScore);
                return !isNaN(hs) && !isNaN(as_) && (hs > 0 || as_ > 0);
              });
              // Normaliza abreviações → nome completo para match consistente com schedule
              arr.push(...toAdd.map(g => {
                const hn = normalizeTeamName(g.homeTeamName || g.homeName || '');
                const an = normalizeTeamName(g.awayTeamName || g.awayName || '');
                return { ...g, homeTeamName: hn, homeName: hn, awayTeamName: an, awayName: an };
              }));
            } catch(e) {}
          }
          return arr;
        })(),
      ]);

      const schedData  = schedRes.status  === 'fulfilled' ? extractList(schedRes.value.body) : [];
      const recentData = recentRes.status === 'fulfilled' ? recentRes.value : [];

      // Conta jogos únicos por time NBA para debug (recentData já filtrado por isNBA)
      const teamGameCounts = {};
      for (const g of recentData) {
        const h = g.homeTeamName || g.homeName || '';
        const a = g.awayTeamName || g.awayName || '';
        if (h) teamGameCounts[h] = (teamGameCounts[h] || 0) + 1;
        if (a) teamGameCounts[a] = (teamGameCounts[a] || 0) + 1;
      }
      const teamsWithMin10 = Object.values(teamGameCounts).filter(n => n >= 10).length;
      const avgGamesPerTeam = Object.keys(teamGameCounts).length
        ? Math.round(Object.values(teamGameCounts).reduce((s,n)=>s+n,0) / Object.keys(teamGameCounts).length)
        : 0;

      // Monta schedule com jogos NBA não iniciados (normaliza nomes para match com teamMap)
      const schedule = schedData.map(m => ({
        matchId:   String(m.matchId || m.id || ''),
        homeId:    String(m.homeTeamId || m.homeId || ''),
        awayId:    String(m.awayTeamId || m.awayId || ''),
        homeName:  normalizeTeamName(m.homeTeamName || m.homeName || '') || 'Time A',
        awayName:  normalizeTeamName(m.awayTeamName || m.awayName || '') || 'Time B',
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        status:    m.status != null ? m.status : -1,
        matchTime: m.matchTime || m.startTime || null,
        leagueName: m.leagueName || 'NBA',
        leagueId:  String(m.leagueId || ''),
      })).filter(isNBA);

      // 2. Busca odds do iSports para cada jogo de hoje (máx 12, paralelo)
      const isportsOddsMap = new Map(); // matchId → parsed odds
      if (schedule.length > 0) {
        const gamesForOdds = schedule.slice(0, 12);
        const isportsOddsResults = await Promise.allSettled(
          gamesForOdds.map(g => fetchISportsOddsForGame(g.matchId))
        );
        for (let i = 0; i < gamesForOdds.length; i++) {
          const res = isportsOddsResults[i];
          if (res.status === 'fulfilled' && res.value != null) {
            const parsed = parseISportsOdds(gamesForOdds[i], res.value);
            if (parsed) isportsOddsMap.set(gamesForOdds[i].matchId, parsed);
          }
        }
      }
      const isportsOddsGames = isportsOddsMap.size;
      console.log(`[bot/daily] iSports odds: ${isportsOddsGames}/${Math.min(schedule.length, 12)} jogos`);

      // 3. Fontes de odds externas (paralelas, nenhuma bloqueia)
      //    Prioridade: The Odds API > DraftKings > FanDuel > ActionNetwork > iSports
      let oddsApiData = [], dkData = [], fdData = [], actionNetData = [];
      await Promise.allSettled([
        fetchOddsWithBet365('basketball_nba').then(d => { oddsApiData = d; }).catch(() => {}),
        fetchDraftKingsOdds().then(d => { dkData = d; }).catch(() => {}),
        fetchFanDuelOdds().then(d => { fdData = d; }).catch(() => {}),
        fetchActionNetworkOdds(date).then(d => { actionNetData = d; }).catch(() => {}),
      ]);
      const oddsApiGames = oddsApiData.length;
      console.log(`[bot/daily] odds: OddsAPI=${oddsApiData.length} DK=${dkData.length} FD=${fdData.length} AN=${actionNetData.length} iSports=${isportsOddsGames}`);

      // 4. Mescla: prioridade The Odds API > DraftKings > FanDuel > ActionNetwork > iSports
      function makeOddsKey(home, away) {
        return `${(home||'').toLowerCase().replace(/[^a-z]/g,'')}__${(away||'').toLowerCase().replace(/[^a-z]/g,'')}`;
      }
      function buildTeamIndex(arr) {
        const m = new Map();
        for (const g of arr) {
          m.set(makeOddsKey(g.home_team, g.away_team), g);
          m.set(makeOddsKey(g.away_team, g.home_team), g);
        }
        return m;
      }
      // Índices por fonte (ordem crescente de prioridade)
      const byAN  = buildTeamIndex(actionNetData);
      const byFD  = buildTeamIndex(fdData);
      const byDK  = buildTeamIndex(dkData);
      const byAPI = buildTeamIndex(oddsApiData);

      const mergedOdds = [];
      const addedKeys  = new Set();

      const pickBest = (home, away) => {
        const k = makeOddsKey(home, away);
        return byAPI.get(k) || byDK.get(k) || byFD.get(k) || byAN.get(k);
      };

      // Começa pelos jogos do iSports (tem matchId garantido)
      for (const [, isportsOdd] of isportsOddsMap) {
        const best = pickBest(isportsOdd.home_team, isportsOdd.away_team) || isportsOdd;
        const k = makeOddsKey(best.home_team, best.away_team);
        if (!addedKeys.has(k)) { mergedOdds.push(best); addedKeys.add(k); }
      }
      // Adiciona jogos de fontes externas não cobertos pelo iSports
      for (const g of [...oddsApiData, ...dkData, ...fdData, ...actionNetData]) {
        const alreadyInMerged = mergedOdds.some(m =>
          m.home_team === g.home_team && m.away_team === g.away_team
        );
        if (!alreadyInMerged) mergedOdds.push(g);
      }

      const totalOddsGames = mergedOdds.length;

      // 5. Props de jogadores via The Odds API (máx 3 jogos, não bloqueia se falhar)
      const propsPerGame = [];
      const PROP_MARKETS = 'player_points,player_rebounds,player_assists,player_threes';
      let propsCount = 0;
      for (const game of oddsApiData.slice(0, 3)) {
        if (!game.id) continue;
        try {
          const r = await fetchJSON(oddsURL(
            `/v4/sports/basketball_nba/events/${game.id}/odds`,
            { regions: 'us,eu,uk', markets: PROP_MARKETS, oddsFormat: 'decimal' }
          ));
          if (r.status === 200 && r.body?.bookmakers?.length) {
            const books  = r.body.bookmakers;
            const chosen = books.find(b => b.key === 'bet365') ||
              BOOK_PRIORITY.map(k => books.find(b => b.key === k)).find(Boolean) ||
              books[0];
            propsPerGame.push({
              home_team: r.body.home_team || game.home_team,
              away_team: r.body.away_team || game.away_team,
              bookmakers: [chosen],
            });
            propsCount++;
          }
        } catch(e) {}
      }

      // Mescla props com odds gerais
      const oddsWithProps = mergedOdds.map(g => {
        const propGame = propsPerGame.find(p =>
          (p.home_team === g.home_team && p.away_team === g.away_team) ||
          (p.home_team === g.away_team && p.away_team === g.home_team)
        );
        if (!propGame) return g;
        const merged = { ...g };
        merged.bookmakers = (g.bookmakers || []).map(bk => ({
          ...bk,
          markets: [...(bk.markets || []), ...(propGame.bookmakers[0]?.markets || [])],
        }));
        return merged;
      });

      const cfg = {
        evMin, oddMin, oddMax, bankroll, kellyFraction,
        minProb, maxProb, minGames, minConfidence,
      };

      const entries = await analytics.generateAllEntries(
        { schedule, stats: recentData, odds: oddsWithProps },
        cfg
      );
      // analytics já filtra via _addEntry, mas aplicamos filtro duplo por segurança
      const filtered = entries.filter(e => e.ev >= evMin && e.odd >= oddMin && e.odd <= oddMax);

      console.log(`[bot/daily] ${date}: ${schedule.length} jogos NBA | isports=${isportsOddsGames} oddsApi=${oddsApiGames} total=${totalOddsGames} | ${propsCount} props | ${filtered.length} entradas | ${recentData.length} stats históricos | ${teamsWithMin10} times c/≥10 jogos`);

      // Top times por nº de jogos no teamMap — útil para verificar se os dados históricos estão corretos
      const sampleTeams = Object.entries(teamGameCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([t, n]) => `${t}:${n}`);

      return sendJSON(res, {
        ok: true, date,
        entries: filtered,
        total: filtered.length,
        debug: {
          scheduleGames:      schedule.length,
          oddsGames:          totalOddsGames,
          sources: {
            oddsApi:     oddsApiData.length,
            draftkings:  dkData.length,
            fanduel:     fdData.length,
            actionNet:   actionNetData.length,
            isports:     isportsOddsGames,
          },
          propsGames:         propsCount,
          historicalStats:    recentData.length,
          teamsWithMin10Games: teamsWithMin10,
          avgGamesPerTeam,
          daysOfHistory:      Math.min(parseInt(query.historyDays) || 20, 28),
          sampleTeams,
        },
        requestsUsed: reqCounter.status(),
      });
    }


    // /api/debug-schedule — mostra jogos do schedule com status, scores, times
    if (pathname === '/api/debug-schedule') {
      const date = query.date || new Date().toISOString().slice(0, 10);
      const r = await iSportsFetch('/sport/basketball/schedule/basic', { date });
      const all = extractList(r.body);
      const nba = all.filter(isNBA);
      const summary = nba.map(m => ({
        matchId:   m.matchId || m.id,
        home:      m.homeTeamName || m.homeName,
        away:      m.awayTeamName || m.awayName,
        status:    m.status,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        time:      m.matchTime || m.startTime,
        leagueId:  m.leagueId,
      }));
      return sendJSON(res, { ok: true, date, total: all.length, nba: nba.length, games: summary });
    }

    // /api/debug-odds — diagnóstico da The Odds API
    if (pathname === '/api/debug-odds') {
      const sport = query.sport || 'basketball_nba';
      try {
        const r = await fetchJSON(oddsURL(`/v4/sports/${sport}/odds`, {
          regions: 'us,eu,uk', markets: 'h2h,totals,spreads', oddsFormat: 'decimal',
        }));
        const games   = Array.isArray(r.body) ? r.body : [];
        const books   = [...new Set(games.flatMap(g => (g.bookmakers||[]).map(b => b.key)))];
        const hasBet365 = books.includes('bet365');
        return sendJSON(res, {
          ok: true,
          httpStatus: r.status,
          totalGames: games.length,
          bookmakers: books,
          hasBet365,
          firstGame: games[0] ? { home: games[0].home_team, away: games[0].away_team, books: games[0].bookmakers?.map(b=>b.key) } : null,
          raw: r.body === null ? r.raw : undefined,
        });
      } catch(e) {
        return sendJSON(res, { ok: false, error: e.message }, 500);
      }
    }

    // /api/debug-isports-odds — diagnóstico do endpoint de odds do iSports
    if (pathname === '/api/debug-isports-odds') {
      const date = query.date || new Date().toISOString().slice(0,10);
      try {
        // Busca o schedule de hoje para pegar o primeiro jogo
        const schedR = await iSportsFetch('/sport/basketball/schedule/basic', { date });
        const allGames = extractList(schedR.body);
        const nbaGames = allGames.filter(isNBA);
        if (!nbaGames.length) {
          return sendJSON(res, { ok: false, error: 'Nenhum jogo NBA encontrado hoje', date, total: allGames.length });
        }
        const firstGame = {
          matchId:  String(nbaGames[0].matchId || nbaGames[0].id || ''),
          homeName: nbaGames[0].homeTeamName || nbaGames[0].homeName || 'Time A',
          awayName: nbaGames[0].awayTeamName || nbaGames[0].awayName || 'Time B',
        };
        const rawOdds = await fetchISportsOddsForGame(firstGame.matchId);
        const parsed  = rawOdds ? parseISportsOdds(firstGame, rawOdds) : null;
        return sendJSON(res, {
          ok: true,
          date,
          game: firstGame,
          rawOdds,
          parsedOdds: parsed,
          nbaGamesTotal: nbaGames.length,
        });
      } catch(e) {
        return sendJSON(res, { ok: false, error: e.message }, 500);
      }
    }

    // /api/debug (mantido)
    if (pathname === '/api/debug') {
      const today     = new Date().toISOString().slice(0,10);
      const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
      const results   = {};
      for(const date of [today, yesterday]) {
        try {
          const r = await iSportsFetch('/sport/basketball/stats', { date }, 8000);
          const list = extractList(r.body);
          results[`stats_${date}`] = {
            count: list.length,
            firstGame: list[0] ? Object.keys(list[0]) : null,
          };
        } catch(e) { results[`stats_${date}`] = { error: e.message }; }
      }
      return sendJSON(res, { ok: true, results, requestStatus: reqCounter.status() });
    }

    sendJSON(res, { ok: false, error: 'Route not found: ' + pathname }, 404);
  } catch(e) {
    console.error('[API Error]', pathname, e.message);
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

// ─── Handler principal (local + Vercel) ───────────────────
async function requestHandler(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    return handleAPI(pathname, parsed.query, res);
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback: serve index.html para qualquer rota desconhecida (SPA)
      const idx = path.join(__dirname, 'index.html');
      fs.readFile(idx, (e2, html) => {
        if (e2) { res.writeHead(404, CORS_HEADERS); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', ...CORS_HEADERS });
    res.end(data);
  });
}

// ─── Modo local: inicia o servidor HTTP ───────────────────
if (require.main === module) {
  const server = require('http').createServer(requestHandler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🏀 NBA Analytics System rodando em http://localhost:${PORT}`);
    console.log('  ✅ Cache ativo (1h para iSports, 30min para odds)');
    console.log('  ✅ Odds filtradas exclusivamente pela Bet365');
    console.log('  ✅ Contador de requisições ativo (limite: 180/200 por dia)\n');
  });
}

// ─── Exporta handler para Vercel (serverless) ─────────────
module.exports = requestHandler;