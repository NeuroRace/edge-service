// NEU-140, revisao final: Parar/Vincular dizem qual corrida o operador via; Parar armado
// so vale para a corrida em que foi armado; "Sem cadastro" nao trava o campo do Vincular.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { createHttpServer } = require('../http_server');
const S = require('../public/ops_state');

function make() {
  const redis = new FakeRedis();
  return { redis, session: createSessionManager(redis, {}, () => {}) };
}

test('stopRace(id da corrida vista): corrida nova nao e parada (session_changed)', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const seen = (await redis.hgetall('session:current')).id;
  await session.onRaceStarted(); // o jogo largou a B enquanto o botao estava armado
  assert.deepEqual(await session.stopRace(seen), { ok: false, error: 'session_changed' });
  assert.equal((await redis.hgetall('session:current')).status, 'active');
  const cur = (await redis.hgetall('session:current')).id;
  assert.equal((await session.stopRace(cur)).ok, true);
});

test('linkPlayer(id da corrida vista): nao grava a pessoa da A na B (session_changed)', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  const seen = (await redis.hgetall('session:current')).id;
  await session.onRaceStarted();
  assert.deepEqual(await session.linkPlayer(1, 'a@x.com', seen), { ok: false, error: 'session_changed' });
  assert.equal((await redis.hgetall('session:current')).player1Kind, 'missing');
});

test('rotas: sessionId diferente = 409 session_changed; sem sessionId continua valendo', async () => {
  const { redis, session } = make();
  const server = createHttpServer(() => ({}), session);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject); req.write(JSON.stringify(body)); req.end();
  });
  try {
    await session.onRaceStarted();
    assert.deepEqual(await post('/api/session/link', { player: 1, email: 'a@x.com', sessionId: 'velha' }), { status: 409, body: { ok: false, error: 'session_changed' } });
    assert.deepEqual(await post('/api/session/stop', { sessionId: 'velha' }), { status: 409, body: { ok: false, error: 'session_changed' } });
    const id = (await redis.hgetall('session:current')).id;
    assert.equal((await post('/api/session/link', { player: 1, email: 'a@x.com', sessionId: id })).status, 200);
    assert.equal((await post('/api/session/stop', {})).status, 200);
  } finally { server.close(); }
});

test('stopArmValid: so a corrida em que o Parar foi armado, e so aberta', () => {
  const s = { status: 'active', sessionId: 'A' };
  assert.equal(S.stopArmValid({ armedSessionId: 'A', session: s }), true);
  assert.equal(S.stopArmValid({ armedSessionId: 'A', session: { ...s, sessionId: 'B' } }), false);
  assert.equal(S.stopArmValid({ armedSessionId: 'A', session: { ...s, status: 'cancelled' } }), false);
  assert.equal(S.stopArmValid({ armedSessionId: null, session: s }), false);
});

test('contactFieldState: Bot, Sem cadastro, lado missing e normal', () => {
  assert.deepEqual(S.contactFieldState({ source: 'bot', noSignup: true, state: 'waiting' }), { boxHidden: true, boxChecked: false, disabled: true, placeholder: 'Bot: não vai para a nuvem' });
  assert.deepEqual(S.contactFieldState({ source: 'neurosky', noSignup: true, state: 'waiting' }), { boxHidden: false, boxChecked: true, disabled: true, placeholder: 'Sem cadastro: não vai para a nuvem' });
  // Corrida sem cadastro: o campo e do Vincular; a caixa some e desmarca.
  assert.deepEqual(S.contactFieldState({ source: 'neurosky', noSignup: true, state: 'missing' }), { boxHidden: true, boxChecked: false, disabled: false, placeholder: 'jogador@exemplo.com' });
  assert.deepEqual(S.contactFieldState({ source: null, noSignup: false, state: 'waiting' }), { boxHidden: false, boxChecked: false, disabled: false, placeholder: 'jogador@exemplo.com' });
});
