const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENFORCED_EVENTS,
  validateEventPayload,
} = require('../event_contracts');

test('marks enforced broker events', () => {
  assert.equal(ENFORCED_EVENTS.has('eSense'), true);
  assert.equal(ENFORCED_EVENTS.has('handGesture'), true);
  assert.equal(ENFORCED_EVENTS.has('gameEvent'), false);
});

test('accepts valid eSense payloads', () => {
  const result = validateEventPayload('eSense', {
    player: 1,
    attention: 90,
    meditation: 55,
    eegPower: { delta: 10 },
    poorSignalLevel: 0,
    status: 'ok',
    source: 'real',
    timeStamp: 123456,
  });

  assert.equal(result, null);
});

test('rejects invalid eSense payloads', () => {
  const result = validateEventPayload('eSense', {
    player: '1',
    attention: 90,
    meditation: 55,
    eegPower: { delta: 10 },
    poorSignalLevel: 0,
    status: 'ok',
    source: 'real',
    timeStamp: 123456,
  });

  assert.equal(result, 'player_must_be_number');
});

test('accepts valid handGesture payloads', () => {
  const result = validateEventPayload('handGesture', {
    player: 2,
    timeStamp: 999,
  });

  assert.equal(result, null);
});

test('rejects invalid handGesture payloads', () => {
  const result = validateEventPayload('handGesture', {
    player: 2,
  });

  assert.equal(result, 'timeStamp_must_be_number');
});

test('keeps passthrough events permissive', () => {
  const result = validateEventPayload('gameEvent', { any: 'payload' });

  assert.equal(result, null);
});
