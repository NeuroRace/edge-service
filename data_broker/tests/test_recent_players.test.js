// NEU-141: lista dos ultimos jogadores cadastrados (registrar de novo com um clique).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { FakeRedis } = require('./fake_redis');
const { createSessionManager, RECENT_PLAYERS_MAX } = require('../session_manager');
const { createHttpServer } = require('../http_server');
const S = require('../public/ops_state');

function makeSession() {
  const redis = new FakeRedis();
  let clock = 1000;
  const session = createSessionManager(redis, {}, () => {}, { now: () => clock });
  return { redis, session, tick: (ms = 1000) => { clock += ms; } };
}

test('registro com contato entra na lista, mais recente primeiro; anonimo nao entra', async () => {
  const { session, tick } = makeSession();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  tick();
  await session.registerPlayers('b@x.com', 'c@x.com');
  const list = await session.getRecentPlayers();
  // P1 e P2 do mesmo registro tem o mesmo horario; entre eles a ordem nao importa.
  assert.deepEqual(list.slice(0, 2).map((p) => p.contact).sort(), ['b@x.com', 'c@x.com']);
  assert.deepEqual(list.map((p) => p.lastAt), [2000, 2000, 1000]);
  assert.deepEqual(list[2], { contact: 'a@x.com', lastAt: 1000 });
});

test('registrar de novo sobe para o topo sem duplicar; contato normalizado', async () => {
  const { session, tick } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  tick();
  await session.registerPlayers('  A@X.com ', '', { p2NoSignup: true });
  const list = await session.getRecentPlayers();
  assert.deepEqual(list.map((p) => p.contact), ['a@x.com', 'b@x.com']);
  assert.equal(list[0].lastAt, 2000);
});

test('registro invalido nao grava nada na lista', async () => {
  const { session } = makeSession();
  await assert.rejects(session.registerPlayers('ok@x.com', 'invalido'), { code: 'invalid_email' });
  assert.deepEqual(await session.getRecentPlayers(), []);
});

test('lista guarda no maximo RECENT_PLAYERS_MAX; saem os mais antigos', async () => {
  const { session, tick } = makeSession();
  for (let i = 0; i < RECENT_PLAYERS_MAX + 3; i += 1) {
    await session.registerPlayers(`p${i}@x.com`, '', { p2NoSignup: true });
    tick();
  }
  const list = await session.getRecentPlayers();
  assert.equal(list.length, RECENT_PLAYERS_MAX);
  assert.equal(list[0].contact, `p${RECENT_PLAYERS_MAX + 2}@x.com`);
  assert.ok(!list.some((p) => p.contact === 'p0@x.com'));
});

test('limpar a lista apaga tudo', async () => {
  const { session } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.clearRecentPlayers();
  assert.deepEqual(await session.getRecentPlayers(), []);
});

// ---------- HTTP ----------
function request(port, { method = 'GET', path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(session, fn) {
  const server = createHttpServer(() => ({ status: 'ok' }), session, () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port); } finally { server.close(); }
}

test('GET /api/players/recent devolve a lista; POST clear exige JSON', async () => {
  const { session } = makeSession();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  await withServer(session, async (port) => {
    let res = await request(port, { path: '/api/players/recent' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), [{ contact: 'a@x.com', lastAt: 1000 }]);

    res = await request(port, { method: 'POST', path: '/api/players/recent/clear', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 415);
    assert.equal((await session.getRecentPlayers()).length, 1, 'formulario de outra pagina nao limpa a lista');

    res = await request(port, { method: 'POST', path: '/api/players/recent/clear', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    assert.deepEqual(await session.getRecentPlayers(), []);
  });
});

// ---------- painel ----------
test('filterRecentPlayers: busca por parte do contato, sem caixa e sem espacos', () => {
  const list = [{ contact: 'maria@site.com', lastAt: 2 }, { contact: 'joao@site.com', lastAt: 1 }];
  assert.deepEqual(S.filterRecentPlayers(list, ''), list);
  assert.deepEqual(S.filterRecentPlayers(list, '  MAR '), [list[0]]);
  assert.deepEqual(S.filterRecentPlayers(list, 'site'), list);
  assert.deepEqual(S.filterRecentPlayers(list, 'zzz'), []);
  assert.deepEqual(S.filterRecentPlayers(null, 'a'), []);
});

// Revisao pos-merge do #28 (15/10): sem nuvem, "Terminou" nunca vira "enviada" e o campo
// ficava travado com a dupla anterior. Offline first: so trava enquanto a pessoa corre.
test('campo do jogador trava so durante a corrida, com ou sem nuvem', () => {
  const S = require('../public/ops_state');
  assert.equal(S.contactLocked({ state: 'racing', hasPending: false }), true);
  for (const state of ['finished', 'sent', 'rejected', 'lost', 'waiting', 'registered', 'missing', 'bot', 'nosignup']) {
    assert.equal(S.contactLocked({ state, hasPending: false }), false, state);
  }
  // Proxima dupla ja registrada durante a corrida: o campo mostra a proxima, nao trava.
  assert.equal(S.contactLocked({ state: 'racing', hasPending: true }), false);
});
