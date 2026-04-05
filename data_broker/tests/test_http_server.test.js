// data_broker/tests/test_http_server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createHttpServer } = require('../http_server');

function makeRequest(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(data) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /health retorna 200 com status ok', async () => {
  const server = createHttpServer(null);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.service, 'broker');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/players com body JSON inválido retorna 400', async () => {
  const session = { registerPlayers: async () => ({}) };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: addr.port, path: '/api/players', method: 'POST' },
        (r) => {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      req.write('not-json');
      req.end();
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_json');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/players com body válido retorna 200 com resultado de registerPlayers', async () => {
  const expected = {
    player1: { email: 'p1@x.com', uuid: null, validated: false },
    player2: { email: '', uuid: null, validated: false },
  };
  const session = {
    registerPlayers: async (p1, p2) => ({
      player1: { email: p1, uuid: null, validated: false },
      player2: { email: p2, uuid: null, validated: false },
    }),
  };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'POST', '/api/players', {
      player1Email: 'p1@x.com',
      player2Email: '',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, expected);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rota desconhecida retorna 404', async () => {
  const server = createHttpServer(null);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'GET', '/unknown');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET / serve dashboard.html com Content-Type text/html e CSP', async () => {
  const session = { getCurrentSession: async () => ({ status: 'none' }) };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: addr.port, path: '/', method: 'GET' },
        (r) => {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'CSP header deve estar presente');
    assert.ok(csp.includes('cdn.jsdelivr.net'), 'CSP deve permitir cdn.jsdelivr.net');
    assert.ok(csp.includes('cdn.socket.io'), 'CSP deve permitir cdn.socket.io');
    assert.ok(res.body.includes('dashboard'), 'body deve conter conteúdo do arquivo');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/session/current retorna status:none quando sem sessão ativa', async () => {
  const session = { getCurrentSession: async () => ({ status: 'none' }) };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'GET', '/api/session/current');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'none' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/session/current retorna sessão ativa com emails', async () => {
  const session = {
    getCurrentSession: async () => ({
      status: 'active',
      player1Email: 'p1@x.com',
      player2Email: 'p2@x.com',
    }),
  };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'GET', '/api/session/current');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.player1Email, 'p1@x.com');
    assert.equal(res.body.player2Email, 'p2@x.com');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/session/current retorna 503 quando session não configurado', async () => {
  const server = createHttpServer(null);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'GET', '/api/session/current');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'session_not_configured');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET / — HTML contém elementos da fase FINISHED', async () => {
  const session = { getCurrentSession: async () => ({ status: 'none' }) };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: addr.port, path: '/', method: 'GET' },
        (r) => {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => resolve({ body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.ok(res.body.includes('new-race-btn'),      'deve conter botão nova corrida');
    assert.ok(res.body.includes('winner-overlay'),    'deve conter overlay de vencedor');
    assert.ok(res.body.includes('handleHasFinished'), 'deve conter handler hasFinished');
    assert.ok(res.body.includes('playerFinished'),    'deve conter estado playerFinished');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
