// Frente 3 NEU-82 / NEU-73: descarte de corrida sem e-mail deixa de ser silencioso;
// runtime_state expoe dispatcher + descartes; http expoe historico. Sem clock real.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { createRuntimeState } = require('../runtime_state');
const { createHttpServer } = require('../http_server');

test('test_DiscardIsLoud_hasFinished_of_bot_logs_warn_and_calls_hook', async () => {
  const redis = new FakeRedis(); const logs = []; let discarded = 0;
  const session = createSessionManager(redis, {}, (level, message, meta) => logs.push({ level, message, ...meta }), { onDiscarded: () => { discarded += 1; } });
  await session.registerPlayers('', '');
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 1 });
  const warn = logs.find((l) => l.message === 'has_finished_discarded_bot');
  assert.ok(warn, 'descarte deve gerar log warn has_finished_discarded_bot');
  assert.equal(warn.level, 'warn'); assert.equal(warn.playerId, 1); assert.equal(warn.reason, 'no_email_registered'); assert.ok(warn.sessionId);
  assert.equal(discarded, 1);
  assert.equal(await redis.llen('dispatch:queue'), 0, 'bot continua nao persistido');
});

test('test_DiscardIsLoud_human_finish_does_not_call_hook', async () => {
  const redis = new FakeRedis(); let discarded = 0;
  const session = createSessionManager(redis, {}, () => {}, { onDiscarded: () => { discarded += 1; } });
  await session.registerPlayers('h@x.com', '');
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 1 });
  assert.equal(discarded, 0);
  assert.equal(await redis.llen('dispatch:queue'), 1);
});

test('test_HealthExposesDispatcher_snapshot_has_dispatcher_and_discards', () => {
  const now = () => 2_000;
  const state = createRuntimeState(1_000, now);
  const base = state.snapshot();
  assert.deepEqual(base.dispatcher, { enabled: false });
  assert.equal(base.discardedRaces, 0); assert.equal(base.lastDiscardedAt, null);
  state.markRaceDiscarded();
  state.setDispatcherState(() => ({ enabled: true, target: 'api.test', lastPollAt: 1_500, counts: { queue: 1, processing: 0, deadletter: 0 } }));
  const s = state.snapshot();
  assert.equal(s.status, 'ok', 'D11: nunca nao-ok por causa do dispatcher');
  assert.equal(s.discardedRaces, 1); assert.equal(s.lastDiscardedAt, 2_000);
  assert.equal(s.dispatcher.target, 'api.test'); assert.deepEqual(s.dispatcher.counts, { queue: 1, processing: 0, deadletter: 0 });
});

test('test_HistoryEndpoint_returns_session_dispatch_history', async () => {
  const session = { getDispatchHistory: async () => [{ jobId: 'j-9', status: 'sent' }] };
  const server = createHttpServer(() => ({ status: 'ok' }), session);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/api/dispatch/history' }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ status: r.statusCode, body: d })); }).on('error', reject); });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), [{ jobId: 'j-9', status: 'sent' }]);
  } finally { server.close(); }
});

test('test_HistoryStore_session_reads_dispatch_history_newest_first', async () => {
  const redis = new FakeRedis();
  await redis.lpush('dispatch:history', JSON.stringify({ jobId: 'a' }));
  await redis.lpush('dispatch:history', JSON.stringify({ jobId: 'b' }));
  const session = createSessionManager(redis, {}, () => {});
  assert.deepEqual(await session.getDispatchHistory(), [{ jobId: 'b' }, { jobId: 'a' }]);
});
