// data_broker/tests/test_api_dispatcher.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../api_dispatcher');

function createRedisFake() {
  const lists = {};
  return {
    lists,
    async rpush(key, value) {
      if (!lists[key]) lists[key] = [];
      lists[key].push(value);
    },
  };
}

const config = {
  apiUrl: 'https://example.com/api',
  supabaseAnonKey: 'test-key',
  backoffBaseMs: 0,
  backoffMaxMs: 0,
};

const noopLog = () => {};

function makeJob(overrides = {}) {
  return {
    jobId: 'job-1',
    playerId: 1,
    sessionId: 'sess-1',
    expiresAt: Date.now() + 60000,
    attempts: 0,
    payload: {
      email: 'p@x.com',
      playerUuid: null,
      startedAt: 1000,
      finishedAt: 2000,
      packets: [],
    },
    ...overrides,
  };
}

test('job válido executa POST e loga dispatch_success', async () => {
  const redis = createRedisFake();
  const logs = [];
  const mockFetch = async () => ({ ok: true });
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    mockFetch,
  );

  await dispatcher.processJob(makeJob());

  assert.equal(logs[0].m, 'dispatch_success');
  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('job com expiresAt no passado é descartado sem POST', async () => {
  const redis = createRedisFake();
  const logs = [];
  const mockFetch = async () => {
    throw new Error('não deve ser chamado');
  };
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    mockFetch,
  );

  await dispatcher.processJob(makeJob({ expiresAt: Date.now() - 1000 }));

  assert.equal(logs[0].m, 'job_expired');
  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('API_URL ausente descarta job com log e sem erro fatal', async () => {
  const redis = createRedisFake();
  const logs = [];
  const cfgNoUrl = { ...config, apiUrl: null };
  const dispatcher = createDispatcher(
    redis,
    cfgNoUrl,
    (l, m, d) => logs.push({ l, m, d }),
  );

  await dispatcher.processJob(makeJob());

  assert.equal(logs[0].m, 'api_url_not_configured');
  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('falha no POST re-enfileira job com attempts incrementado', async () => {
  const redis = createRedisFake();
  const logs = [];
  const mockFetch = async () => {
    throw new Error('network error');
  };
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    mockFetch,
  );

  await dispatcher.processJob(makeJob());

  assert.equal(logs[0].m, 'dispatch_retry');
  assert.equal(redis.lists['dispatch:queue'].length, 1);
  const requeued = JSON.parse(redis.lists['dispatch:queue'][0]);
  assert.equal(requeued.attempts, 1);
});

test('resposta HTTP não-2xx aciona retry', async () => {
  const redis = createRedisFake();
  const logs = [];
  const mockFetch = async () => ({ ok: false, status: 500 });
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    mockFetch,
  );

  await dispatcher.processJob(makeJob());

  assert.equal(logs[0].m, 'dispatch_retry');
  const requeued = JSON.parse(redis.lists['dispatch:queue'][0]);
  assert.equal(requeued.attempts, 1);
});

test('backoff é limitado pelo backoffMaxMs', async () => {
  const redis = createRedisFake();
  const cfgCapped = { ...config, backoffBaseMs: 10, backoffMaxMs: 30 };
  const delays = [];
  const mockFetch = async () => {
    throw new Error('network error');
  };
  // Injeta sleep para capturar o delay calculado
  const dispatcher = createDispatcher(
    redis,
    cfgCapped,
    noopLog,
    mockFetch,
    async (ms) => delays.push(ms),
  );

  // attempts=5 → após increment: attempts=6 → delay = min(10 * 2^6, 30) = min(640, 30) = 30
  await dispatcher.processJob(makeJob({ attempts: 5 }));

  assert.equal(delays[0], 30);
  const requeued = JSON.parse(redis.lists['dispatch:queue'][0]);
  assert.equal(requeued.attempts, 6);
});

test('emitFn é chamado com status:sent em dispatch bem-sucedido', async () => {
  const redis = createRedisFake();
  const emitted = [];
  const mockFetch = async () => ({ ok: true });
  const dispatcher = createDispatcher(
    redis,
    config,
    noopLog,
    mockFetch,
    async () => {},
    (event, payload) => emitted.push({ event, payload }),
  );

  await dispatcher.processJob(makeJob());

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'dispatchStatus');
  assert.equal(emitted[0].payload.status, 'sent');
  assert.equal(emitted[0].payload.jobId, 'job-1');
  assert.equal(emitted[0].payload.playerId, 1);
  assert.equal(emitted[0].payload.playerEmail, 'p@x.com');
  assert.equal(emitted[0].payload.attempts, 0);
  assert.ok(typeof emitted[0].payload.timestamp === 'number');
});

test('emitFn é chamado com status:retry em falha de POST', async () => {
  const redis = createRedisFake();
  const emitted = [];
  const mockFetch = async () => { throw new Error('network error'); };
  const dispatcher = createDispatcher(
    redis,
    config,
    noopLog,
    mockFetch,
    async () => {},
    (event, payload) => emitted.push({ event, payload }),
  );

  await dispatcher.processJob(makeJob());

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'retry');
  assert.equal(emitted[0].payload.attempts, 1);
  assert.equal(emitted[0].payload.playerEmail, 'p@x.com');
});

test('emitFn é chamado com status:expired em job expirado', async () => {
  const redis = createRedisFake();
  const emitted = [];
  const dispatcher = createDispatcher(
    redis,
    config,
    noopLog,
    async () => {},
    async () => {},
    (event, payload) => emitted.push({ event, payload }),
  );

  await dispatcher.processJob(makeJob({ expiresAt: Date.now() - 1000 }));

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'expired');
  assert.equal(emitted[0].payload.jobId, 'job-1');
  assert.equal(emitted[0].payload.playerEmail, 'p@x.com');
});

test('processDequeue loga dispatcher_dequeued com jobId e queue_size corretos', async () => {
  const logs = [];
  const job = makeJob();
  const redis = {
    async blpop() { return ['dispatch:queue', JSON.stringify(job)]; },
    async llen() { return 7; },
    async rpush() {},
  };
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    async () => ({ ok: true }),
  );

  await dispatcher.processDequeue();

  const dequeueLog = logs.find((entry) => entry.m === 'dispatcher_dequeued');
  assert.ok(dequeueLog, 'deve logar dispatcher_dequeued');
  assert.equal(dequeueLog.d.jobId, 'job-1');
  assert.equal(dequeueLog.d.queue_size, 7);
});

test('startHealthMonitor loga queue_health com queue_size e retorna função de stop', async () => {
  const logs = [];
  const redis = {
    async llen() { return 5; },
  };
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
  );

  const stop = dispatcher.startHealthMonitor(1); // 1ms para disparar rapidamente no teste
  await new Promise((r) => setTimeout(r, 20));
  stop();

  const healthLog = logs.find((entry) => entry.m === 'queue_health');
  assert.ok(healthLog, 'deve logar queue_health');
  assert.equal(healthLog.d.queue_size, 5);
});
