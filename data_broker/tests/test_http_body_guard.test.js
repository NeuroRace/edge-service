// NEU-154: corpo que nao e objeto JSON nao derruba o broker; /api/players exige JSON (CSRF).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createHttpServer } = require('../http_server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const headers = contentType ? { 'Content-Type': contentType } : {};
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    // Sem resposta em 2 s = o handler morreu no meio (o bug da NEU-154): falha, nao trava.
    req.setTimeout(2000, () => req.destroy(new Error('sem resposta do broker')));
    req.on('error', reject);
    req.end(body);
  });
}

const health = () => ({ status: 'ok' });
function session(calls = []) {
  return {
    async registerPlayers(p1, p2) { calls.push([p1, p2]); return { player1: { email: p1 }, player2: { email: p2 } }; },
    async getCurrentSession() { return { status: 'none' }; },
  };
}

test('POST /api/players: corpo que nao e objeto JSON = 400 e o broker continua de pe', async () => {
  const calls = [];
  const server = createHttpServer(health, session(calls));
  const port = await listen(server);
  try {
    for (const body of ['null', '42', '"x"', '[]', 'true']) {
      const res = await post(port, '/api/players', body);
      assert.deepEqual(res, { status: 400, body: { error: 'invalid_json' } }, body);
    }
    const ok = await post(port, '/api/players', JSON.stringify({ player1Email: 'a@x.com', player2Email: 'b@x.com' }));
    assert.equal(ok.status, 200, 'o servidor responde ao pedido seguinte');
    assert.deepEqual(calls, [['a@x.com', 'b@x.com']]);
  } finally {
    server.close();
  }
});

test('POST /api/players sem Content-Type JSON = 415 (formulario de outra pagina nao registra)', async () => {
  const calls = [];
  const server = createHttpServer(health, session(calls));
  const port = await listen(server);
  try {
    const form = await post(port, '/api/players', 'player1Email=a%40x.com', 'application/x-www-form-urlencoded');
    assert.deepEqual(form, { status: 415, body: { error: 'unsupported_media_type' } });
    assert.equal((await post(port, '/api/players', 'null', 'text/plain')).status, 415);
    assert.equal((await post(port, '/api/players', '{}', null)).status, 415);
    assert.deepEqual(calls, []);
  } finally {
    server.close();
  }
});

test('POST /api/players: erro inesperado na rota vira 500, nao queda do processo', async () => {
  const logs = [];
  const broken = {
    async registerPlayers() { throw new TypeError('quebrou'); },
    async getCurrentSession() { return { status: 'none' }; },
  };
  const server = createHttpServer(health, broken, (level, message) => logs.push([level, message]));
  const port = await listen(server);
  try {
    const res = await post(port, '/api/players', JSON.stringify({ player1Email: 'a@x.com', player2Email: '' }));
    assert.deepEqual(res, { status: 500, body: { error: 'internal_error' } });
    assert.ok(logs.some(([level, message]) => level === 'error' && message === 'api_players_error'));
  } finally {
    server.close();
  }
});

test('POST /api/dispatch/requeue: corpo que nao e objeto JSON = 400 invalid_json', async () => {
  const admin = { async requeue() { return { ok: true }; }, async overview() { return {}; } };
  const server = createHttpServer(health, null, () => {}, admin);
  const port = await listen(server);
  try {
    for (const body of ['null', '42', '[]']) {
      assert.deepEqual(await post(port, '/api/dispatch/requeue', body), { status: 400, body: { error: 'invalid_json' } }, body);
    }
  } finally {
    server.close();
  }
});
