/**
 * backteste.js — Simulação de Apostas em Datas Passadas
 *
 * Calcula ROI usando dados reais da API para o período especificado.
 * ATENÇÃO: Consome requisições da API — ajuste o período para não exceder 200/dia.
 *
 * Uso:
 *   node backteste.js [startDate] [endDate]
 *   Exemplo: node backteste.js 2025-03-01 2025-03-10
 */

'use strict';

const http = require('http');
const { generateAllEntries } = require('./analytics.js');

const BACKTEST_CONFIG = {
  startDate:     process.argv[2] || '2025-03-01',
  endDate:       process.argv[3] || '2025-03-07',  // padrão: 1 semana (7 req iSports)
  bankroll:      10000,
  kellyFraction: 0.25,
  evMin:         0.03,
  oddMin:        1.65,
};

// Máximo de dias para não estourar o limite de 200 req/dia
const MAX_DAYS = 15;

function fetchAPI(endpoint, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:3000/api/${endpoint}`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON inválido')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/** Busca dados reais de um dia do backend */
async function getDataForDate(dateStr) {
  try {
    const res = await fetchAPI(`analysis?date=${dateStr}`);
    if (!res.ok) return null;

    const schedule = (res.schedule || []).filter(g => {
      // Só jogos finalizados têm score real
      const hs = parseFloat(g.homeScore);
      const as_ = parseFloat(g.awayScore);
      return !isNaN(hs) && !isNaN(as_) && (hs > 0 || as_ > 0);
    });

    return {
      schedule,
      stats:    res.stats    || [],
      odds:     res.odds     || [],
      results:  schedule,   // results = schedule pois inclui scores finais
    };
  } catch(e) {
    console.warn(`  [${dateStr}] Erro ao buscar dados: ${e.message}`);
    return null;
  }
}

/** Verifica se uma aposta ganhou com base no resultado real do jogo */
function checkResult(bet, results) {
  const game = results.find(g => {
    const homeName = g.homeName || g.homeTeamName || '';
    const awayName = g.awayName || g.awayTeamName || '';
    const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
    const betDesc = norm(bet.descricao);
    return betDesc.includes(norm(homeName.split(' ').pop())) ||
           betDesc.includes(norm(awayName.split(' ').pop()));
  });

  if (!game) return null; // resultado não encontrado

  const homeScore = parseFloat(game.homeScore) || 0;
  const awayScore = parseFloat(game.awayScore) || 0;
  const total     = homeScore + awayScore;
  const margin    = homeScore - awayScore;
  const desc      = bet.descricao.toLowerCase();

  switch (bet.tipo) {
    case 'total':
      if (/over/i.test(desc))  return total > bet.line;
      if (/under/i.test(desc)) return total < bet.line;
      return null;

    case 'spread': {
      // Se home team no desc
      const homeName = (game.homeName || game.homeTeamName || '').toLowerCase();
      if (desc.includes(homeName.split(' ').pop())) {
        return margin > bet.line; // home covers spread
      }
      return margin < -bet.line; // away covers
    }

    case 'h2h': {
      const homeName = (game.homeName || game.homeTeamName || '').toLowerCase();
      if (desc.includes(homeName.split(' ').pop())) {
        return homeScore > awayScore;
      }
      return awayScore > homeScore;
    }

    case 'player_prop':
      // Sem dados de stats de jogadores no resultado — não podemos verificar
      return null;

    default:
      return null;
  }
}

async function runBacktest() {
  const start = new Date(BACKTEST_CONFIG.startDate);
  const end   = new Date(BACKTEST_CONFIG.endDate);

  const diffDays = Math.ceil((end - start) / 86400000) + 1;
  if (diffDays > MAX_DAYS) {
    console.error(`❌ Período muito longo (${diffDays} dias). Máximo: ${MAX_DAYS} dias para preservar limite de API.`);
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(55));
  console.log('📊  BACKTEST NBA');
  console.log('═'.repeat(55));
  console.log(`Período  : ${BACKTEST_CONFIG.startDate} → ${BACKTEST_CONFIG.endDate} (${diffDays} dias)`);
  console.log(`Bankroll : R$ ${BACKTEST_CONFIG.bankroll.toLocaleString('pt-BR')}`);
  console.log(`EV mín   : ${BACKTEST_CONFIG.evMin * 100}% | Odd mín: ${BACKTEST_CONFIG.oddMin}`);
  console.log('─'.repeat(55) + '\n');

  let bankroll       = BACKTEST_CONFIG.bankroll;
  let totalApostas   = 0;
  let totalInvestido = 0;
  let totalRetorno   = 0;
  let acertos        = 0;
  let semResultado   = 0;
  const diario       = [];

  let current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    process.stdout.write(`  ${dateStr}: `);

    const data = await getDataForDate(dateStr);
    if (!data || data.schedule.length === 0) {
      console.log('sem jogos');
      current.setDate(current.getDate() + 1);
      continue;
    }

    const entries = await generateAllEntries(data, BACKTEST_CONFIG);
    const bets    = entries.filter(e => e.ev >= BACKTEST_CONFIG.evMin && e.odd >= BACKTEST_CONFIG.oddMin);

    let diaInvestido = 0, diaRetorno = 0, diaAcertos = 0;

    for (const bet of bets) {
      // Recalcula valor com bankroll atual
      const valor    = bet.kelly * bankroll;
      const ganhou   = checkResult(bet, data.results);

      if (ganhou === null) {
        semResultado++;
        continue; // Pula props de jogadores sem resultado verificável
      }

      totalApostas++;
      totalInvestido += valor;
      diaInvestido   += valor;

      if (ganhou) {
        const retorno  = valor * bet.odd;
        totalRetorno  += retorno;
        diaRetorno    += retorno;
        bankroll      += retorno - valor;
        acertos++;
        diaAcertos++;
      } else {
        bankroll -= valor;
      }
    }

    if (bets.length > 0) {
      const diaLucro = diaRetorno - diaInvestido;
      console.log(`${bets.length} apostas | ${diaAcertos} acertos | Saldo dia: ${diaLucro >= 0 ? '+' : ''}R$ ${Math.round(diaLucro).toLocaleString('pt-BR')}`);
    } else {
      console.log('nenhuma aposta qualificada');
    }

    diario.push({ date: dateStr, bets: bets.length, acertos: diaAcertos, bankroll });
    current.setDate(current.getDate() + 1);

    // Pequeno delay para não sobrecarregar a API
    await new Promise(r => setTimeout(r, 200));
  }

  const lucro  = totalRetorno - totalInvestido;
  const roi    = totalInvestido > 0 ? (lucro / totalInvestido) * 100 : 0;
  const hitRate = totalApostas   > 0 ? (acertos / totalApostas) * 100 : 0;

  console.log('\n' + '═'.repeat(55));
  console.log('📈  RESULTADO DO BACKTEST');
  console.log('─'.repeat(55));
  console.log(`Total de apostas  : ${totalApostas} (+ ${semResultado} sem resultado verificável)`);
  console.log(`Acertos           : ${acertos} (${hitRate.toFixed(1)}%)`);
  console.log(`Total investido   : R$ ${Math.round(totalInvestido).toLocaleString('pt-BR')}`);
  console.log(`Total retorno     : R$ ${Math.round(totalRetorno).toLocaleString('pt-BR')}`);
  console.log(`Lucro/Prejuízo    : R$ ${Math.round(lucro).toLocaleString('pt-BR')} (${lucro >= 0 ? '+' : ''}${roi.toFixed(2)}% ROI)`);
  console.log(`Bankroll final    : R$ ${Math.round(bankroll).toLocaleString('pt-BR')}`);
  console.log('═'.repeat(55) + '\n');
}

runBacktest().catch(err => {
  console.error('Erro no backtest:', err.message);
  console.error('Certifique-se que o servidor está rodando: node server.js');
  process.exit(1);
});
