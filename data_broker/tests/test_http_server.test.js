const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createHttpServer } = require('../http_server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const healthSnapshot = () => ({ status: 'ok', service: 'broker', connections: 3 });

test('GET /health retorna o snapshot do runtime', async () => {
  const server = createHttpServer(healthSnapshot);
  const port = await listen(server);
  try {
    const res = await request(port, { path: '/health' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 'ok', service: 'broker', connections: 3 });
  } finally {
    server.close();
  }
});

test('rota desconhecida retorna 404', async () => {
  const server = createHttpServer(healthSnapshot);
  const port = await listen(server);
  try {
    const res = await request(port, { path: '/nope' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /api/players sem session configurada cai em 404', async () => {
  const server = createHttpServer(healthSnapshot); // sem session
  const port = await listen(server);
  try {
    const res = await request(port, { method: 'POST', path: '/api/players', body: '{}' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /api/players valido registra e retorna 200', async () => {
  const calls = [];
  const session = {
    async registerPlayers(p1, p2) {
      calls.push([p1, p2]);
      return { player1: { email: p1, validated: false }, player2: { email: p2, validated: false } };
    },
    async getCurrentSession() {
      return { status: 'none' };
    },
  };
  const server = createHttpServer(healthSnapshot, session);
  const port = await listen(server);
  try {
    const res = await request(port, {
      method: 'POST',
      path: '/api/players',
      body: JSON.stringify({ player1Email: 'a@x.com', player2Email: '' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [['a@x.com', '']]);
    assert.equal(JSON.parse(res.body).player1.email, 'a@x.com');
  } finally {
    server.close();
  }
});

test('POST /api/players com JSON invalido retorna 400', async () => {
  const session = { async registerPlayers() {}, async getCurrentSession() {} };
  const server = createHttpServer(healthSnapshot, session);
  const port = await listen(server);
  try {
    const res = await request(port, { method: 'POST', path: '/api/players', body: '{nope' });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_json');
  } finally {
    server.close();
  }
});

test('POST /api/players com body acima do limite retorna 413', async () => {
  const session = { async registerPlayers() {}, async getCurrentSession() {} };
  const server = createHttpServer(healthSnapshot, session);
  const port = await listen(server);
  try {
    const big = JSON.stringify({ player1Email: 'x'.repeat(5000) });
    const res = await request(port, { method: 'POST', path: '/api/players', body: big });
    assert.equal(res.status, 413);
  } finally {
    server.close();
  }
});

test('GET /api/session/current retorna os dados da sessao', async () => {
  const session = {
    async registerPlayers() {},
    async getCurrentSession() {
      return { status: 'active', sessionId: 'abc', player1Email: 'a@x.com' };
    },
  };
  const server = createHttpServer(healthSnapshot, session);
  const port = await listen(server);
  try {
    const res = await request(port, { path: '/api/session/current' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'active');
  } finally {
    server.close();
  }
});

test('erro interno em /api/session/current vira 500 logado', async () => {
  const logs = [];
  const session = {
    async registerPlayers() {},
    async getCurrentSession() {
      throw new Error('redis down');
    },
  };
  const server = createHttpServer(healthSnapshot, session, (l, m, meta) => logs.push({ l, m, meta }));
  const port = await listen(server);
  try {
    const res = await request(port, { path: '/api/session/current' });
    assert.equal(res.status, 500);
    assert.equal(logs[0].m, 'api_session_current_error');
    assert.equal(logs[0].meta.error, 'redis down');
  } finally {
    server.close();
  }
});
