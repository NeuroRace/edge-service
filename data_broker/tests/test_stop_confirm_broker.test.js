// NEU-181, revisao do #45: o raceStopped nao diz de qual corrida e. Parar -> o jogo nao
// confirma em 5 s -> o operador larga mesmo assim a corrida B -> o jogo destrava e manda o
// raceStopped velho da corrida A, mais de 15 s depois da largada da B. Com o #41, isso fechava
// a corrida B e as chegadas dela nao subiam. Agora cada stopRace que o painel manda deixa uma
// marca, e o raceStopped seguinte so consome a marca (e a confirmacao), sem fechar nada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { registerSocketHandlers } = require('../socket_handlers');
const { createRuntimeState } = require('../runtime_state');
const { createPresence } = require('../presence');

function fakeIo() {
  const io = new EventEmitter();
  const connect = (id, auth) => {
    const socket = new EventEmitter();
    socket.id = id; socket.handshake = { auth };
    socket.broadcast = { emitted: [], emit(event, payload) { this.emitted.push({ event, payload }); } };
    io.emit('connection', socket);
    return socket;
  };
  return { io, connect };
}
const esense = (player) => ({ player, attention: 70, meditation: 50, eegPower: {}, poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 });

function makeStand() {
  const redis = new FakeRedis(); const logs = []; const clock = { t: 1_000_000 };
  const session = createSessionManager(redis, { minRaceSeconds: 15 }, (level, message, meta) => logs.push({ level, message, ...meta }), { now: () => clock.t });
  const { io, connect } = fakeIo();
  // Com a presenca, como no index.js: e ela que reconhece o papel `panel` pelo auth.
  registerSocketHandlers(io, () => {}, createRuntimeState(), session, createPresence(), () => clock.t);
  const settle = () => session.onEsense({ source: 'bot' });
  return { redis, session, logs, clock, settle, jogo: connect('jogo'), painel: connect('painel', { role: 'panel' }), f1: connect('f1', { role: 'acquisition', player: 1 }), f2: connect('f2', { role: 'acquisition', player: 2 }) };
}

test('confirmacao atrasada do Parar nao fecha a corrida seguinte, e as chegadas dela sobem', async () => {
  const st = makeStand();
  await st.session.registerPlayers('a1@x.com', 'a2@x.com');
  st.jogo.emit('raceStarted', {}); await st.settle();
  st.clock.t += 20_000;
  assert.equal((await st.session.stopRace()).ok, true);   // Parar no painel (HTTP)...
  st.painel.emit('stopRace', {}); await st.settle();        // ...e o stopRace para o jogo, que esta travado
  assert.deepEqual(st.painel.broadcast.emitted.map((e) => e.event), ['stopRace'], 'o comando segue para o jogo');
  st.clock.t += 6_000;                                      // 5 s sem confirmacao: larga mesmo assim
  await st.session.registerPlayers('b1@x.com', 'b2@x.com');
  st.jogo.emit('raceStarted', {}); await st.settle();
  for (let i = 0; i < 5; i += 1) { st.f1.emit('eSense', esense(1)); st.f2.emit('eSense', esense(2)); }
  st.clock.t += 20_000;                                     // o jogo destrava e manda o raceStopped velho
  st.jogo.emit('raceStopped', {}); await st.settle();
  assert.equal((await st.redis.hgetall('session:current')).status, 'active', 'a corrida B continua aberta');
  assert.ok(st.logs.some((l) => l.message === 'race_stopped_confirmed'));
  st.clock.t += 5_000;
  st.jogo.emit('hasFinished', { playerId: 1 }); st.jogo.emit('hasFinished', { playerId: 2 }); await st.settle();
  const q = (await st.redis.lrange('dispatch:queue', 0, -1)).map((r) => JSON.parse(r));
  assert.deepEqual(q.map((r) => r.payload.email), ['b1@x.com', 'b2@x.com'], 'as chegadas da corrida B sobem');
});

test('Parar normal: o raceStopped e a confirmacao e consome a marca; Mandar parar de novo conta outra', async () => {
  const st = makeStand();
  st.painel.emit('stopRace', {}); st.painel.emit('stopRace', {}); await st.settle();
  assert.equal((await st.redis.hgetall('game:stopPending')).count, '2');
  st.jogo.emit('raceStopped', {}); await st.settle();
  assert.equal((await st.redis.hgetall('game:stopPending')).count, '1');
  st.jogo.emit('raceStopped', {}); await st.settle();
  assert.equal((await st.redis.hgetall('game:stopPending')).count, '0');
});

test('raceStopped sem Parar do painel continua fechando a sessao (comportamento do #41)', async () => {
  const st = makeStand();
  await st.session.registerPlayers('a@x.com', 'b@x.com');
  st.jogo.emit('raceStarted', {}); await st.settle();
  st.clock.t += 30_000;
  st.jogo.emit('raceStopped', {}); await st.settle();
  assert.equal((await st.redis.hgetall('session:current')).status, 'stopped');
});

test('marca de mais de 10 min e esquecida: nao segura um raceStopped de hoje', async () => {
  const st = makeStand();
  st.painel.emit('stopRace', {}); await st.settle();
  st.clock.t += 11 * 60_000;
  await st.session.registerPlayers('a@x.com', 'b@x.com');
  st.jogo.emit('raceStarted', {}); await st.settle();
  st.clock.t += 30_000;
  st.jogo.emit('raceStopped', {}); await st.settle();
  assert.equal((await st.redis.hgetall('session:current')).status, 'stopped');
  assert.equal(Object.keys(await st.redis.hgetall('game:stopPending')).length, 0, 'marca velha apagada');
});

test('stopRace de quem nao e painel e recusado e nao deixa marca', async () => {
  const st = makeStand();
  st.jogo.emit('stopRace', {}); await st.settle();
  assert.equal(Object.keys(await st.redis.hgetall('game:stopPending')).length, 0);
});
