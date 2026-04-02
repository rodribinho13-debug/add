/**
 * NBA Analytics System — Backend Proxy
 * 
 * COMO USAR:
 *   1. node server.js
 *   2. Abra http://localhost:3000 no browser
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = 3000;

const ISPORTS_KEY   = 'dFAjm3gu69q7Bv2C';
const ODDS_KEY      = 'b4b5039610221eb1aefe86749712cbd3';
const ISPORTS_HOST  = 'api.isportsapi.com';
const ISPORTS_HOST2 = 'api2.isportsapi.com';
const NBA_LEAGUE_ID = '155';

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

// ─── HTTP/HTTPS fetch ─────────────────────────────────────────────────────
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

// ─── iSports helpers ──────────────────────────────────────────────────────
// IMPORTANTE: iSports so aceita UM parametro por vez: date OU leagueId OU matchId
function iSportsURL(host, path, params) {
  const qs = Object.entries({ api_key: ISPORTS_KEY, ...params })
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `http://${host}${path}?${qs}`;
}

async function iSportsFetch(path, params, timeoutMs=12000) {
  try {
    const r = await fetchJSON(iSportsURL(ISPORTS_HOST, path, params), timeoutMs);
    if(r.status === 200 && r.body) return r;
    throw new Error('Status ' + r.status);
  } catch(e) {
    console.log(`[iSports] fallback api2 (${e.message})`);
    return fetchJSON(iSportsURL(ISPORTS_HOST2, path, params), timeoutMs);
  }
}

// ─── The Odds API ─────────────────────────────────────────────────────────
function oddsURL(path, params) {
  const qs = Object.entries({ apiKey: ODDS_KEY, ...params })
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `https://api.the-odds-api.com${path}?${qs}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
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

// Filtra NBA — sem leagueId no request, filtra pelo nome depois
function isNBA(m) {
  const name = (m.leagueName || m.league_name || '').toLowerCase().trim();
  const lid  = String(m.leagueId || m.league_id || '');
  return lid === NBA_LEAGUE_ID
    || name === 'nba'
    || name.includes('national basketball association')
    || name.startsWith('nba');
}

// ─── API Routes ───────────────────────────────────────────────────────────
async function handleAPI(pathname, query, res) {
  try {

    // /api/schedule?date=YYYY-MM-DD
    if (pathname === '/api/schedule') {
      const date = query.date || new Date().toISOString().slice(0,10);
      const r = await iSportsFetch('/sport/basketball/schedule/basic', { date });
      const all = extractList(r.body);
      const nba = all.filter(isNBA);
      console.log(`[schedule] ${date}: ${all.length} total → ${nba.length} NBA`);
      if(nba.length === 0 && all.length > 0)
        console.log('[leagues sample]', [...new Set(all.slice(0,10).map(m=>m.leagueName||m.leagueId))]);
      return sendJSON(res, { ok: true, data: nba, date, _total: all.length });
    }

    // /api/stats?date=YYYY-MM-DD
    if (pathname === '/api/stats') {
      const date = query.date || new Date().toISOString().slice(0,10);
      const r = await iSportsFetch('/sport/basketball/stats', { date });
      return sendJSON(res, { ok: true, data: extractList(r.body) });
    }

    // /api/stats/match?matchId=xxx
    if (pathname === '/api/stats/match') {
      const { matchId } = query;
      if (!matchId) return sendJSON(res, { ok: false, error: 'matchId required' }, 400);
      const r = await iSportsFetch('/sport/basketball/stats', { matchId });
      return sendJSON(res, { ok: true, data: extractList(r.body) });
    }

    // /api/history?teamId=xxx&days=14
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

    // /api/player-history?playerId=xxx&days=10
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

    // /api/odds
    if (pathname === '/api/odds') {
      const sport   = query.sport   || 'basketball_nba';
      const region  = query.region  || 'us';
      const markets = query.markets || 'h2h,totals,spreads';
      const r = await fetchJSON(oddsURL(`/v4/sports/${sport}/odds`, { regions: region, markets, oddsFormat: 'decimal' }));
      return sendJSON(res, { ok: true, data: r.body || [] });
    }

    // /api/player-props?eventId=xxx
    if (pathname === '/api/player-props') {
      const { eventId } = query;
      if (!eventId) return sendJSON(res, { ok: false, error: 'eventId required' }, 400);
      const r = await fetchJSON(oddsURL(
        `/v4/sports/basketball_nba/events/${eventId}/odds`,
        { regions: 'us', markets: 'player_points,player_rebounds,player_assists,player_threes', oddsFormat: 'decimal' }
      ));
      return sendJSON(res, { ok: true, data: r.body || {} });
    }

    // /api/analysis?date=YYYY-MM-DD  (usa stats como fonte principal de jogos)
    if (pathname === '/api/analysis') {
      const date = query.date || new Date().toISOString().slice(0,10);

      // Só chama stats + odds (schedule não está disponível no plano)
      const [statsRes, oddsRes] = await Promise.allSettled([
        iSportsFetch('/sport/basketball/stats', { date }),
        fetchJSON(oddsURL('/v4/sports/basketball_nba/odds', {
          regions: 'us', markets: 'h2h,totals,spreads', oddsFormat: 'decimal'
        })),
      ]);

      const statsData = statsRes.status==='fulfilled' ? extractList(statsRes.value.body) : [];
      const odds      = oddsRes.status==='fulfilled'  ? (oddsRes.value.body || []) : [];

      // Constrói o schedule a partir dos stats
      // stats já contém homeTeamName, awayTeamName, scores, players, etc.
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
      }));

      const nbaSched = schedule.filter(isNBA);

      console.log(`[analysis] ${date}: ${statsData.length} stats / ${nbaSched.length} NBA / ${Array.isArray(odds)?odds.length:0} odds`);

      return sendJSON(res, {
        ok: true, schedule: nbaSched, stats: statsData, odds, date,
        _debug: {
          totalStats: statsData.length, nbaGames: nbaSched.length,
          sampleLeagues: [...new Set(statsData.slice(0,5).map(m=>m.leagueName||m.leagueId))],
          statsBodyKeys: statsRes.status==='fulfilled' ? Object.keys(statsRes.value.body||{}) : [],
        },
        errors: {
          stats: statsRes.status==='rejected' ? statsRes.reason?.message : null,
          odds:  oddsRes.status==='rejected'  ? oddsRes.reason?.message  : null,
        }
      });
    }

    // /api/debug  — mostra estrutura real dos stats
    if (pathname === '/api/debug') {
      const today     = new Date().toISOString().slice(0,10);
      const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
      const results   = {};

      // Stats de hoje e ontem
      for(const date of [today, yesterday]) {
        try {
          const r = await iSportsFetch('/sport/basketball/stats', { date }, 8000);
          const list = extractList(r.body);
          results[`stats_${date}`] = {
            status: r.status, count: list.length,
            bodyKeys: r.body ? Object.keys(r.body) : [],
            // Mostra campos do primeiro jogo para mapear
            firstGame: list[0] ? {
              keys: Object.keys(list[0]),
              homeTeamName: list[0].homeTeamName,
              homeName:     list[0].homeName,
              leagueName:   list[0].leagueName,
              leagueId:     list[0].leagueId,
              status:       list[0].status,
              matchId:      list[0].matchId,
            } : null,
          };
        } catch(e) { results[`stats_${date}`] = { error: e.message }; }
      }

      return sendJSON(res, { ok: true, today, yesterday, results });
    }

    sendJSON(res, { ok: false, error: 'Route not found: ' + pathname }, 404);

  } catch(e) {
    console.error('[API Error]', pathname, e.message);
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

// ─── Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
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
    if (err) { res.writeHead(404, CORS_HEADERS); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', ...CORS_HEADERS });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   🏀 NBA Analytics System — Backend      ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║   http://localhost:${PORT}                   ║`);
  console.log('  ║                                          ║');
  console.log('  ║   ✓ iSports  (HTTP, api_key, por date)  ║');
  console.log('  ║   ✓ Odds API (HTTPS)                     ║');
  console.log('  ║   ✓ CORS liberado                        ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  Ctrl+C para parar.');
  console.log('');
});

server.on('error', e => {
  if(e.code === 'EADDRINUSE') {
    console.error(`\n  Porta ${PORT} em uso. Feche o outro processo.\n`);
  } else {
    console.error('\n  Erro:', e.message);
  }
  process.exit(1);
});
