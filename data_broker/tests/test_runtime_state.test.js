const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeState } = require('../runtime_state');

test('tracks connections and event counters for health snapshot', () => {
  const state = createRuntimeState(Date.now() - 3000);

  state.markClientConnected();
  state.markClientConnected();
  state.markClientDisconnected();
  state.markEventValidated();
  state.markEventRejected();
  state.markEventRejected();

  const snapshot = state.snapshot();

  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.service, 'broker');
  assert.equal(snapshot.connections, 1);
  assert.equal(snapshot.validatedEvents, 1);
  assert.equal(snapshot.rejectedEvents, 2);
  assert.equal(typeof snapshot.uptimeSeconds, 'number');
});
