// NEU-92: falha transitoria nao segura a fila (head-of-line). Em vez de retentar em linha
// (sleep dentro do job), o job vai para dispatch:retry (ZSET, score = proxima tentativa)
// e o dispatcher segue para o proximo. Relogio injetado; nada dorme de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createDispatcher } = require('../api_dispatcher');

const QUEUE = 'dispatch:queue';
const PROCESSING = 'dispatch:processing';
const DEADLETTER = 'dispatch:deadletter';
const RETRY = 'dispatch:retry';
const ATTEMPTS = 'dispatch:attempts';
const HISTORY = 'dispatch:history';

const CONFIG = {
  apiUrl: 'http://api.test/ingest-race', edgeIngestToken: 'tok',
  dispatchBackoffBaseMs: 500, dispatchBackoffMaxMs: 4000, dispatchMaxAttempts: 3,
  dispatchBlockTimeoutSec: 5, dispatchHttpTimeoutMs: 1000,
};
const noSleep = async () => { throw new Error('processOnce nao deve dormir (NEU-92)'); };

function record(jobId, overrides = {}) {
  return {
    jobId, playerId: 1, sessionId: 's-1', persistedAt: 1,
    payload: { email: 'h@x.com', playerUuid: null, startedAt: 1, finishedAt: 2,
      packets: [{ player: 1, attention: 70, meditation: 50, eegPower: { delta: 1 }, poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 }] },
    ...overrides,
  };
}

// fetch que responde por jobId (idempotency_key): { 'j-a': [500, 200], 'j-b': [200] }.
function fetchByJob(plan) {
  const seen = {};
  const calls = [];
  async function fn(_url, opts) {
    const jobId = JSON.parse(opts.body).idempotency_key;
    calls.push(jobId);
    const steps = plan[jobId] || [200];
    const i = seen[jobId] || 0;
    seen[jobId] = i + 1;
    const step = steps[Math.min(i, steps.length - 1)];
    if (step === 'throw') throw new Error('network');
    return { status: step, json: async () => (step === 200 ? { status: 'created' } : {}) };
  }
  fn.calls = calls;
  return fn;
}

function setup(plan, config = CONFIG) {
  const redis = new FakeRedis();
  const clock = { t: 1_000_000 };
  const logs = [];
  const fetchFn = fetchByJob(plan);
  const d = createDispatcher(redis, config, (level, message, meta) => logs.push({ level, message, ...meta }), fetchFn, noSleep, () => clock.t);
  return { redis, clock, logs, fetchFn, d };
}

async function history(redis) { return (await redis.lrange(HISTORY, 0, -1)).map((s) => JSON.parse(s)); }

test('test_Reschedule_transient_failure_goes_to_retry_set_without_inline_retry', async () => {
  const { redis, clock, logs, fetchFn, d } = setup({ 'j-a': [500] });
  const raw = JSON.stringify(record('j-a'));
  await redis.rpush(QUEUE, raw);

  assert.equal(await d.processOnce(), true);

  assert.deepEqual(fetchFn.calls, ['j-a'], 'uma tentativa por vez, sem retry em linha');
  assert.equal(await redis.llen(PROCESSING), 0);
  assert.equal(await redis.llen(QUEUE), 0);
  assert.equal(await redis.llen(DEADLETTER), 0);
  const [member, score] = await redis.zrange(RETRY, 0, -1, 'WITHSCORES');
  assert.equal(member, raw, 'o registro original vai intacto para o reagendamento');
  assert.equal(Number(score), clock.t + 500, 'proxima tentativa = agora + backoff base');
  const warn = logs.find((l) => l.message === 'dispatch_retry');
  assert.equal(warn.attempt, 1); assert.equal(warn.delay, 500); assert.equal(warn.nextAttemptAt, clock.t + 500);
  assert.equal(warn.httpStatus, 500);
});

test('test_HeadOfLine_failing_race_does_not_block_the_next_one', async () => {
  const { redis, fetchFn, d } = setup({ 'j-a': [500], 'j-b': [200] });
  await redis.rpush(QUEUE, JSON.stringify(record('j-a')));
  await redis.rpush(QUEUE, JSON.stringify(record('j-b', { playerId: 2 })));

  await d.processOnce();
  await d.processOnce();

  assert.deepEqual(fetchFn.calls, ['j-a', 'j-b'], 'j-b tenta logo depois da 1a falha de j-a');
  const h = await history(redis);
  assert.equal(h.length, 1); assert.equal(h[0].jobId, 'j-b'); assert.equal(h[0].status, 'sent');
  assert.equal(await redis.zcard(RETRY), 1, 'j-a segue aguardando nova tentativa');
});

