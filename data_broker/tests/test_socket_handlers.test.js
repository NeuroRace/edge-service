const test = require('node:test');
const assert = require('node:assert/strict');

const { createForwardEventHandler } = require('../socket_handlers');
const { createRuntimeState } = require('../runtime_state');

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
  const runtimeState = createRuntimeState();
  const handler = createForwardEventHandler({
    log: (level, message, metadata) => logs.push({ level, message, metadata }),
    socket,
    event: 'eSense',
    runtimeState,
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
  assert.equal(runtimeState.snapshot().validatedEvents, 1);
});

test('rejects enforced events when payload is invalid', () => {
  const socket = createSocketDouble();
  const logs = [];
  const runtimeState = createRuntimeState();
  const handler = createForwardEventHandler({
    log: (level, message, metadata) => logs.push({ level, message, metadata }),
    socket,
    event: 'handGesture',
    runtimeState,
  });

  handler({ player: 1 });

  assert.deepEqual(socket.broadcast.emitted, []);
  assert.equal(logs[0].message, 'event_rejected');
  assert.equal(logs[0].metadata.validationError, 'timeStamp_must_be_number');
  assert.equal(runtimeState.snapshot().rejectedEvents, 1);
});

test('keeps passthrough events permissive', () => {
  const socket = createSocketDouble();
  const logs = [];
  const runtimeState = createRuntimeState();
  const handler = createForwardEventHandler({
    log: (level, message, metadata) => logs.push({ level, message, metadata }),
    socket,
    event: 'gameEvent',
    runtimeState,
  });

  const payload = { any: 'payload' };
  handler(payload);

  assert.deepEqual(socket.broadcast.emitted, [{ event: 'gameEvent', payload }]);
  assert.equal(logs[0].message, 'event_received');
  assert.equal(runtimeState.snapshot().validatedEvents, 1);
});

function createSessionSpy() {
  const calls = [];
  const record = (name) => (payload) => {
    calls.push({ name, payload });
    return Promise.resolve();
  };
  return {
    calls,
    onEsense: record('onEsense'),
    onRaceStarted: record('onRaceStarted'),
    onHasFinished: record('onHasFinished'),
  };
}

test('espelha eSense valido para a persistencia E ainda faz broadcast', () => {
  const socket = createSocketDouble();
  const runtimeState = createRuntimeState();
  const session = createSessionSpy();
  const handler = createForwardEventHandler({
    log: () => {},
    socket,
    event: 'eSense',
    runtimeState,
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

  assert.deepEqual(socket.broadcast.emitted, [{ event: 'eSense', payload }]);
  assert.deepEqual(session.calls, [{ name: 'onEsense', payload }]);
});

test('raceStarted e hasFinished sao espelhados para a persistencia', () => {
  const runtimeState = createRuntimeState();
  const session = createSessionSpy();

  const started = createForwardEventHandler({
    log: () => {}, socket: createSocketDouble(), event: 'raceStarted', runtimeState, session,
  });
  started({ foo: 1 });

  const finished = createForwardEventHandler({
    log: () => {}, socket: createSocketDouble(), event: 'hasFinished', runtimeState, session,
  });
  finished({ playerId: 1, timeStamp: 1 });

  assert.deepEqual(session.calls.map((c) => c.name), ['onRaceStarted', 'onHasFinished']);
});

test('payload invalido NAO e espelhado para a persistencia', () => {
  const runtimeState = createRuntimeState();
  const session = createSessionSpy();
  const handler = createForwardEventHandler({
    log: () => {}, socket: createSocketDouble(), event: 'eSense', runtimeState, session,
  });

  handler({ player: 1 }); // eSense incompleto -> rejeitado antes do hook

  assert.equal(session.calls.length, 0);
});
