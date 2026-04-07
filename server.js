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

// ─── The Odds API com filtro Bet365 ───────────────────────
function oddsURL(path, params) {
  const qs = Object.entries({ apiKey: ODDS_KEY, ...params })
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `https://api.the-odds-api.com${path}?${qs}`;
}

// Prioridade de bookmakers (melhores odds para o apostador)
const BOOK_PRIORITY = ['bet365','draftkings','fanduel','betmgm','betrivers','unibet','pinnacle','williamhill'];

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
function isNBATeam(name) {
  if (!name) return false;
  const n = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (NBA_TEAM_FULL.has(n)) return true;
  const last = n.split(' ').pop();
  return last.length > 3 && NBA_TEAM_KEYWORDS.has(last);
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

      // 1. Schedule de HOJE (jogos não iniciados)
      // 2. Stats dos últimos 10 dias (médias históricas dos times e jogadores)
      //    ~10 dias garante ≥10 jogos por time para confiança ALTA
      // 3. Odds gerais Bet365/melhor bookmaker disponível
      const [schedRes, oddsData, recentRes] = await Promise.allSettled([
        iSportsFetch('/sport/basketball/schedule/basic', { date }),
        fetchOddsWithBet365('basketball_nba'),
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
              const r = await iSportsFetch('/sport/basketball/stats', { date: ds }, 8000);
              arr.push(...extractList(r.body));
            } catch(e) {}
          }
          return arr;
        })(),
      ]);

      const schedData  = schedRes.status  === 'fulfilled' ? extractList(schedRes.value.body) : [];
      const odds       = oddsData.status  === 'fulfilled' ? oddsData.value : [];
      const recentData = recentRes.status === 'fulfilled' ? recentRes.value : [];

      // Conta jogos únicos por time para debug
      const teamGameCounts = {};
      for (const g of recentData) {
        const h = g.homeTeamName || g.homeName || '';
        const a = g.awayTeamName || g.awayName || '';
        if (h) teamGameCounts[h] = (teamGameCounts[h] || 0) + 1;
        if (a) teamGameCounts[a] = (teamGameCounts[a] || 0) + 1;
      }
      const teamsWithMin10 = Object.values(teamGameCounts).filter(n => n >= 10).length;

      // Monta schedule com jogos NBA não iniciados
      const schedule = schedData.map(m => ({
        matchId:   String(m.matchId || m.id || ''),
        homeId:    String(m.homeTeamId || m.homeId || ''),
        awayId:    String(m.awayTeamId || m.awayId || ''),
        homeName:  m.homeTeamName || m.homeName || 'Time A',
        awayName:  m.awayTeamName || m.awayName || 'Time B',
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        status:    m.status != null ? m.status : -1,
        matchTime: m.matchTime || m.startTime || null,
        leagueName: m.leagueName || 'NBA',
        leagueId:  String(m.leagueId || ''),
      })).filter(isNBA);

      // 4. Props de jogadores (máx 3 jogos para economizar quota)
      const propsPerGame = [];
      const PROP_MARKETS = 'player_points,player_rebounds,player_assists,player_threes';
      let propsCount = 0;
      for (const game of odds.slice(0, 3)) {
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
      const oddsWithProps = odds.map(g => {
        const propGame = propsPerGame.find(p =>
          (p.home_team === g.home_team && p.away_team === g.away_team) ||
          (p.home_team === g.away_team && p.away_team === g.home_team)
        );
        if (!propGame) return g;
        const merged = { ...g };
        merged.bookmakers = g.bookmakers.map(bk => ({
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

      console.log(`[bot/daily] ${date}: ${schedule.length} jogos NBA | ${odds.length} odds | ${propsCount} props | ${filtered.length} entradas | ${recentData.length} stats históricos | ${teamsWithMin10} times c/≥10 jogos`);

      return sendJSON(res, {
        ok: true, date,
        entries: filtered,
        total: filtered.length,
        debug: {
          scheduleGames:    schedule.length,
          oddsGames:        odds.length,
          propsGames:       propsCount,
          historicalStats:  recentData.length,
          teamsWithMin10Games: teamsWithMin10,
          daysOfHistory:    Math.min(parseInt(query.historyDays) || 10, 14),
        },
        requestsUsed: reqCounter.status(),
      });
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