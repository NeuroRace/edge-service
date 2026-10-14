// NEU-143: ver a fila de envio e reenviar corridas da dead-letter pelo painel.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { FakeRedis } = require('./fake_redis');
const { createDispatchAdmin } = require('../dispatch_admin');
const { createHttpServer } = require('../http_server');

// O fake compartilhado nao tem ZSET; dispatch:retry so existe com a NEU-92 (PR #23).
class FakeRedisWithRetry extends FakeRedis {
  constructor() { super(); this.zsets = new Map(); }
  async zcard(key) { return (this.zsets.get(key) || new Set()).size; }
}

function record({ jobId = 'job-1', playerId = 1, sessionId = 'sess-1', email = 'nikolas@example.com' } = {}) {
  return JSON.stringify({ jobId, playerId, sessionId, persistedAt: 1, payload: { email, packets: [{ attention: 50 }] } });
}

function dead({ raw = record(), reason = 'exhausted', jobId = 'job-1', httpStatus = null, errorCode = null, attempts = 8, failedAt = 1000 } = {}) {
  return JSON.stringify({ reason, jobId, httpStatus, errorCode, attempts, error: null, raw, failedAt });
}

const noLog = () => {};

test('overview: contagens de esperando (fila + reagendadas), enviando e falharam', async () => {
  const redis = new FakeRedisWithRetry();
  await redis.rpush('dispatch:queue', 'a', 'b');
  redis.zsets.set('dispatch:retry', new Set(['c']));
  await redis.rpush('dispatch:processing', 'd');
  await redis.rpush('dispatch:deadletter', dead());
  const admin = createDispatchAdmin(redis, noLog);
  const o = await admin.overview();
  assert.deepEqual(o.counts, { waiting: 3, retrying: 1, sending: 1, failed: 1 });
});

test('overview: funciona sem dispatch:retry (antes da NEU-92) e sem zcard no cliente', async () => {
  const redis = new FakeRedis();
  await redis.rpush('dispatch:queue', 'a');
  const o = await createDispatchAdmin(redis, noLog).overview();
  assert.deepEqual(o.counts, { waiting: 1, retrying: 0, sending: 0, failed: 0 });
  assert.deepEqual(o.failed, []);
  assert.equal(o.lastSentAt, null);
});

test('overview: ultimo envio certo vem do historico persistido', async () => {
  const redis = new FakeRedis();
  await redis.lpush('dispatch:history', JSON.stringify({ status: 'sent', at: 500 }));
  await redis.lpush('dispatch:history', JSON.stringify({ status: 'deadletter', at: 900 }));
  const o = await createDispatchAdmin(redis, noLog).overview();
  assert.equal(o.lastSentAt, 500);
});

test('overview: lista as falhas, mais recente primeiro, com quem/quando/por que e e-mail mascarado', async () => {
  const redis = new FakeRedis();
  await redis.rpush('dispatch:deadletter',
    dead({ jobId: 'job-1', failedAt: 1000 }),
    dead({ jobId: 'job-2', raw: record({ jobId: 'job-2', playerId: 2, email: 'ana@site.com' }), reason: 'permanent', httpStatus: 422, errorCode: 'invalid_payload', attempts: 1, failedAt: 2000 }));
  const o = await createDispatchAdmin(redis, noLog).overview();
  assert.equal(o.failed.length, 2);
  assert.deepEqual(o.failed[0], {
    jobId: 'job-2', sessionId: 'sess-1', playerId: 2, email: 'an***@site.com', failedAt: 2000,
    reason: 'permanent', httpStatus: 422, errorCode: 'invalid_payload', attempts: 1, error: null, retryable: true,
  });
  assert.equal(o.failed[1].jobId, 'job-1');
  assert.equal(o.failed[1].email, 'ni***@example.com');
  assert.ok(!JSON.stringify(o).includes('nikolas@example.com'), 'e-mail completo nunca sai do broker');
  assert.ok(!JSON.stringify(o).includes('packets'), 'o registro bruto nao sai do broker');
});

test('overview: entrada sem raw ou malformed_record aparece mas nao e reenviavel', async () => {
  const redis = new FakeRedis();
  await redis.rpush('dispatch:deadletter',
    JSON.stringify({ reason: 'exhausted', jobId: 'old', attempts: 8, failedAt: 1 }),
    dead({ reason: 'malformed_record', jobId: null, raw: '{nao-json' }),
    'lixo-nao-json');
  const o = await createDispatchAdmin(redis, noLog).overview();
  assert.equal(o.failed.length, 3);
  assert.ok(o.failed.every((f) => f.retryable === false));
});

