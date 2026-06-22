const test = require('node:test');
const assert = require('node:assert/strict');
const { toCanonicalBody } = require('../dispatch_mapping');

function record() {
  return {
    jobId: '11111111-1111-1111-1111-111111111111',
    playerId: 1,
    sessionId: '22222222-2222-2222-2222-222222222222',
    persistedAt: 1000,
    payload: {
      email: 'human@x.com',
      playerUuid: null,
      startedAt: 1000,
      finishedAt: 2000,
      packets: [
        { player: 1, attention: 70, meditation: 50, eegPower: { delta: 1 },
          poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1500 },
        { player: 1, attention: 80, meditation: 55, eegPower: { theta: 2 },
          poorSignalLevel: null, status: 'poor', source: 'real', timeStamp: 1600 },
      ],
    },
  };
}

test('mapeia envelope camelCase -> snake_case canonico', () => {
  const b = toCanonicalBody(record());
  assert.equal(b.schema_version, '1.0');
  assert.equal(b.idempotency_key, '11111111-1111-1111-1111-111111111111');
  assert.equal(b.race_id, '22222222-2222-2222-2222-222222222222');
  assert.equal(b.player_slot, 1);
  assert.equal(b.player_email, 'human@x.com');
  assert.equal(b.player_uuid, null);
  assert.equal(b.source, 'real');
  assert.equal(b.started_at, 1000);
  assert.equal(b.finished_at, 2000);
  assert.equal(b.telemetry_points.length, 2);
});

test('mapeia cada ponto e descarta player/source do pacote', () => {
  const b = toCanonicalBody(record());
  const p0 = b.telemetry_points[0];
  assert.deepEqual(p0, {
    t: 1500, attention: 70, meditation: 50,
    poor_signal_level: 0, signal_status: 'ok', eeg_power: { delta: 1 },
  });
  assert.equal('player' in p0, false);
  assert.equal('source' in p0, false);
  assert.equal(b.telemetry_points[1].poor_signal_level, null);
  assert.equal(b.telemetry_points[1].signal_status, 'poor');
});
