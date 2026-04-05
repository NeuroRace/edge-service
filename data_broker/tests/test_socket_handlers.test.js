const test = require('node:test');
const assert = require('node:assert/strict');

const { createForwardEventHandler } = require('../socket_handlers');

function createSocketDouble() {
  return {
    id: 'socket-1',
    broadcast: {
      emitted: [],
      emit(event, payload) {
        this.emitted.push({ event, payload });
      },
    },
  };
}

test('broadcasts enforced events when payload is valid', () => {
  const socket = createSocketDouble();
  const logs = [];
  const handler = createForwardEventHandler({
    log: (level, message, metadata) => logs.push({ level, message, metadata }),
    socket,
    event: 'eSense',
  });

  const payload = {
    player: 1,
    attention: 90,
    meditation: 60,
    eegPower: { delta: 10 },
    poorSignalLevel: 0,
    status: 'ok',
    source: 'real',
    timeStamp: 123,
  };

  handler(payload);

  assert.deepEqual(socket.broadcast.emitted, [{ event: 'eSense', payload }]);
  assert.equal(logs[0].message, 'event_received');
});

test('rejects enforced events when payload is invalid', () => {
  const socket = createSocketDouble();
  const logs = [];
  const handler = createForwardEventHandler({
    log: (level, message, metadata) => logs.push({ level, message, metadata }),
    socket,
    event: 'handGesture',
  });

  handler({ player: 1 });

  assert.deepEqual(socket.broadcast.emitted, []);
  assert.equal(logs[0].message, 'event_rejected');
  assert.equal(logs[0].metadata.validationError, 'timeStamp_must_be_number');
});

test('keeps passthrough events permissive', () => {
  const socket = createSocketDouble();
  const logs = [];
  const handler = createForwardEventHandler({
    log: (level, message, metadata) => logs.push({ level, message, metadata }),
    socket,
    event: 'gameEvent',
  });

  const payload = { any: 'payload' };
  handler(payload);

  assert.deepEqual(socket.broadcast.emitted, [{ event: 'gameEvent', payload }]);
  assert.equal(logs[0].message, 'event_received');
});

test('chama session.onEsense quando eSense payload é válido', () => {
  const socket = createSocketDouble();
  const calls = [];
  const session = {
    onEsense: async (p) => { calls.push({ method: 'onEsense', payload: p }); },
  };
  const handler = createForwardEventHandler({
    log: () => {},
    socket,
    event: 'eSense',
    session,
  });

  const payload = {
    player: 1,
    attention: 90,
    meditation: 60,
    eegPower: { delta: 10 },
    poorSignalLevel: 0,
    status: 'ok',
    source: 'real',
    timeStamp: 123,
  };

  handler(payload);

  // onEsense é chamado de forma assíncrona (fire-and-forget)
  return new Promise((resolve) => setImmediate(() => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'onEsense');
    assert.deepEqual(calls[0].payload, payload);
    resolve();
  }));
});

test('não chama session quando payload é inválido', () => {
  const socket = createSocketDouble();
  const calls = [];
  const session = {
    onEsense: async () => { calls.push('onEsense'); },
  };
  const handler = createForwardEventHandler({
    log: () => {},
    socket,
    event: 'eSense',
    session,
  });

  // payload inválido: falta timeStamp
  handler({ player: 1, attention: 80, meditation: 55, eegPower: {}, source: 'real', status: 'ok' });

  return new Promise((resolve) => setImmediate(() => {
    assert.equal(calls.length, 0);
    resolve();
  }));
});

test('não chama session quando session é undefined', () => {
  const socket = createSocketDouble();
  const handler = createForwardEventHandler({
    log: () => {},
    socket,
    event: 'eSense',
    // sem session
  });

  const payload = {
    player: 1,
    attention: 90,
    meditation: 60,
    eegPower: { delta: 10 },
    poorSignalLevel: 0,
    status: 'ok',
    source: 'real',
    timeStamp: 123,
  };

  // não deve lançar erro
  assert.doesNotThrow(() => handler(payload));
});