test('requeue: tira da dead-letter, poe no fim da fila com o registro original e zera tentativas', async () => {
  const redis = new FakeRedis();
  const raw = record();
  await redis.rpush('dispatch:queue', 'outra');
  await redis.rpush('dispatch:deadletter', dead({ raw }), dead({ jobId: 'job-9', raw: record({ jobId: 'job-9' }) }));
  await redis.hset('dispatch:attempts', 'job-1', '8');
  const logs = [];
  const admin = createDispatchAdmin(redis, (level, message, meta) => logs.push({ level, message, meta }));
  assert.deepEqual(await admin.requeue('job-1'), { ok: true, jobId: 'job-1' });
  assert.deepEqual(await redis.lrange('dispatch:queue', 0, -1), ['outra', raw]);
  const left = await redis.lrange('dispatch:deadletter', 0, -1);
  assert.equal(left.length, 1);
  assert.equal(JSON.parse(left[0]).jobId, 'job-9');
  assert.deepEqual(await redis.hgetall('dispatch:attempts'), {});
  assert.ok(logs.some((l) => l.message === 'dispatch_requeued' && l.meta.jobId === 'job-1'));
});

test('requeue: clique duplo nao duplica a corrida na fila', async () => {
  const redis = new FakeRedis();
  await redis.rpush('dispatch:deadletter', dead());
  const admin = createDispatchAdmin(redis, noLog);
  const [a, b] = await Promise.all([admin.requeue('job-1'), admin.requeue('job-1')]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal([a, b].find((r) => !r.ok).error, 'not_found');
  assert.equal(await redis.llen('dispatch:queue'), 1);
});

test('requeue: jobId inexistente -> not_found; sem raw -> not_retryable, e nada muda', async () => {
  const redis = new FakeRedis();
  const noRaw = JSON.stringify({ reason: 'exhausted', jobId: 'old', attempts: 8, failedAt: 1 });
  await redis.rpush('dispatch:deadletter', noRaw);
  const admin = createDispatchAdmin(redis, noLog);
  assert.deepEqual(await admin.requeue('nope'), { ok: false, error: 'not_found' });
  assert.deepEqual(await admin.requeue('old'), { ok: false, error: 'not_retryable' });
  assert.deepEqual(await redis.lrange('dispatch:deadletter', 0, -1), [noRaw]);
  assert.equal(await redis.llen('dispatch:queue'), 0);
});

test('requeue: erro do Redis numa chamada nao trava as proximas', async () => {
  const redis = new FakeRedis();
  await redis.rpush('dispatch:deadletter', dead());
  const admin = createDispatchAdmin(redis, noLog);
  const original = redis.lrange.bind(redis);
  redis.lrange = async () => { throw new Error('boom'); };
  await assert.rejects(admin.requeue('job-1'), /boom/);
  redis.lrange = original;
  assert.deepEqual(await admin.requeue('job-1'), { ok: true, jobId: 'job-1' });
});

// ---------- HTTP ----------
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(admin, fn) {
  const server = createHttpServer(() => ({ status: 'ok' }), null, noLog, admin);
  const port = await listen(server);
  try { await fn(port); } finally { server.close(); }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

test('GET /api/dispatch/overview devolve o resumo', async () => {
  const redis = new FakeRedis();
  await redis.rpush('dispatch:deadletter', dead());
  await withServer(createDispatchAdmin(redis, noLog), async (port) => {
    const res = await request(port, { path: '/api/dispatch/overview' });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.counts.failed, 1);
    assert.equal(body.failed[0].jobId, 'job-1');
  });
});

test('POST /api/dispatch/requeue: 200, depois 404; 409 sem raw', async () => {
  const redis = new FakeRedis();
  await redis.rpush('dispatch:deadletter', dead(), JSON.stringify({ reason: 'exhausted', jobId: 'old', failedAt: 1 }));
  await withServer(createDispatchAdmin(redis, noLog), async (port) => {
    const send = (jobId) => request(port, { method: 'POST', path: '/api/dispatch/requeue', headers: JSON_HEADERS, body: JSON.stringify({ jobId }) });
    let res = await send('job-1');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, jobId: 'job-1' });
    res = await send('job-1');
    assert.equal(res.status, 404);
    res = await send('old');
    assert.equal(res.status, 409);
    assert.equal(await redis.llen('dispatch:queue'), 1);
  });
});

test('POST /api/dispatch/requeue exige JSON (barra CSRF por formulario) e jobId valido', async () => {
  const redis = new FakeRedis();
  await redis.rpush('dispatch:deadletter', dead());
  await withServer(createDispatchAdmin(redis, noLog), async (port) => {
    let res = await request(port, { method: 'POST', path: '/api/dispatch/requeue', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ jobId: 'job-1' }) });
    assert.equal(res.status, 415);
    res = await request(port, { method: 'POST', path: '/api/dispatch/requeue', headers: JSON_HEADERS, body: '{nao' });
    assert.equal(res.status, 400);
    res = await request(port, { method: 'POST', path: '/api/dispatch/requeue', headers: JSON_HEADERS, body: JSON.stringify({ jobId: '' }) });
    assert.equal(res.status, 400);
    assert.equal(await redis.llen('dispatch:queue'), 0, 'nada foi reenviado');
  });
});

test('sem dispatchAdmin as rotas novas caem em 404', async () => {
  await withServer(undefined, async (port) => {
    assert.equal((await request(port, { path: '/api/dispatch/overview' })).status, 404);
  });
});
