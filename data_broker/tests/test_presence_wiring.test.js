// NEU-139: o broker alimenta a presenca e expoe /api/status.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { registerSocketHandlers } = require('../socket_handlers');
const { createRuntimeState } = require('../runtime_state');
const { createPresence } = require('../presence');
const { createHttpServer } = require('../http_server');
const { validateEventPayload } = require('../event_contracts');

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

const esense = { player: 2, attention: 70, meditation: 50, eegPower: {}, poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 };

test('gestureStatus: valido atualiza a presenca e NAO faz broadcast', () => {
  const { io, connect } = fakeIo();
  const presence = createPresence();
  let clock = 1000;
  registerSocketHandlers(io, () => {}, createRuntimeState(), null, presence, () => clock);
  const g = connect('g2', { role: 'gesture', player: 2 });
  clock = 2000;
  g.emit('gestureStatus', { player: 2, handSeen: true, timeStamp: 1 });
  assert.deepEqual(g.broadcast.emitted, []);
  const piece = presence.snapshot().pieces['gesture-p2'];
  assert.deepEqual([piece.connected, piece.lastEventAt, piece.handSeen], [true, 2000, true]);
  g.emit('gestureStatus', { player: 2, handSeen: 'sim' });
  assert.equal(presence.snapshot().pieces['gesture-p2'].handSeen, true, 'payload invalido nao muda a presenca');
});

test('eSense valido atualiza a presenca e continua com broadcast; disconnect tira', () => {
  const { io, connect } = fakeIo();
  const presence = createPresence();
  registerSocketHandlers(io, () => {}, createRuntimeState(), null, presence, () => 5000);
  const a = connect('a2', { role: 'acquisition', player: 2 });
  a.emit('eSense', esense);
  assert.equal(a.broadcast.emitted.length, 1);
  assert.equal(presence.snapshot().pieces['acquisition-p2'].lastEventAt, 5000);
  a.emit('disconnect', 'transport close');
  assert.equal(presence.snapshot().pieces['acquisition-p2'].connected, false);
});

test('duas abas do painel nao contam como jogo; conexao anonima conta', () => {
  const { io, connect } = fakeIo();
  const presence = createPresence();
  registerSocketHandlers(io, () => {}, createRuntimeState(), null, presence);
  connect('p1', { role: 'panel' });
  connect('p2', { role: 'panel' });
  assert.equal(presence.snapshot().game.connections, 0);
  connect('game', undefined);
  assert.equal(presence.snapshot().game.connections, 1);
});

test('sem presenca, o broker segue funcionando como antes', () => {
  const { io, connect } = fakeIo();
  registerSocketHandlers(io, () => {}, createRuntimeState(), null);
  const a = connect('a1', undefined);
  assert.doesNotThrow(() => a.emit('gestureStatus', { player: 1, handSeen: true, timeStamp: 1 }));
  a.emit('eSense', { ...esense, player: 1 });
  assert.equal(a.broadcast.emitted.length, 1);
});

test('validateEventPayload gestureStatus', () => {
  assert.equal(validateEventPayload('gestureStatus', { player: 1, handSeen: false, timeStamp: 1 }), null);
  assert.equal(validateEventPayload('gestureStatus', { player: 1, handSeen: 'x', timeStamp: 1 }), 'handSeen_must_be_boolean');
  assert.equal(validateEventPayload('gestureStatus', null), 'payload_must_be_object');
});

test('GET /api/status devolve o que getStatus monta; sem getStatus = 404', async () => {
  const body = { now: 9, pieces: {}, game: { connections: 0, lastGameEvent: null }, redis: { status: 'ready' } };
  for (const [getStatus, expected] of [[() => body, 200], [null, 404]]) {
    const server = createHttpServer(() => ({ status: 'ok' }), null, () => {}, null, getStatus);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/status' }, (r) => {
        let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }).on('error', reject);
    });
    server.close();
    assert.equal(res.status, expected);
    if (expected === 200) assert.deepEqual(JSON.parse(res.body), body);
  }
});
