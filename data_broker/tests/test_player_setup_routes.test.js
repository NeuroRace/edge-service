// NEU-86: rotas de troca de fonte e camera.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpServer } = require('../http_server');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function request(port, { method = 'POST', path, body, json = true }) {
  return new Promise((resolve, reject) => {
    const headers = json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded' };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  });
}
function stub(result) {
  return {
    calls: [],
    async setSource(p, s) { this.calls.push(['source', p, s]); return result; },
    async setCamera(p, c) { this.calls.push(['camera', p, c]); return result; },
  };
}
async function withServer(playerSetup, fn) {
  const server = createHttpServer(() => ({ status: 'ok' }), null, () => {}, null, null, playerSetup);
  const port = await listen(server);
  try { await fn(port); } finally { server.close(); }
}

test('POST /api/players/source repassa jogador e fonte; 200 com o setup', async () => {
  const setup = stub({ ok: true, setup: { 1: { source: 'bot', camera: null } } });
  await withServer(setup, async (port) => {
    const res = await request(port, { path: '/api/players/source', body: JSON.stringify({ player: 1, source: 'bot' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, setup: { 1: { source: 'bot', camera: null } } });
    assert.deepEqual(setup.calls, [['source', 1, 'bot']]);
  });
});

test('POST /api/players/camera repassa jogador e camera', async () => {
  const setup = stub({ ok: true, setup: {} });
  await withServer(setup, async (port) => {
    const res = await request(port, { path: '/api/players/camera', body: JSON.stringify({ player: 2, camera: 1 }) });
    assert.equal(res.status, 200);
    assert.deepEqual(setup.calls, [['camera', 2, 1]]);
  });
});

test('erros: 400 para valor invalido, 409 durante a corrida', async () => {
  for (const [error, status] of [['invalid_player', 400], ['invalid_source', 400], ['invalid_camera', 400], ['race_in_progress', 409]]) {
    await withServer(stub({ ok: false, error }), async (port) => {
      const res = await request(port, { path: '/api/players/source', body: JSON.stringify({ player: 1, source: 'x' }) });
      assert.equal(res.status, status, error);
      assert.deepEqual(JSON.parse(res.body), { ok: false, error });
    });
  }
});

test('sem JSON = 415 (CSRF por formulario), JSON quebrado = 400, corpo grande = 413', async () => {
  const setup = stub({ ok: true, setup: {} });
  await withServer(setup, async (port) => {
    assert.equal((await request(port, { path: '/api/players/source', body: 'player=1&source=bot', json: false })).status, 415);
    assert.equal((await request(port, { path: '/api/players/source', body: '{nao' })).status, 400);
    assert.equal((await request(port, { path: '/api/players/camera', body: JSON.stringify({ x: 'y'.repeat(5000) }) })).status, 413);
    assert.deepEqual(setup.calls, []);
  });
});

test('sem playerSetup as rotas nao existem', async () => {
  await withServer(null, async (port) => {
    assert.equal((await request(port, { path: '/api/players/source', body: '{}' })).status, 404);
  });
});
