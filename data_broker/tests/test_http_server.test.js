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
