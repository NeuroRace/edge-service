// Frente 3 NEU-82: dead-letter com payload (F1), zumbi de string vazia (F8),
// dispatch:history e estado do dispatcher (D11/NEU-69). Sem clock real, sem sleep.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createDispatcher } = require('../api_dispatcher');

const QUEUE = 'dispatch:queue';
const PROCESSING = 'dispatch:processing';
const DEADLETTER = 'dispatch:deadletter';
const HISTORY = 'dispatch:history';

const CONFIG = {
  apiUrl: 'http://api.test/ingest-race', edgeIngestToken: 'tok',
  dispatchBackoffBaseMs: 1, dispatchBackoffMaxMs: 1, dispatchMaxAttempts: 2,
  dispatchBlockTimeoutSec: 1, dispatchHttpTimeoutMs: 1000,
};
const noSleep = async () => {};
const fixedNow = () => 1_700_000_000_000;

function record(overrides = {}) {
  return {
    jobId: 'j-1', playerId: 1, sessionId: 's-1', persistedAt: 1,
    payload: { email: 'humano@exemplo.com', playerUuid: null, startedAt: 1, finishedAt: 2,
      packets: [{ player: 1, attention: 70, meditation: 50, eegPower: { delta: 1 }, poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 }] },
    ...overrides,
  };
}
function fetchSeq(steps) {
  let i = 0;
  return async () => { const step = steps[Math.min(i, steps.length - 1)]; i += 1; if (step.throw) throw new Error('network'); return { status: step.status, json: async () => step.body ?? {} }; };
}
function make(redis, fetchFn, log = () => {}) {
  return createDispatcher(redis, CONFIG, log, fetchFn, noSleep, fixedNow);
}
function makeClocked(redis, fetchFn) {
  const clock = { t: fixedNow() };
  return { clock, d: createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep, () => clock.t) };
}

// NEU-92: falha transitoria reagenda (dispatch:retry) em vez de retentar em linha.
// Roda o dispatcher ate a fila e os reagendados esvaziarem, avancando o relogio.
async function drain(d, redis, clock) {
  for (let i = 0; i < 20; i += 1) {
    await d.processOnce();
    if ((await redis.llen(QUEUE)) === 0 && (await redis.zcard('dispatch:retry')) === 0) return;
    clock.t += 60_000;
  }
  throw new Error('drain nao terminou');
}
async function deadLetters(redis) { return (await redis.lrange(DEADLETTER, 0, -1)).map((s) => JSON.parse(s)); }
async function history(redis) { return (await redis.lrange(HISTORY, 0, -1)).map((s) => JSON.parse(s)); }

test('test_DeadLetterKeepsRaw_exhausted_entry_carries_original_record', async () => {
  const redis = new FakeRedis(); const raw = JSON.stringify(record());
  await redis.rpush(QUEUE, raw);
  const { d, clock } = makeClocked(redis, fetchSeq([{ status: 500 }]));
  await drain(d, redis, clock);
  const [entry] = await deadLetters(redis);
  assert.equal(entry.reason, 'exhausted');
  assert.equal(entry.raw, raw, 'o payload original deve estar na entrada (requeue = RPUSH raw)');
  assert.equal(await redis.llen(PROCESSING), 0);
});

test('test_DeadLetterKeepsRaw_permanent_entry_carries_original_record', async () => {
  const redis = new FakeRedis(); const raw = JSON.stringify(record());
  await redis.rpush(QUEUE, raw);
  const d = make(redis, fetchSeq([{ status: 422, body: { error: 'invalid' } }]));
  await d.processOnce();
  const [entry] = await deadLetters(redis);
  assert.equal(entry.reason, 'permanent');
  assert.equal(entry.raw, raw);
});

test('test_DeadLetterKeepsRaw_mapping_failed_entry_carries_original_record', async () => {
  const redis = new FakeRedis(); const raw = JSON.stringify(record({ payload: { ...record().payload, packets: [null] } }));
  await redis.rpush(QUEUE, raw);
  const d = make(redis, fetchSeq([{ status: 200 }]));
  await d.processOnce();
  const [entry] = await deadLetters(redis);
  assert.equal(entry.reason, 'mapping_failed');
  assert.equal(entry.raw, raw);
});

test('test_NoZombie_empty_string_in_queue_goes_to_deadletter_not_processing', async () => {
  const redis = new FakeRedis();
  await redis.rpush(QUEUE, '');
  const d = make(redis, fetchSeq([{ status: 200 }]));
  assert.equal(await d.processOnce(), true, 'string vazia e um item, nao "fila vazia"');
  assert.equal(await redis.llen(PROCESSING), 0, 'nada pode ficar preso em processing');
  const [entry] = await deadLetters(redis);
  assert.equal(entry.reason, 'malformed_record');
});

