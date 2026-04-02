# 🏀 NBA Analytics System

Sistema de análise de linhas NBA com iSports API + The Odds API.

## Como rodar

### Pré-requisito
- Node.js 16+ instalado → https://nodejs.org

### Passos

1. **Extraia** a pasta `nba_system` em qualquer lugar do seu computador

2. **Abra o terminal** dentro da pasta `nba_system`:
   - Windows: clique com botão direito na pasta → "Abrir no Terminal"
   - Ou: `cd C:\caminho\para\nba_system`

3. **Inicie o servidor:**
   ```
   node server.js
   ```

4. **Abra no Chrome:**
   ```
   http://localhost:3000
   ```

Pronto. Sem CORS, sem extensão, sem proxy externo.

---

## APIs configuradas

| API | Chave | Uso |
|-----|-------|-----|
| iSports API | `dFAjm3gu69q7Bv2C` | Schedule NBA, stats de times e jogadores |
| The Odds API | `b4b5039610221eb1aefe86749712cbd3` | Odds: moneyline, spread, total, player props |

## Endpoints do backend (localhost:3000)

| Endpoint | Descrição |
|----------|-----------|
| `GET /api/schedule?date=YYYY-MM-DD` | Jogos da NBA no dia |
| `GET /api/stats?date=YYYY-MM-DD` | Stats de todos os jogos do dia |
| `GET /api/stats/match?matchId=XXX` | Stats de um jogo específico |
| `GET /api/history?teamId=XXX&days=10` | Histórico de um time |
| `GET /api/player-history?playerId=XXX&days=10` | Histórico de um jogador |
| `GET /api/odds?sport=basketball_nba` | Odds da NBA |
| `GET /api/player-props?matchId=XXX` | Player props de um jogo |
| `GET /api/analysis?date=YYYY-MM-DD` | Schedule + stats + odds em paralelo |

## O que o sistema analisa

- **Linhas de times**: total esperado vs linha do livro → Over/Under
- **Spread**: diferença esperada vs handicap → quem cobre
- **Moneyline**: probabilidade do modelo vs implícita da odd → EV
- **Linhas de jogadores**: média histórica vs linha prop → Over/Under por estatística
  - Pontos, rebotes, assistências, triplos
- **EV + Kelly fracionado**: calcula valor esperado e tamanho de aposta ideal
- **Ranking global**: todas as entradas ranqueadas por EV

## Modo offline (mock)

Se o backend não estiver rodando, o sistema funciona com dados mock
de demonstração automaticamente.
