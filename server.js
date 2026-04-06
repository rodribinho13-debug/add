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
const ISPORTS_KEY   = process.env.ISPORTS_KEY   || 'dFAjm3gu69qBv2C';
const ODDS_KEY      = process.env.ODDS_KEY      || 'b4b5039610221eb1aefe86749712cbd3';
// =========================================================

const ISPORTS_HOST  = 'api.isportsapi.com';
const ISPORTS_HOST2 = 'api2.isportsapi.com';
const NBA_LEAGUE_ID = '155';

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

  try {
    const r = await fetchJSON(iSportsURL(ISPORTS_HOST, path, params), timeoutMs);
    if(r.status === 200 && r.body) {
      setCache(cacheKey, r);
      return r;
    }
    throw new Error('Status ' + r.status);
  } catch(e) {
    console.log(`[iSports] fallback api2 (${e.message})`);
    const r2 = await fetchJSON(iSportsURL(ISPORTS_HOST2, path, params), timeoutMs);
    if(r2.status === 200 && r2.body) setCache(cacheKey, r2);
    return r2;
  }
}

// ─── The Odds API com filtro Bet365 ───────────────────────
function oddsURL(path, params) {
  const qs = Object.entries({ apiKey: ODDS_KEY, ...params })
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `https://api.the-odds-api.com${path}?${qs}`;
}

async function fetchOddsWithBet365(sport = 'basketball_nba', regions = 'us', markets = 'h2h,totals,spreads') {
  const cacheKey = `odds_${sport}_${regions}_${markets}`;
  const cached = getCache(cacheKey, 1800); // 30 min
  if (cached) return cached;

  const r = await fetchJSON(oddsURL(`/v4/sports/${sport}/odds`, { regions, markets, oddsFormat: 'decimal' }));
  if (r.status !== 200 || !r.body) return [];

  // Filtra apenas bookmaker = 'bet365'
  const filtered = r.body
    .map(game => {
      const bet365 = game.bookmakers?.find(b => b.key === 'bet365');
      if (!bet365) return null;
      return { ...game, bookmakers: [bet365] };
    })
    .filter(Boolean);
  
  setCache(cacheKey, filtered);
  return filtered;
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

function isNBA(m) {
  const name = (m.leagueName || m.league_name || '').toLowerCase().trim();
  const lid  = String(m.leagueId || m.league_id || '');
  return lid === NBA_LEAGUE_ID
    || name === 'nba'
    || name.includes('national basketball association')
    || name.startsWith('nba');
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

    // 🆕 NOVO ENDPOINT /api/bot/daily – já retorna entradas calculadas
    if (pathname === '/api/bot/daily') {
      const date = query.date || new Date().toISOString().slice(0,10);
      // Importa dinamicamente o módulo de análise (evita duplicação de código)
      const analytics = require('./analytics.js');
      const analysisData = await analytics.prepareAnalysisData(date, this); // passa referência para fetch
      const entries = analytics.generateAllEntries(analysisData);
      const filtered = entries.filter(e => e.ev > (parseFloat(query.minEV) || 0.03) && e.odd >= (parseFloat(query.minOdd) || 1.65));
      return sendJSON(res, { ok: true, date, entries: filtered });
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
      return sendJSON(res, { ok: true, results });
    }

    sendJSON(res, { ok: false, error: 'Route not found: ' + pathname }, 404);
  } catch(e) {
    console.error('[API Error]', pathname, e.message);
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

// ─── Servidor estático + API ──────────────────────────────
// ─── Handler principal (local + Vercel) ───────────────────
async function requestHandler(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
  if (pathname.startsWith('/api/')) return handleAPI(pathname, parsed.query, res);
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify({ ok: true, service: 'NBA Analytics API', endpoints: ['/api/analysis','/api/odds','/api/schedule','/api/stats','/api/bot/daily'] }));
}

// Local: inicia servidor HTTP
if (require.main === module) {
  http.createServer(requestHandler).listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🏀 NBA Analytics System em http://localhost:${PORT}\n`);
  });
}

// Vercel: exporta handler
module.exports = requestHandler;
