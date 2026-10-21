// NEU-179, revisao do #41: pelo socket, os ganchos da sessao rodavam sem esperar um pelo
// outro. O raceStopped (fim natural da corrida: o ultimo chega e o jogo volta para a espera)
// fechava a sessao entre o claim e o ENQUEUE do hasFinished, e a chegada sumia em silencio,
// ou virava um descarte falso de "sem EEG" (o CLOSE apagava os pacotes). Estes testes
// emitem os eventos pelo socket, como o jogo, sem await entre eles.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { registerSocketHandlers } = require('../socket_handlers');
const { createRuntimeState } = require('../runtime_state');

function fakeIo() {
  const io = new EventEmitter();
  const connect = (id, auth) => {
    const socket = new EventEmitter();
    socket.id = id;
    socket.handshake = { auth };
    socket.broadcast = { emit() {} };
    io.emit('connection', socket);
    return socket;
  };
  return { io, connect };
}

const esense = (player) => ({ player, attention: 70, meditation: 50, eegPower: {}, poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 });

function makeStand() {
  const redis = new FakeRedis(); const logs = []; const discards = []; const clock = { t: 1_000_000 };
  const session = createSessionManager(redis, { minRaceSeconds: 15 }, (level, message, meta) => logs.push({ level, message, ...meta }), {
    now: () => clock.t,
    onDiscarded: (d) => discards.push(d),
  });
  current = session;
  const { io, connect } = fakeIo();
  registerSocketHandlers(io, () => {}, createRuntimeState(), session);
  const jogo = connect('jogo', undefined);
  const fone1 = connect('fone1', { role: 'acquisition', player: 1 });
  const fone2 = connect('fone2', { role: 'acquisition', player: 2 });
  return { redis, session, logs, discards, clock, jogo, fone1, fone2 };
}

// Revisao do #41: em vez de um tempo fixo (instavel num CI lento), espera a fila da sessao
// esvaziar. Um eSense de bot entra no fim da fila e nao grava nada: quando ele termina, tudo o
// que o socket emitiu antes ja terminou.
let current = null;
const settle = () => current.onEsense({ source: 'bot' });

async function largar(stand) {
  await stand.session.registerPlayers('a@x.com', '11 98765-4321');
  stand.jogo.emit('raceStarted', {});
  await settle();
  for (let i = 0; i < 18; i += 1) { stand.fone1.emit('eSense', esense(1)); stand.fone2.emit('eSense', esense(2)); }
  await settle();
}

async function fila(redis) {
  return (await redis.lrange('dispatch:queue', 0, -1)).map((raw) => JSON.parse(raw));
}

test('test_LateFinishSocket_last_finish_and_raceStopped_at_once_both_go_up', async () => {
  const stand = makeStand();
  await largar(stand);
  stand.clock.t += 20_000;
  stand.jogo.emit('hasFinished', { playerId: 1 });
  stand.jogo.emit('hasFinished', { playerId: 2 });
  stand.jogo.emit('raceStopped', {}); // 0 ms depois do ultimo
  await settle();
  const q = await fila(stand.redis);
  assert.deepEqual(q.map((r) => r.playerId).sort(), [1, 2], 'as duas chegadas sobem');
  assert.deepEqual(q.map((r) => r.payload.packets.length), [18, 18], 'pacotes intactos');
  assert.equal(stand.discards.length, 0, 'nenhum descarte falso');
  assert.equal((await stand.redis.hgetall('session:current')).status, 'stopped');
});

test('test_LateFinishSocket_p2_two_seconds_later_then_raceStopped_keeps_eeg', async () => {
  const stand = makeStand();
  await largar(stand);
  stand.clock.t += 18_000;
  stand.jogo.emit('hasFinished', { playerId: 1 });
  await settle();
  stand.clock.t += 2_000; // o P2 chega 2 s depois, e o jogo volta para a espera em seguida
  stand.jogo.emit('hasFinished', { playerId: 2 });
  stand.jogo.emit('raceStopped', {});
  await settle();
  const q = await fila(stand.redis);
  assert.deepEqual(q.map((r) => r.playerId), [1, 2]);
  assert.equal(q[1].payload.phone, '+5511987654321');
  assert.equal(q[1].payload.packets.length, 18, 'o P2 nao vira "sem EEG"');
  assert.equal(stand.discards.length, 0);
  assert.ok(!stand.logs.some((l) => l.message === 'has_finished_ignored_closed_session'), 'nenhuma chegada perdida');
});

test('test_LateFinishSocket_stop_from_panel_during_finish_never_fakes_no_eeg', async () => {
  // O Parar do painel (HTTP, fora da fila) cai exatamente entre a releitura da sessao e a
  // leitura dos pacotes: o CLOSE apaga os pacotes. Antes, isso virava descarte de "sem EEG"
  // com banner falso de fone desconectado. Agora o Parar ganha e a chegada e so ignorada.
  const stand = makeStand();
  await largar(stand);
  stand.clock.t += 20_000;
  const lrange = stand.redis.lrange.bind(stand.redis);
  stand.redis.lrange = async (...args) => {
    stand.redis.lrange = lrange;
    assert.equal((await stand.session.stopRace()).ok, true);
    return lrange(...args);
  };
  stand.jogo.emit('hasFinished', { playerId: 2 });
  await settle();
  assert.equal((await stand.redis.hgetall('session:current')).status, 'cancelled', 'o Parar ganhou');
  assert.equal(stand.discards.length, 0, 'sem descarte falso de "sem EEG"');
  assert.ok(stand.logs.some((l) => l.message === 'has_finished_ignored_closed_session'));
  assert.equal(await stand.redis.llen('dispatch:queue'), 0);
});
