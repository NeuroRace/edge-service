const assert = require('node:assert/strict');

const { ENFORCED_EVENTS, validateEventPayload } = require('./event_contracts');
const { createRuntimeState } = require('./runtime_state');
const { createForwardEventHandler } = require('./socket_handlers');

function createSocketDouble() {
  return {
    id: 'socket-validation',
    broadcast: {
      emitted: [],
      emit(event, payload) {
        this.emitted.push({ event, payload });
      },
    },
  };
}

function validateContracts() {
  assert.equal(ENFORCED_EVENTS.has('eSense'), true);
  assert.equal(ENFORCED_EVENTS.has('handGesture'), true);
  assert.equal(ENFORCED_EVENTS.has('gameEvent'), false);

  assert.equal(
    validateEventPayload('eSense', {
      player: 1,
      attention: 90,
      meditation: 55,
      eegPower: { delta: 10 },
      poorSignalLevel: 0,
      status: 'ok',
      source: 'real',
      timeStamp: 123456,
    }),
    null,
  );

  assert.equal(
    validateEventPayload('handGesture', {
      player: 1,
    }),
    'timeStamp_must_be_number',
  );
}

function validateRuntimeState() {
  const state = createRuntimeState(Date.now() - 3000);
  state.markClientConnected();
  state.markEventValidated();
  state.markEventRejected();

  const snapshot = state.snapshot();
  assert.equal(snapshot.connections, 1);
  assert.equal(snapshot.validatedEvents, 1);
  assert.equal(snapshot.rejectedEvents, 1);
}

function validateSocketHandlers() {
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
}

validateContracts();
validateRuntimeState();
validateSocketHandlers();

console.log('broker validation passed');
