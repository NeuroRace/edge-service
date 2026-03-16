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
