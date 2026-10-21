// NEU-68: tela de operação servida pelo broker. Sem clock real (now injetado), sem sleep.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { FakeRedis } = require('./fake_redis');
const { createHttpServer } = require('../http_server');
const { createSessionManager } = require('../session_manager');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function request(port, { method = 'GET', path = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  });
}
const health = () => ({ status: 'ok' });

test('test_OpsScreenServed_root_returns_html_with_strict_csp_and_three_blocks', async () => {
  const server = createHttpServer(health, { getCurrentSession: async () => ({ status: 'none' }) });
  const port = await listen(server);
  try {
    const res = await request(port, { path: '/' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/); assert.match(csp, /connect-src 'self' ws: wss:/);
    for (const b of ['players', 'signal', 'cloud']) assert.match(res.body, new RegExp(`data-block="${b}"`));
    assert.match(res.body, /data-banner/);
    // NEU-139: faixa de status, Poor Signal e gesto nos cards; sem relogio; sem etapa "Enviada".
    assert.match(res.body, /data-strip/);
    for (const g of ['central', 'coletor', 'jogo', 'nuvem']) assert.match(res.body, new RegExp(`data-ball="${g}"`));
    assert.match(res.body, /data-psl="1"/); assert.match(res.body, /data-gesture="2"/);
    assert.doesNotMatch(res.body, /id="clock"/);
    assert.doesNotMatch(res.body, /data-step="sent"/);
    // NEU-141: ultimos jogadores com busca, botoes P1/P2 e limpar.
    for (const sel of ['data-block="recent"', 'data-recent-search', 'data-recent-list', 'data-recent-clear']) assert.match(res.body, new RegExp(sel));
    // NEU-142: abas e blocos fixos do Diagnostico.
    assert.match(res.body, /data-tab="ops"/); assert.match(res.body, /data-tab="diag"/);
    assert.match(res.body, /data-panel="diag"/);
    for (const k of ['broker', 'redis', 'acquisition-p1', 'gesture-p1', 'jogo', 'acquisition-p2', 'gesture-p2']) assert.match(res.body, new RegExp(`data-diag="${k}"`));
    // NEU-86: fonte NeuroSky | Bot e camera em cada card.
    for (const slot of [1, 2]) {
      assert.match(res.body, new RegExp(`data-source-btn="${slot}" data-source="neurosky"`));
      assert.match(res.body, new RegExp(`data-source-btn="${slot}" data-source="bot"`));
      assert.match(res.body, new RegExp(`data-camera="${slot}"`));
      assert.match(res.body, new RegExp(`data-setup-msg="${slot}"`));
      // NEU-140: Sem cadastro e Vincular em cada card.
      assert.match(res.body, new RegExp(`data-nosignup="${slot}"`));
      assert.match(res.body, new RegExp(`data-link-player="${slot}"`));
      // data-link ja e o indicador de conexao do bloco de sinal: nome repetido faria o sinal escrever no botao.
      assert.equal((res.body.match(new RegExp(`data-link="${slot}"`, 'g')) || []).length, 1);
    }
    assert.match(res.body, /<option value="2">Câmera 3<\/option>/);
    assert.match(res.body, /data-register-blockers/);
    assert.match(res.body, /data-stop/);
    // NEU-140: Largar (registra e manda o jogo largar) ao lado do Registrar.
    assert.match(res.body, /data-start/);
    assert.doesNotMatch(res.body, /deixe em branco para anônimo/);
  } finally { server.close(); }
});

test('test_OpsScreenServed_static_assets_have_content_type', async () => {
  const server = createHttpServer(health, { getCurrentSession: async () => ({ status: 'none' }) });
  const port = await listen(server);
  try {
    for (const [path, type] of [['/ops.js', /javascript/], ['/ops_state.js', /javascript/], ['/ops.css', /text\/css/]]) {
      const res = await request(port, { path });
      assert.equal(res.status, 200, path); assert.match(res.headers['content-type'], type, path); assert.ok(res.body.length > 100, path);
    }
  } finally { server.close(); }
});

test('test_NoPathTraversal_only_allowlisted_assets_are_served', async () => {
  const server = createHttpServer(health, { getCurrentSession: async () => ({ status: 'none' }) });
  const port = await listen(server);
  try {
    for (const path of ['/public/../index.js', '/index.js', '/..%2fconfig.js', '/ops.js/../index.js', '/package.json']) {
      const res = await request(port, { path });
      assert.equal(res.status, 404, path);
    }
  } finally { server.close(); }
});

test('test_EmailNormalized_registerPlayers_lowercases_and_trims', async () => {
  const redis = new FakeRedis();
  const session = createSessionManager(redis, {}, () => {});
  await session.registerPlayers('  Foo.Bar@Example.COM ', '', { p2NoSignup: true });
  const pending = await redis.hgetall('pending:players');
  assert.equal(pending.player1Email, 'foo.bar@example.com');
  assert.equal(pending.player2Email, '');
});

test('test_EmailValidated_registerPlayers_rejects_invalid_format', async () => {
  const session = createSessionManager(new FakeRedis(), {}, () => {});
  for (const bad of ['foo', 'a@b', 'a b@x.com', '@x.com', 'a@']) {
    await assert.rejects(() => session.registerPlayers(bad, '', { p2NoSignup: true }), (err) => err.code === 'invalid_email' && err.field === 'player1Email', bad);
  }
  await assert.rejects(() => session.registerPlayers('ok@x.com', 'nope'), (err) => err.field === 'player2Email');
});

test('test_EmailValidated_http_returns_400_invalid_email', async () => {
  const session = createSessionManager(new FakeRedis(), {}, () => {});
  const server = createHttpServer(health, session);
  const port = await listen(server);
  try {
    const res = await request(port, { method: 'POST', path: '/api/players', body: JSON.stringify({ player1Email: 'foo', player2Email: '' }) });
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid_email', field: 'player1Email' });
    const ok = await request(port, { method: 'POST', path: '/api/players', body: JSON.stringify({ player1Email: ' A@x.com ', player2Email: '', player2NoSignup: true }) });
    assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).player1.email, 'a@x.com');
  } finally { server.close(); }
});

test('test_SessionExposesBotFlags_current_session_has_isbot_and_startedAt', async () => {
  const redis = new FakeRedis();
  const session = createSessionManager(redis, {}, () => {});
  await session.registerPlayers('h@x.com', '', { p2NoSignup: true });
  await session.onRaceStarted();
  const cur = await session.getCurrentSession();
  assert.equal(cur.player1IsBot, false); assert.equal(cur.player2IsBot, true);
  assert.equal(typeof cur.startedAt, 'number');
  assert.equal(cur.player1Email, 'h@x.com');
});

test('test_SessionExposesFinished_current_session_reflects_persisted_hasFinished', async () => {
  const redis = new FakeRedis();
  const session = createSessionManager(redis, {}, () => {});
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  assert.equal((await session.getCurrentSession()).player1Finished, false);
  await session.onHasFinished({ playerId: 1 });
  const cur = await session.getCurrentSession();
  assert.equal(cur.player1Finished, true); assert.equal(cur.player2Finished, false);
});
