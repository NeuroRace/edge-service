// NEU-158: o broker repassa os eventos de comando do jogo, e so o painel pode
// mandar os comandos. Antes desta issue, qualquer evento fora de BROKER_EVENTS
// chegava e morria no broker, sem repasse e sem log — "largar" nunca chegaria
// no jogo nem com o lado do Unreal pronto.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerSocketHandlers, BROKER_EVENTS, PANEL_COMMAND_EVENTS } = require('../socket_handlers');
const { createRuntimeState } = require('../runtime_state');
const { createPresence } = require('../presence');

function fakeIo() {
  const io = new EventEmitter();
  const connect = (id, auth) => {
    const socket = new EventEmitter();
    socket.id = id;
    socket.handshake = { auth };
    socket.broadcast = { emitted: [], emit(event, payload) { this.emitted.push({ event, payload }); } };
    io.emit('connection', socket);
    return socket;
  };
  return { io, connect };
}

function setup() {
  const { io, connect } = fakeIo();
  const presence = createPresence();
  const logs = [];
  registerSocketHandlers(io, (level, message, metadata) => logs.push({ level, message, metadata }),
    createRuntimeState(), null, presence, () => 1000);
  return { connect, presence, logs };
}

test('os avisos do jogo entram no repasse', () => {
  for (const event of ['countdownStarted', 'raceStopped', 'gameHello']) {
    assert.ok(BROKER_EVENTS.includes(event), `${event} precisa estar em BROKER_EVENTS`);
  }
});

test('startRace do painel e repassado', () => {
  const { connect } = setup();
  const panel = connect('p1', { role: 'panel' });
  const payload = { raceId: 'r-1', countdownSeconds: 3, p1: 'human', p2: 'bot' };

  panel.emit('startRace', payload);

  assert.deepEqual(panel.broadcast.emitted, [{ event: 'startRace', payload }]);
});

// A trava existe para um test-client esquecido aberto, ou o proprio jogo, nao
// conseguirem dar largada numa corrida.
test('startRace de quem nao e painel nao e repassado, e fica no log', () => {
  const { connect, logs } = setup();
  const impostor = connect('x1', { role: 'test-client' });

  impostor.emit('startRace', { raceId: 'r-1' });

  assert.deepEqual(impostor.broadcast.emitted, []);
  const recusa = logs.find((l) => l.message === 'command_rejected_not_panel');
  assert.ok(recusa, 'a recusa precisa aparecer no log');
  assert.deepEqual([recusa.level, recusa.metadata.event, recusa.metadata.piece], ['warn', 'startRace', 'test-client']);
});

test('o jogo nao pode mandar stopRace em si mesmo', () => {
  const { connect } = setup();
  const jogo = connect('j1', { role: 'game' });

  jogo.emit('stopRace', { raceId: 'r-1' });

  assert.deepEqual(jogo.broadcast.emitted, []);
});

test('conexao sem auth nenhum tambem nao manda comando', () => {
  const { connect } = setup();
  const anonimo = connect('a1', undefined);

  for (const event of PANEL_COMMAND_EVENTS) anonimo.emit(event, { raceId: 'r-1' });

  assert.deepEqual(anonimo.broadcast.emitted, []);
});

test('role game aparece como jogo no status', () => {
  const { connect, presence } = setup();
  connect('j1', { role: 'game', version: '2026-10-20a' });

  const s = presence.snapshot();
  assert.equal(s.game.connections, 1);
});

// Compatibilidade: o jogo de hoje conecta SEM auth e cai em 'unidentified'. Se o
// painel passasse a contar so `role: game`, o indicador "jogo conectado" quebraria
// no ensaio sem ninguem ter mexido no jogo.
test('o jogo de hoje, sem auth, continua contando como jogo', () => {
  const { connect, presence } = setup();
  connect('j1', undefined);

  assert.equal(presence.snapshot().game.connections, 1);
});

test('os dois jeitos convivem enquanto o jogo nao troca', () => {
  const { connect, presence } = setup();
  connect('novo', { role: 'game' });
  connect('velho', undefined);

  assert.equal(presence.snapshot().game.connections, 2);
});

test('gameHello deixa a versao do jogo visivel', () => {
  const { connect, presence } = setup();
  const jogo = connect('j1', { role: 'game' });

  jogo.emit('gameHello', { version: '2026-10-20a', engine: '5.4' });

  // O jogo nao e uma das PIECES do Diagnostico; a versao fica na conexao dele.
  assert.equal(presence.snapshot().game.connections, 1);
  assert.equal(presence.snapshot().game.lastGameEvent.event, 'gameHello');
});

test('countdownStarted e raceStopped contam como evento do jogo', () => {
  const { connect, presence } = setup();
  const jogo = connect('j1', { role: 'game' });

  jogo.emit('countdownStarted', { raceId: 'r-1', seconds: 3 });
  jogo.emit('raceStopped', { raceId: 'r-1' });

  const eventos = presence.snapshot().game.recentEvents.map((e) => e.event);
  assert.deepEqual(eventos, ['raceStopped', 'countdownStarted']);
});
