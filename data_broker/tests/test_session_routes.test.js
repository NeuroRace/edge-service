// NEU-140: rotas de vincular e parar, e missing_contact no registro.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { createHttpServer } = require('../http_server');

const health = () => ({ status: 'ok' });
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
// Conexao nova por pedido (agent: false): o 413 derruba o socket (req.destroy, como nas rotas
// da NEU-86), e o keep-alive do Node 22 mandaria o pedido seguinte pelo socket morto.
function post(port, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: contentType ? { 'Content-Type': contentType } : {} }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function withServer(fn) {
  const session = createSessionManager(new FakeRedis(), {}, () => {});
  const server = createHttpServer(health, session);
  const port = await listen(server);
  try { await fn(port, session); } finally { server.close(); }
}

test('POST /api/players: vazio sem Sem cadastro = 400 missing_contact; com true booleano = 200', async () => {
  await withServer(async (port) => {
    const bad = await post(port, '/api/players', JSON.stringify({ player1Email: 'a@x.com', player2Email: '' }));
    assert.equal(bad.status, 400); assert.deepEqual(bad.body, { error: 'missing_contact', field: 'player2Email' });
    const str = await post(port, '/api/players', JSON.stringify({ player1Email: 'a@x.com', player2Email: '', player2NoSignup: 'true' }));
    assert.equal(str.status, 400, 'NoSignup so vale true booleano');
    const ok = await post(port, '/api/players', JSON.stringify({ player1Email: 'a@x.com', player2Email: '', player2NoSignup: true }));
    assert.equal(ok.status, 200);
  });
});

test('POST /api/session/stop: 409 sem corrida, 200 com corrida', async () => {
  await withServer(async (port, session) => {
    assert.deepEqual(await post(port, '/api/session/stop', '{}'), { status: 409, body: { ok: false, error: 'no_active_session' } });
    await session.onRaceStarted();
    const res = await post(port, '/api/session/stop', '{}');
    assert.equal(res.status, 200); assert.equal(res.body.ok, true); assert.ok(res.body.sessionId);
  });
});

test('POST /api/session/link: 200, 400 e 409', async () => {
  await withServer(async (port, session) => {
    assert.equal((await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 'a@x.com' }))).status, 409);
    await session.onRaceStarted();
    assert.equal((await post(port, '/api/session/link', JSON.stringify({ player: '1', email: 'a@x.com' }))).body.error, 'invalid_player');
    assert.equal((await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 'foo' }))).status, 400);
    assert.equal((await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 42 }))).body.error, 'invalid_email');
    const ok = await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 'a@x.com' }));
    assert.equal(ok.status, 200); assert.equal(ok.body.session.player1Kind, 'contact');
    const again = await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 'b@x.com' }));
    assert.deepEqual(again, { status: 409, body: { ok: false, error: 'not_missing' } });
  });
});

test('rotas novas: 415 sem JSON, 400 JSON invalido, 413 corpo grande', async () => {
  await withServer(async (port) => {
    for (const path of ['/api/session/link', '/api/session/stop']) {
      assert.equal((await post(port, path, '{}', 'text/plain')).status, 415, path);
      assert.deepEqual((await post(port, path, '{nope')).body, { error: 'invalid_json' }, path);
      assert.equal((await post(port, path, JSON.stringify({ pad: 'x'.repeat(5000) }))).status, 413, path);
    }
  });
});