test('test_DispatchHistory_success_appends_masked_entry', async () => {
  const redis = new FakeRedis();
  await redis.rpush(QUEUE, JSON.stringify(record()));
  const d = make(redis, fetchSeq([{ status: 200, body: { status: 'created' } }]));
  await d.processOnce();
  const [h] = await history(redis);
  assert.deepEqual(h, { jobId: 'j-1', sessionId: 's-1', playerId: 1, email: 'hu***@exemplo.com', status: 'sent', result: 'created', httpStatus: 200, reason: null, attempts: 1, at: 1_700_000_000_000 });
});

test('test_DispatchHistory_deadletter_appends_entry_with_reason', async () => {
  const redis = new FakeRedis();
  await redis.rpush(QUEUE, JSON.stringify(record({ jobId: 'j-2', playerId: 2 })));
  const { d, clock } = makeClocked(redis, fetchSeq([{ throw: true }]));
  await drain(d, redis, clock);
  const [h] = await history(redis);
  assert.equal(h.status, 'deadletter'); assert.equal(h.reason, 'exhausted'); assert.equal(h.jobId, 'j-2'); assert.equal(h.playerId, 2); assert.equal(h.httpStatus, null); assert.equal(h.attempts, 2);
});

test('test_DispatchHistory_is_capped_at_20_newest_first', async () => {
  const redis = new FakeRedis();
  for (let i = 0; i < 25; i += 1) await redis.rpush(QUEUE, JSON.stringify(record({ jobId: `j-${i}` })));
  const d = make(redis, fetchSeq([{ status: 200, body: { status: 'created' } }]));
  for (let i = 0; i < 25; i += 1) await d.processOnce();
  const h = await history(redis);
  assert.equal(h.length, 20);
  assert.equal(h[0].jobId, 'j-24', 'mais recente primeiro');
  assert.equal(h[19].jobId, 'j-5');
});

test('test_DispatcherState_exposes_target_lastPoll_and_counts', async () => {
  const redis = new FakeRedis();
  await redis.rpush(QUEUE, JSON.stringify(record()));
  await redis.rpush(DEADLETTER, '{}');
  const d = make(redis, fetchSeq([{ status: 200, body: { status: 'created' } }]));
  const before = d.getState();
  assert.equal(before.enabled, true); assert.equal(before.target, 'api.test'); assert.equal(before.lastPollAt, null);
  await d.processOnce();
  const s = d.getState();
  assert.equal(s.lastPollAt, 1_700_000_000_000);
  assert.equal(s.lastSuccessAt, 1_700_000_000_000);
  assert.equal(s.inFlightJobId, null);
  assert.deepEqual(s.counts, { queue: 0, processing: 0, retrying: 0, deadletter: 1 });
});

test('test_DispatcherState_records_lastErrorAt_on_deadletter', async () => {
  const redis = new FakeRedis();
  await redis.rpush(QUEUE, JSON.stringify(record()));
  const { d, clock } = makeClocked(redis, fetchSeq([{ status: 500 }]));
  await d.processOnce();
  assert.equal(d.getState().lastErrorAt, 1_700_000_000_000, 'falha transitoria reagendada ja marca o erro');
  await drain(d, redis, clock);
  const s = d.getState();
  assert.equal(s.lastErrorAt, clock.t); assert.equal(s.lastSuccessAt, null); assert.equal(s.counts.deadletter, 1);
});

test('test_ObservabilityNeverBlocks_history_failure_does_not_break_success_path', async () => {
  const redis = new FakeRedis(); const logs = [];
  redis.lpush = async () => { throw new Error('WRONGTYPE'); }; // dispatch:history quebrado
  await redis.rpush(QUEUE, JSON.stringify(record()));
  const d = make(redis, fetchSeq([{ status: 200, body: { status: 'created' } }]), (level, message, meta) => logs.push({ level, message, ...meta }));
  assert.equal(await d.processOnce(), true, 'processOnce nao pode lancar por falha de historico');
  assert.equal(await redis.llen(PROCESSING), 0);
  assert.ok(logs.find((l) => l.message === 'dispatch_success'), 'sucesso continua logado');
  const warn = logs.find((l) => l.message === 'dispatch_history_error');
  assert.equal(warn?.level, 'warn'); assert.equal(warn?.jobId, 'j-1');
});

test('test_ObservabilityNeverBlocks_history_failure_does_not_break_deadletter_path', async () => {
  const redis = new FakeRedis();
  redis.lpush = async () => { throw new Error('WRONGTYPE'); };
  await redis.rpush(QUEUE, JSON.stringify(record()));
  const d = make(redis, fetchSeq([{ status: 422, body: { error: 'x' } }]));
  assert.equal(await d.processOnce(), true);
  assert.equal(await redis.llen(DEADLETTER), 1, 'dead-letter (fluxo confiavel) continua gravado');
  assert.equal(await redis.llen(PROCESSING), 0);
});
