const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createDispatcher, classifyStatus } = require('../api_dispatcher');

const QUEUE = 'dispatch:queue';
const PROCESSING = 'dispatch:processing';
const DEADLETTER = 'dispatch:deadletter';

const CONFIG = {
  apiUrl: 'http://api.test/ingest-race',
  edgeIngestToken: 'tok',
  dispatchBackoffBaseMs: 1,
  dispatchBackoffMaxMs: 1,
  dispatchMaxAttempts: 3,
  dispatchBlockTimeoutSec: 1,
  dispatchHttpTimeoutMs: 1000,
};

const noSleep = async () => {};

function record(overrides = {}) {
  return {
    jobId: 'j-1', playerId: 1, sessionId: 's-1', persistedAt: 1,
    payload: {
      email: 'h@x.com', playerUuid: null, startedAt: 1, finishedAt: 2,
      packets: [{ player: 1, attention: 70, meditation: 50, eegPower: { delta: 1 },
        poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 }],
    },
    ...overrides,
  };
}

function fetchSeq(steps) {
  let i = 0;
  const calls = [];
  async function fn(url, opts) {
    calls.push({ url, opts });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step.throw) throw new Error('network');
    return { status: step.status, json: async () => step.body ?? {} };
  }
  fn.calls = calls;
  return fn;
}

async function seedQueue(redis, rec) {
  await redis.rpush(QUEUE, JSON.stringify(rec));
}

test('classifyStatus: 2xx sucesso, 429/5xx transitorio, 4xx permanente', () => {
  assert.equal(classifyStatus(200), 'success');
  assert.equal(classifyStatus(201), 'success');
  assert.equal(classifyStatus(429), 'transient');
  assert.equal(classifyStatus(500), 'transient');
  assert.equal(classifyStatus(503), 'transient');
  assert.equal(classifyStatus(422), 'permanent');
  assert.equal(classifyStatus(401), 'permanent');
});

test('200 created: remove de processing, fila/deadletter vazias, envia token', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 200, body: { status: 'created' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  assert.equal(await d.processOnce(), true);
  assert.equal(await redis.llen(QUEUE), 0);
  assert.equal(await redis.llen(PROCESSING), 0);
  assert.equal(await redis.llen(DEADLETTER), 0);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].opts.headers['x-edge-ingest-token'], 'tok');
  assert.equal(fetchFn.calls[0].opts.headers.apikey, undefined);
  assert.equal(fetchFn.calls[0].opts.headers.Authorization, undefined);
});

test('200 duplicate tratado como sucesso', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 200, body: { status: 'duplicate' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);
  assert.equal(await d.processOnce(), true);
  assert.equal(await redis.llen(DEADLETTER), 0);
});

test('422 permanente: dead-letter com errorCode, sem retry', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 422, body: { error: 'race_id_must_be_uuid' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  await d.processOnce();
  assert.equal(fetchFn.calls.length, 1); // nao retentou
  assert.equal(await redis.llen(PROCESSING), 0);
  const dl = JSON.parse((await redis.lrange(DEADLETTER, 0, -1))[0]);
  assert.equal(dl.reason, 'permanent');
  assert.equal(dl.httpStatus, 422);
  assert.equal(dl.errorCode, 'race_id_must_be_uuid');
});

test('401 permanente: dead-letter + log dispatch_auth_failed', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const logs = [];
  const log = (level, message, meta) => logs.push({ level, message, meta });
  const fetchFn = fetchSeq([{ status: 401, body: { error: 'unauthorized' } }]);
  const d = createDispatcher(redis, CONFIG, log, fetchFn, noSleep);

  await d.processOnce();
  assert.equal(await redis.llen(DEADLETTER), 1);
  assert.ok(logs.some((l) => l.message === 'dispatch_auth_failed'));
});

test('500 depois 200: retenta e sucede', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 500, body: {} }, { status: 200, body: { status: 'created' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  assert.equal(await d.processOnce(), true);
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(await redis.llen(DEADLETTER), 0);
  assert.equal(await redis.llen(PROCESSING), 0);
});

test('500 sempre: esgota maxAttempts -> dead-letter exhausted', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 500, body: {} }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  await d.processOnce();
  assert.equal(fetchFn.calls.length, 3); // == dispatchMaxAttempts
  const dl = JSON.parse((await redis.lrange(DEADLETTER, 0, -1))[0]);
  assert.equal(dl.reason, 'exhausted');
  assert.equal(dl.attempts, 3);
  assert.equal(await redis.llen(PROCESSING), 0);
});

test('erro de rede depois 200: retenta e sucede', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ throw: true }, { status: 200, body: { status: 'created' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);
  assert.equal(await d.processOnce(), true);
  assert.equal(fetchFn.calls.length, 2);
});

test('registro malformado -> dead-letter malformed_record, sem POST', async () => {
  const redis = new FakeRedis();
  await redis.rpush(QUEUE, 'isto-nao-e-json');
  const fetchFn = fetchSeq([{ status: 200, body: {} }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  await d.processOnce();
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(await redis.llen(PROCESSING), 0);
  const dl = JSON.parse((await redis.lrange(DEADLETTER, 0, -1))[0]);
  assert.equal(dl.reason, 'malformed_record');
});

test('processOnce com fila vazia retorna false sem efeitos', async () => {
  const redis = new FakeRedis();
  const fetchFn = fetchSeq([{ status: 200, body: {} }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);
  assert.equal(await d.processOnce(), false);
  assert.equal(fetchFn.calls.length, 0);
});

test('recoverProcessing move orfaos de processing de volta para a fila', async () => {
  const redis = new FakeRedis();
  await redis.rpush(PROCESSING, JSON.stringify(record()));
  const d = createDispatcher(redis, CONFIG, () => {}, fetchSeq([]), noSleep);

  await d.recoverProcessing();
  assert.equal(await redis.llen(PROCESSING), 0);
  assert.equal(await redis.llen(QUEUE), 1);
});
