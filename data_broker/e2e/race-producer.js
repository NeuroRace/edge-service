// data_broker/e2e/race-producer.js
//
// Harness produtor de corrida (NEU-70) — ferramenta de TESTE, nao roda em producao.
// Faz o papel do game-engine + da tela de operador (NEU-68): registra 2 jogadores
// no endpoint real (POST /api/players) e emite uma corrida completa para o broker
// (raceStarted -> stream de eSense -> hasFinished), como o jogo fara.
//
// Uso:
//   node e2e/race-producer.js --broker http://localhost:3000 \
//        --emails jogador1@ex.com,jogador2@ex.com --points 8
//
// Guard de seguranca: recusa qualquer --broker que nao seja local (ver race-payloads.js).
// Ver docs/e2e-local-runbook.md para o fluxo E2E completo (broker + Redis + nuvem local).

const http = require('node:http');
const ioClient = require('socket.io-client');
const { assertLocalTarget, buildTelemetry, buildHandGesture } = require('./race-payloads');

// Le uma flag que exige valor; erra claro se o valor faltar (ex.: --broker no fim).
function requireVal(argv, i, flag) {
  const val = argv[i + 1];
  if (val === undefined) throw new Error(`${flag} exige um valor`);
  return val;
}

// Converte para inteiro validando; erra claro em NaN (ex.: --points foo -> NaN silencioso).
function intArg(raw, flag, { min }) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${flag} deve ser inteiro >= ${min} (recebido: ${JSON.stringify(raw)})`);
  }
  return n;
}

function parseArgs(argv) {
  const args = {
    broker: 'http://localhost:3000',
    emails: 'jogador1@ex.com,jogador2@ex.com',
    points: 8,
    settleMs: 300,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--broker') { args.broker = requireVal(argv, i, key); i += 1; }
    else if (key === '--emails') { args.emails = requireVal(argv, i, key); i += 1; }
    else if (key === '--points') { args.points = intArg(requireVal(argv, i, key), key, { min: 1 }); i += 1; }
    else if (key === '--settle-ms') { args.settleMs = intArg(requireVal(argv, i, key), key, { min: 0 }); i += 1; }
    else if (key === '--help' || key === '-h') { args.help = true; }
    else throw new Error(`argumento desconhecido: ${key}`);
  }
  return args;
}

function usage() {
  console.log(
    'Uso: node e2e/race-producer.js --broker http://localhost:3000 ' +
    '--emails p1@ex.com,p2@ex.com --points 8 [--settle-ms 300]',
  );
}

// Espera deliberada entre fases: os hooks de persistencia do broker sao
// fire-and-forget (nao ha ack). Damos tempo para o broker processar cada fase.
// Nao e um teste (o gate de determinismo vale para *.test.js); e orquestracao de I/O.
function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postPlayers(brokerUrl, player1Email, player2Email) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/players', brokerUrl);
    const body = JSON.stringify({ player1Email, player2Email });
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`POST /api/players devolveu ${res.statusCode}: ${data}`));
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return 0; }

  // GUARD: nunca enviar corrida de teste para alvo remoto.
  assertLocalTarget(args.broker);

  const [player1Email, player2Email] = args.emails.split(',').map((s) => s.trim());
  if (!player1Email || !player2Email) {
    throw new Error('--emails precisa de 2 e-mails separados por virgula');
  }
  const points = args.points; // ja validado (inteiro >= 1) em parseArgs

  console.log(`[harness] alvo=${args.broker} pontos=${points} jogadores=${player1Email},${player2Email}`);

  // 1) Registrar jogadores no endpoint real (o mesmo da futura tela de ops / NEU-68).
  await postPlayers(args.broker, player1Email, player2Email);
  console.log('[harness] jogadores registrados (POST /api/players 200)');

  // 2) Conectar ao broker via Socket.IO.
  const socket = ioClient(args.broker, { transports: ['websocket', 'polling'], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
  });
  console.log(`[harness] conectado ao broker (${socket.id})`);

  // 3) raceStarted -> o broker cria a sessao lendo pending:players.
  socket.emit('raceStarted', {});
  await settle(args.settleMs);

  // 4) Stream deterministico de eSense + handGesture para os 2 jogadores
  //    (o jogo real emite os dois; o gesto exercita mais o broker).
  const t1 = buildTelemetry({ player: 1, points });
  const t2 = buildTelemetry({ player: 2, points });
  for (let i = 0; i < points; i += 1) {
    socket.emit('eSense', t1[i]);
    socket.emit('eSense', t2[i]);
    if (i % 3 === 0) {
      socket.emit('handGesture', buildHandGesture({ player: 1, index: i }));
      socket.emit('handGesture', buildHandGesture({ player: 2, index: i }));
    }
  }
  await settle(args.settleMs);

  // 5) hasFinished por jogador -> broker consolida em dispatch:queue.
  //    O broker consome o campo `playerId` (ver session_manager.js onHasFinished).
  socket.emit('hasFinished', { playerId: 1 });
  socket.emit('hasFinished', { playerId: 2 });
  await settle(args.settleMs);

  socket.disconnect();
  // IMPORTANTE: exit 0 significa que os eventos foram EMITIDOS, nao que foram
  // persistidos — os hooks do broker sao fire-and-forget (sem ack). Confirme a
  // persistencia pelos asserts do runbook (dispatch:queue no Redis / Postgres).
  console.log('[harness] corrida EMITIDA (exit 0 != persistido). Confira dispatch:queue / Postgres — ver docs/e2e-local-runbook.md.');
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`[harness] ERRO: ${err.message}`);
    process.exit(1);
  });
