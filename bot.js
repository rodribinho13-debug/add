/**
 * bot.js — Gerador de Palpites NBA
 *
 * Uso:
 *   node bot.js [YYYY-MM-DD]
 *
 * Gera relatório com as melhores apostas do dia baseado em:
 *   - Modelo estatístico (distribuição normal)
 *   - Expected Value (EV) > evMin
 *   - Critério de Kelly fracionado
 *   - Odds exclusivamente da Bet365
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { generateAllEntries } = require('./analytics.js');

// ─── Configuração ─────────────────────────────────────────────
const CONFIG = {
  bankroll:      5000,   // R$ disponível para apostas
  kellyFraction: 0.25,   // Fração de Kelly (25% = conservador)
  evMin:         0.03,   // EV mínimo de 3% para qualificar
  oddMin:        1.65,   // Odd mínima Bet365
  histDays:      5,      // Dias de histórico para médias (máx 5 para não estourar limite)
  usePoisson:    true,
};

// ─── HTTP helper ──────────────────────────────────────────────
function fetchAPI(endpoint, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:3000/api/${endpoint}`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON inválido: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Dados mock (fallback quando servidor não responde) ────────
function getMockData(date) {
  return {
    schedule: [
      {
        matchId: 'mock1', homeName: 'Boston Celtics', awayName: 'Miami Heat',
        homeScore: 0, awayScore: 0, status: -1,
        matchTime: Math.floor(new Date(date).getTime() / 1000), leagueName: 'NBA',
      },
      {
        matchId: 'mock2', homeName: 'Golden State Warriors', awayName: 'Los Angeles Lakers',
        homeScore: 0, awayScore: 0, status: -1,
        matchTime: Math.floor(new Date(date).getTime() / 1000), leagueName: 'NBA',
      },
    ],
    stats: [
      // Dados históricos recentes simulados para construção de médias
      { homeTeamName: 'Boston Celtics',       awayTeamName: 'New York Knicks',     homeScore: 118, awayScore: 105 },
      { homeTeamName: 'Boston Celtics',       awayTeamName: 'Philadelphia 76ers',  homeScore: 112, awayScore: 101 },
      { homeTeamName: 'Cleveland Cavaliers',  awayTeamName: 'Boston Celtics',      homeScore: 108, awayScore: 115 },
      { homeTeamName: 'Miami Heat',           awayTeamName: 'Charlotte Hornets',   homeScore: 104, awayScore:  99 },
      { homeTeamName: 'Miami Heat',           awayTeamName: 'Washington Wizards',  homeScore: 110, awayScore: 102 },
      { homeTeamName: 'Orlando Magic',        awayTeamName: 'Miami Heat',          homeScore:  98, awayScore: 106 },
      { homeTeamName: 'Golden State Warriors',awayTeamName: 'Sacramento Kings',    homeScore: 120, awayScore: 114 },
      { homeTeamName: 'Golden State Warriors',awayTeamName: 'Portland Trail Blazers', homeScore: 116, awayScore: 104 },
      { homeTeamName: 'Phoenix Suns',         awayTeamName: 'Golden State Warriors',  homeScore: 111, awayScore: 118 },
      { homeTeamName: 'Los Angeles Lakers',   awayTeamName: 'Dallas Mavericks',    homeScore: 115, awayScore: 112 },
      { homeTeamName: 'Los Angeles Lakers',   awayTeamName: 'San Antonio Spurs',   homeScore: 122, awayScore: 109 },
      { homeTeamName: 'Denver Nuggets',       awayTeamName: 'Los Angeles Lakers',  homeScore: 113, awayScore: 108 },
    ],
    odds: [
      {
        home_team: 'Boston Celtics', away_team: 'Miami Heat',
        bookmakers: [{ key: 'bet365', markets: [
          { key: 'totals',  outcomes: [{ name: 'Over',  point: 218.5, price: 1.87 }, { name: 'Under', point: 218.5, price: 1.95 }] },
          { key: 'spreads', outcomes: [{ name: 'Boston Celtics', point: -6.5, price: 1.90 }, { name: 'Miami Heat', point: 6.5, price: 1.91 }] },
          { key: 'h2h',     outcomes: [{ name: 'Boston Celtics', price: 1.60 }, { name: 'Miami Heat', price: 2.35 }] },
        ]}],
      },
      {
        home_team: 'Golden State Warriors', away_team: 'Los Angeles Lakers',
        bookmakers: [{ key: 'bet365', markets: [
          { key: 'totals',  outcomes: [{ name: 'Over',  point: 225.5, price: 1.92 }, { name: 'Under', point: 225.5, price: 1.89 }] },
          { key: 'spreads', outcomes: [{ name: 'Golden State Warriors', point: -3.5, price: 1.90 }, { name: 'Los Angeles Lakers', point: 3.5, price: 1.91 }] },
          { key: 'h2h',     outcomes: [{ name: 'Golden State Warriors', price: 1.75 }, { name: 'Los Angeles Lakers', price: 2.10 }] },
        ]}],
      },
    ],
  };
}

// ─── Busca stats históricos recentes ──────────────────────────
async function fetchRecentStats(days = 5) {
  try {
    const res = await fetchAPI(`recent-stats?days=${days}`, 15000);
    if (res.ok && Array.isArray(res.data)) return res.data;
  } catch(e) {
    console.warn(`⚠️  Não foi possível buscar stats históricos: ${e.message}`);
  }
  return [];
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log(`\n🏀  BOT NBA — Palpites para ${date}\n`);

  let analysis;
  let usingMock = false;

  // 1. Tenta buscar dados reais do backend
  try {
    analysis = await fetchAPI(`analysis?date=${date}`);
    if (!analysis.ok || !analysis.schedule || analysis.schedule.length === 0) {
      console.log('⚠️  API sem jogos para esta data. Usando dados mock de demonstração.');
      usingMock = true;
      analysis = getMockData(date);
    }
  } catch(err) {
    console.log(`⚠️  Backend inacessível (${err.message}). Usando dados mock.`);
    usingMock = true;
    analysis = getMockData(date);
  }

  const { schedule, stats = [], odds = [] } = analysis;

  if (!schedule || schedule.length === 0) {
    console.log('❌ Nenhum jogo encontrado.');
    return;
  }

  console.log(`📋 Jogos encontrados: ${schedule.length}`);
  console.log(`📊 Registros de stats: ${stats.length}`);
  console.log(`💹 Eventos com odds (Bet365): ${odds.length}\n`);

  // 2. Busca stats recentes para enriquecer o modelo (apenas se real)
  let recentStats = [];
  if (!usingMock) {
    recentStats = await fetchRecentStats(CONFIG.histDays);
    if (recentStats.length > 0)
      console.log(`📈 Stats históricos (${CONFIG.histDays} dias): ${recentStats.length} registros\n`);
  }

  // 3. Gera todas as entradas
  const allStats = [...stats, ...recentStats];
  const entries = await generateAllEntries(
    { schedule, stats: allStats, odds },
    CONFIG
  );

  // 4. Filtra por EV e odd mínimos
  const valid = entries.filter(e => e.ev >= CONFIG.evMin && e.odd >= CONFIG.oddMin);

  // 5. Monta relatório
  const lines = [];
  lines.push(`${'═'.repeat(60)}`);
  lines.push(`🏀  PALPITES NBA — ${date}`);
  lines.push(`${'═'.repeat(60)}`);
  lines.push(`💵  Bankroll: R$ ${CONFIG.bankroll.toLocaleString('pt-BR')} | Kelly: ${CONFIG.kellyFraction * 100}% | EV mín: ${CONFIG.evMin * 100}%`);
  if (usingMock) lines.push(`⚠️   ATENÇÃO: Usando dados MOCK (backend indisponível ou limite atingido)`);
  lines.push(`🔢  Apostas qualificadas: ${valid.length} de ${entries.length} analisadas\n`);

  if (valid.length === 0) {
    lines.push('⚠️  Nenhuma aposta com valor positivo encontrada para os parâmetros atuais.');
    lines.push('    Tente reduzir evMin ou oddMin, ou aguarde jogos com melhores linhas.\n');
  } else {
    // Agrupa por tipo para melhor leitura
    const byType = {};
    for (const e of valid) {
      const t = e.tipo || 'outros';
      if (!byType[t]) byType[t] = [];
      byType[t].push(e);
    }

    const typeLabels = {
      total:       '🏀 TOTAIS (Over/Under)',
      spread:      '📐 SPREADS (Handicap)',
      h2h:         '🥊 MONEYLINE (H2H)',
      player_prop: '⭐ PROPS DE JOGADORES',
      outros:      '📌 OUTROS',
    };

    let idx = 1;
    for (const [tipo, typeEntries] of Object.entries(byType)) {
      lines.push(`\n${typeLabels[tipo] || tipo.toUpperCase()}`);
      lines.push('─'.repeat(50));
      for (const e of typeEntries) {
        lines.push(`\n${idx++}. ${e.descricao}`);
        lines.push(`   📊 Média histórica: ${e.avg} | Linha: ${e.line} | Odd: ${e.odd}`);
        lines.push(`   📈 Probabilidade modelo: ${(e.prob * 100).toFixed(1)}% | EV: +${(e.ev * 100).toFixed(2)}%`);
        lines.push(`   💰 Kelly ${(e.kelly * 100).toFixed(1)}% → R$ ${Math.round(e.valor_sugerido).toLocaleString('pt-BR')}`);
        lines.push(`   ℹ️  ${e.detalhes}`);
      }
    }

    // Resumo financeiro
    const totalApostas = valid.reduce((s, e) => s + e.valor_sugerido, 0);
    lines.push(`\n${'═'.repeat(60)}`);
    lines.push(`💼  RESUMO FINANCEIRO`);
    lines.push(`${'─'.repeat(40)}`);
    lines.push(`   Total sugerido para apostar: R$ ${Math.round(totalApostas).toLocaleString('pt-BR')}`);
    lines.push(`   % do bankroll comprometido: ${((totalApostas / CONFIG.bankroll) * 100).toFixed(1)}%`);
    lines.push(`   Melhor EV: +${(valid[0].ev * 100).toFixed(2)}% — ${valid[0].descricao}`);
  }

  lines.push(`\n${'═'.repeat(60)}`);
  lines.push(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
  lines.push(`${'═'.repeat(60)}\n`);

  const output = lines.join('\n');
  console.log(output);

  // 6. Salva em arquivo
  const outDir = path.join(__dirname, 'palpites');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filename = path.join(outDir, `palpites_${date}.txt`);
  fs.writeFileSync(filename, output, 'utf8');
  console.log(`✅  Relatório salvo em: ${filename}`);
}

main().catch(err => {
  console.error('Erro fatal no bot:', err.message);
  process.exit(1);
});
