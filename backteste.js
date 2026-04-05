// backtest.js - Simula apostas em datas passadas e calcula ROI
const { generateAllEntries } = require('./analytics.js');
const fs = require('fs');

// Configuração do backtest
const BACKTEST_CONFIG = {
  startDate: '2025-03-01', // Ajuste para uma data que tenha dados
  endDate: '2025-03-31',
  bankroll: 10000,
  kellyFraction: 0.25,
  evMin: 0.03,
  oddMin: 1.65,
};

// Função mock para obter dados históricos (substitua por chamadas reais à sua API)
// Como a API iSports pode não ter histórico ilimitado, este backtest é conceitual.
// Você precisaria armazenar resultados reais para comparar.
async function getHistoricalData(date) {
  // Aqui você chamaria seu backend com a data
  // Ex: fetch(`http://localhost:3000/api/analysis?date=${date}`)
  // Por enquanto, retorna vazio
  return { schedule: [], stats: [], odds: [] };
}

async function runBacktest() {
  console.log('Iniciando backtest...');
  let totalInvestido = 0;
  let totalRetorno = 0;
  let totalApostas = 0;
  let acertos = 0;

  // Percorre as datas
  let current = new Date(BACKTEST_CONFIG.startDate);
  const end = new Date(BACKTEST_CONFIG.endDate);
  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    console.log(`Processando ${dateStr}...`);

    // Obter dados do dia (simulado)
    const data = await getHistoricalData(dateStr);
    // Gerar entradas
    const entries = await generateAllEntries(data, BACKTEST_CONFIG);
    const bets = entries.filter(e => e.ev >= BACKTEST_CONFIG.evMin && e.odd >= BACKTEST_CONFIG.oddMin);

    // Para cada aposta, precisaríamos do resultado real (score final, player stats)
    // Isso exige um banco de dados de resultados. Exemplo conceitual:
    for (const bet of bets) {
      totalApostas++;
      const valorAposta = bet.valor_sugerido;
      totalInvestido += valorAposta;
      // Simular resultado (aqui você buscaria o resultado real)
      const ganhou = Math.random() < bet.prob; // apenas exemplo!
      if (ganhou) {
        totalRetorno += valorAposta * bet.odd;
        acertos++;
      }
    }
    current.setDate(current.getDate() + 1);
  }

  const lucro = totalRetorno - totalInvestido;
  const roi = (lucro / totalInvestido) * 100;
  const hitRate = (acertos / totalApostas) * 100;

  console.log('\n========== RESULTADO DO BACKTEST ==========');
  console.log(`Total de apostas: ${totalApostas}`);
  console.log(`Acertos: ${acertos} (${hitRate.toFixed(2)}%)`);
  console.log(`Total investido: R$ ${totalInvestido.toFixed(2)}`);
  console.log(`Total retorno: R$ ${totalRetorno.toFixed(2)}`);
  console.log(`Lucro: R$ ${lucro.toFixed(2)}`);
  console.log(`ROI: ${roi.toFixed(2)}%`);
}

runBacktest().catch(console.error);