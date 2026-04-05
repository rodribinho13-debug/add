// bot.js - Com fallback mock para quando API atinge limite
const fs = require('fs');
const path = require('path');
const { generateAllEntries } = require('./analytics.js');

const CONFIG = {
  bankroll: 5000,
  kellyFraction: 0.25,
  evMin: 0.03,
  oddMin: 1.65,
  histDays: 10,
  usePoisson: true,
};

async function fetchFromAPI(endpoint) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:3000/api/${endpoint}`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Dados mock para quando a API não retorna dados (limite excedido)
function getMockData(date) {
  return {
    schedule: [
      {
        matchId: 'mock1',
        homeTeamId: '1',
        awayTeamId: '2',
        homeName: 'Boston Celtics',
        awayName: 'Miami Heat',
        homeScore: 0,
        awayScore: 0,
        status: 0,
        matchTime: Math.floor(new Date(date).getTime() / 1000),
        location: 'TD Garden',
        leagueName: 'NBA'
      },
      {
        matchId: 'mock2',
        homeTeamId: '3',
        awayTeamId: '4',
        homeName: 'Golden State Warriors',
        awayName: 'Los Angeles Lakers',
        homeScore: 0,
        awayScore: 0,
        status: 0,
        matchTime: Math.floor(new Date(date).getTime() / 1000),
        location: 'Chase Center',
        leagueName: 'NBA'
      }
    ],
    stats: [
      {
        matchId: 'mock1',
        homeTeamName: 'Boston Celtics',
        awayTeamName: 'Miami Heat',
        homeScore: 112,
        awayScore: 98,
        homePlayers: [
          { playerId: 'p1', playerName: 'Jayson Tatum', score: 28, attack: 2, defend: 6, assist: 5, threePointHit: 3 },
          { playerId: 'p2', playerName: 'Jaylen Brown', score: 22, attack: 1, defend: 5, assist: 3, threePointHit: 2 }
        ],
        awayPlayers: [
          { playerId: 'p3', playerName: 'Bam Adebayo', score: 24, attack: 4, defend: 10, assist: 4, threePointHit: 0 }
        ]
      },
      {
        matchId: 'mock2',
        homeTeamName: 'Golden State Warriors',
        awayTeamName: 'Los Angeles Lakers',
        homeScore: 115,
        awayScore: 110,
        homePlayers: [
          { playerId: 'p4', playerName: 'Stephen Curry', score: 32, attack: 0, defend: 3, assist: 6, threePointHit: 6 },
          { playerId: 'p5', playerName: 'Klay Thompson', score: 18, attack: 1, defend: 2, assist: 2, threePointHit: 4 }
        ],
        awayPlayers: [
          { playerId: 'p6', playerName: 'LeBron James', score: 25, attack: 2, defend: 7, assist: 8, threePointHit: 2 }
        ]
      }
    ],
    odds: [
      {
        home_team: 'Boston Celtics',
        away_team: 'Miami Heat',
        bookmakers: [{
          key: 'bet365',
          markets: [
            { key: 'totals', outcomes: [{ name: 'Over', point: 220.5 }] },
            { key: 'spreads', outcomes: [{ name: 'Boston Celtics', point: -5.5 }] },
            { key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: 1.65 }, { name: 'Miami Heat', price: 2.30 }] }
          ]
        }]
      },
      {
        home_team: 'Golden State Warriors',
        away_team: 'Los Angeles Lakers',
        bookmakers: [{
          key: 'bet365',
          markets: [
            { key: 'totals', outcomes: [{ name: 'Over', point: 228.5 }] },
            { key: 'spreads', outcomes: [{ name: 'Golden State Warriors', point: -3.5 }] },
            { key: 'h2h', outcomes: [{ name: 'Golden State Warriors', price: 1.75 }, { name: 'Los Angeles Lakers', price: 2.10 }] }
          ]
        }]
      }
    ]
  };
}

async function fetchHistories(games, days) {
  const teamHistories = {};
  const playerHistories = {};
  // Para mock, retornamos históricos vazios (o modelo usará valores padrão)
  return { teamHistories, playerHistories };
}

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log(`\n🏀 BOT NBA - Gerando palpites para ${date}\n`);

  let analysis;
  let usingMock = false;

  try {
    analysis = await fetchFromAPI(`analysis?date=${date}`);
    if (!analysis.schedule || analysis.schedule.length === 0) {
      console.log('⚠️ API retornou sem jogos. Usando dados mock para demonstração.');
      usingMock = true;
      analysis = getMockData(date);
    }
  } catch (err) {
    console.log(`⚠️ Erro ao conectar com backend (${err.message}). Usando dados mock.`);
    usingMock = true;
    analysis = getMockData(date);
  }

  const { schedule, stats, odds } = analysis;

  if (!schedule || schedule.length === 0) {
    console.log('❌ Nenhum jogo encontrado para esta data (nem na API nem no mock).');
    return;
  }

  const { teamHistories, playerHistories } = await fetchHistories(schedule, CONFIG.histDays);

  const entries = await generateAllEntries(
    { schedule, stats, odds, teamHistories, playerHistories },
    CONFIG
  );

  const valid = entries.filter(e => e.ev >= CONFIG.evMin && e.odd >= CONFIG.oddMin);

  const reportLines = [];
  reportLines.push(`📅 RELATÓRIO DE PALPITES - ${date}`);
  reportLines.push(`💵 Bankroll: R$ ${CONFIG.bankroll} | Kelly: ${CONFIG.kellyFraction * 100}% | EV mínimo: ${CONFIG.evMin * 100}%`);
  if (usingMock) reportLines.push(`⚠️ USANDO DADOS MOCK (limite da API atingido)`);
  reportLines.push(`🔢 Total de entradas com valor: ${valid.length}\n`);

  if (valid.length === 0) {
    reportLines.push('⚠️ Nenhuma aposta qualificada encontrada para os parâmetros atuais.');
  } else {
    valid.forEach((e, idx) => {
      reportLines.push(`${idx + 1}. ${e.descricao}`);
      reportLines.push(`   📊 Média: ${e.avg} | Linha: ${e.line} | Odd: ${e.odd}`);
      reportLines.push(`   📈 Probabilidade modelo: ${(e.prob * 100).toFixed(1)}% | EV: +${(e.ev * 100).toFixed(2)}%`);
      reportLines.push(`   💰 Kelly: ${(e.kelly * 100).toFixed(1)}% do bankroll → R$ ${Math.round(e.valor_sugerido)}`);
      reportLines.push(`   ℹ️  ${e.detalhes}\n`);
    });
  }

  const output = reportLines.join('\n');
  console.log(output);

  const outDir = path.join(__dirname, 'palpites');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const filename = path.join(outDir, `palpites_${date}.txt`);
  fs.writeFileSync(filename, output);
  console.log(`\n✅ Relatório salvo em: ${filename}`);
}

main().catch(console.error);