test('test_Reschedule_due_retry_is_promoted_and_sent_with_attempt_count', async () => {
  const { redis, clock, fetchFn, d } = setup({ 'j-a': [500, 200] });
  await redis.rpush(QUEUE, JSON.stringify(record('j-a')));
  await d.processOnce();

  clock.t += 499;
  assert.equal(await d.processOnce(), false, 'antes da hora, nada a fazer');
  assert.equal(fetchFn.calls.length, 1);

  clock.t += 1;
  assert.equal(await d.processOnce(), true);
  assert.deepEqual(fetchFn.calls, ['j-a', 'j-a']);
  assert.equal(await redis.zcard(RETRY), 0);
  assert.equal(await redis.llen(PROCESSING), 0);
  const [h] = await history(redis);
  assert.equal(h.status, 'sent'); assert.equal(h.attempts, 2);
  assert.equal(await redis.hget(ATTEMPTS, 'j-a'), null, 'contador limpo apos o envio');
});

test('test_Reschedule_backoff_grows_and_exhausts_into_deadletter_with_original_raw', async () => {
  const { redis, clock, fetchFn, d } = setup({ 'j-a': ['throw'] });
  const raw = JSON.stringify(record('j-a'));
  await redis.rpush(QUEUE, raw);

  await d.processOnce();
  let [, score] = await redis.zrange(RETRY, 0, -1, 'WITHSCORES');
  assert.equal(Number(score) - clock.t, 500);
  clock.t = Number(score);
  await d.processOnce();
  [, score] = await redis.zrange(RETRY, 0, -1, 'WITHSCORES');
  assert.equal(Number(score) - clock.t, 1000, 'backoff exponencial entre reagendamentos');
  clock.t = Number(score);
  await d.processOnce();

  assert.equal(fetchFn.calls.length, 3, '== dispatchMaxAttempts');
  assert.equal(await redis.zcard(RETRY), 0);
  assert.equal(await redis.llen(PROCESSING), 0);
  const [entry] = (await redis.lrange(DEADLETTER, 0, -1)).map((s) => JSON.parse(s));
  assert.equal(entry.reason, 'exhausted'); assert.equal(entry.attempts, 3);
  assert.equal(entry.raw, raw, 'requeue manual continua sendo RPUSH do raw');
  assert.equal(await redis.hget(ATTEMPTS, 'j-a'), null, 'contador limpo no dead-letter');
});

test('test_Reschedule_permanent_failure_after_retry_clears_attempts', async () => {
  const { redis, clock, d } = setup({ 'j-a': [503, 422] });
  await redis.rpush(QUEUE, JSON.stringify(record('j-a')));
  await d.processOnce();
  clock.t += 500;
  await d.processOnce();
  const [entry] = (await redis.lrange(DEADLETTER, 0, -1)).map((s) => JSON.parse(s));
  assert.equal(entry.reason, 'permanent'); assert.equal(entry.attempts, 2);
  assert.equal(await redis.hget(ATTEMPTS, 'j-a'), null);
});

test('test_Reschedule_block_timeout_shrinks_to_next_due_retry', async () => {
  const { redis, clock, d } = setup({ 'j-a': [500] });
  await d.processOnce();
  assert.equal(redis.blmoveTimeouts.at(-1), 5, 'sem reagendados: timeout da config');

  await redis.rpush(QUEUE, JSON.stringify(record('j-a')));
  await d.processOnce(); // reagenda para t+500
  clock.t += 300;
  await d.processOnce();
  assert.equal(redis.blmoveTimeouts.at(-1), 0.2, 'acorda a tempo da proxima tentativa (200 ms)');
  assert.ok(redis.blmoveTimeouts.every((s) => s > 0), 'timeout 0 bloquearia para sempre');
});

test('test_Reschedule_counts_expose_retrying', async () => {
  const { redis, d } = setup({ 'j-a': [500] });
  await redis.rpush(QUEUE, JSON.stringify(record('j-a')));
  await d.processOnce();
  assert.deepEqual(d.getState().counts, { queue: 0, processing: 0, retrying: 1, deadletter: 0 });
});
