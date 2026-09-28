// Jogo falso para ensaio com EEG real: emite SO a largada e a chegada, como o jogo.
// Diferente do race-producer.js, NAO gera telemetria — o eSense vem do NeuroSky
// real (ou do simulador/bot), exatamente como no estande.
//
// Uso (de data_broker/):
//   node e2e/jogo-falso.js [broker] [segundos] [jogadores]
//   node e2e/jogo-falso.js http://localhost:3000 30 1,2
//
// Registre os e-mails na tela de operacao ANTES de rodar (regra de ouro do runbook).
// Nao fala com a nuvem: quem envia e o dispatcher do broker, se API_URL estiver setado.
const { io } = require('socket.io-client');

function parseArgs(argv) {
  const [broker = 'http://localhost:3000', secs = '30', who = '1,2'] = argv;
  const seconds = Number(secs);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error(`segundos invalidos: "${secs}" (use um inteiro >= 1)`);
  }
  // playerId tem que ser NUMERO (contrato NEU-90); string faz a corrida sumir.
  const players = who.split(',').map(Number);
  if (players.some((p) => p !== 1 && p !== 2)) {
    throw new Error(`jogadores invalidos: "${who}" (use 1, 2 ou 1,2)`);
  }
  return { broker, seconds, players };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('uso: node e2e/jogo-falso.js [broker] [segundos] [jogadores]');
    process.exit(2);
  }
  const { broker, seconds, players } = args;
  const socket = io(broker, { transports: ['websocket'], reconnection: false });

  socket.on('connect_error', (err) => {
    console.error(`sem conexao com o broker em ${broker}: ${err.message}`);
    process.exit(1);
  });

  socket.on('connect', () => {
    console.log(`conectado em ${broker}. LARGADA agora; chegada em ${seconds}s`);
    socket.emit('raceStarted', {});
    setTimeout(() => {
      for (const playerId of players) {
        socket.emit('hasFinished', { playerId });
        console.log(`CHEGADA jogador ${playerId}`);
      }
      setTimeout(() => {
        socket.disconnect();
        process.exit(0);
      }, 1500);
    }, seconds * 1000);
  });
}

if (require.main === module) main();

module.exports = { parseArgs };
