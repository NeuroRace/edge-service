// NEU-160: o painel aceita e-mail ou celular num campo so. Celular brasileiro com DDD,
// guardado como +55DDD9XXXXXXXX, conta como gente (vai para a nuvem em player_phone).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { createHttpServer } = require('../http_server');
const { PLAYER_SETUP_KEY } = require('../player_setup');
const { toCanonicalBody } = require('../dispatch_mapping');
const { maskContact, maskEmail } = require('../api_dispatcher');
const S = require('../public/ops_state');

const P = '+5511987654321';

const CASES = [
  // [digitado, tipo, valor guardado, codigo do erro]
  ['11 98765-4321', 'phone', P, null],
  ['(11)98765-4321', 'phone', P, null],
  ['(11) 98765-4321', 'phone', P, null],
  ['11987654321', 'phone', P, null],
  ['+55 11 98765-4321', 'phone', P, null],
  ['+5511987654321', 'phone', P, null],
  ['5511987654321', 'phone', P, null],
  ['011 98765 4321', 'phone', P, null],
  ['  21.99876.5432 ', 'phone', '+5521998765432', null],
  ['(11) 3456-7890', 'phone', '1134567890', 'invalid_phone'], // fixo
  ['11 2345-67890', 'phone', '11234567890', 'invalid_phone'], // 11 digitos sem o 9
  ['(20) 98765-4321', 'phone', '20987654321', 'invalid_phone'], // DDD que nao existe
  ['98765-4321', 'phone', '987654321', 'invalid_phone'], // sem DDD
  ['+1 415 555 0100', 'phone', '14155550100', 'invalid_phone'], // fora do Brasil
  ['119876543210', 'phone', '119876543210', 'invalid_phone'], // digito a mais
  ['+55 98765-4321', 'phone', '987654321', 'invalid_phone'], // +55 sem DDD (nao e DDD 55)
  ['A@X.com ', 'email', 'a@x.com', null],
  ['joao.silva@exemplo.com.br', 'email', 'joao.silva@exemplo.com.br', null],
  ['a@b', 'email', 'a@b', 'invalid_email'],
  ['ab', 'email', 'ab', 'invalid_email'], // sem @, curto demais para apelido
  ['11 9876 x', 'nickname', '11 9876 x', null], // letra sem @: nao e celular, vira apelido
  ['', 'empty', '', null],
  ['   ', 'empty', '', null],
];

test('parseContact: tabela de casos (e-mail, celular, fixo, DDD, digitos)', () => {
  for (const [raw, type, value, code] of CASES) {
    const c = S.parseContact(raw);
    assert.equal(c.type, type, raw);
    assert.equal(c.value, value, raw);
    assert.equal(c.error ? c.error.code : null, code, raw);
    if (code) assert.ok(c.error.text.length > 0, `motivo para ${raw}`);
  }
});

test('parseContact: o motivo diz o que falta', () => {
  assert.match(S.parseContact('98765-4321').error.text, /DDD/);
  assert.match(S.parseContact('(11) 3456-7890').error.text, /fixo/);
  assert.match(S.parseContact('(20) 98765-4321').error.text, /DDD 20/);
  assert.match(S.parseContact('+1 415 555 0100').error.text, /Brasil/);
});

test('formatContact: celular legivel, e-mail igual', () => {
  assert.equal(S.formatContact(P), '(11) 98765-4321');
  assert.equal(S.formatContact('a@x.com'), 'a@x.com');
  assert.equal(S.formatContact(''), '');
});

test('registerBlockers: celular invalido trava com o motivo; celular valido libera', () => {
  const ok = { source: 'neurosky', email: 'a@x.com', noSignup: false, state: 'waiting' };
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, email: '11 98765-4321' }, 2: ok }), []);
  const [b] = S.registerBlockers({ 1: { ...ok, email: '98765-4321' }, 2: ok });
  assert.equal(b.slot, 1); assert.equal(b.code, 'invalid_phone'); assert.match(b.text, /^P1: .*DDD/);
});

test('filterRecentPlayers: acha o celular digitado de qualquer jeito', () => {
  const list = [{ contact: P, lastAt: 2 }, { contact: 'mar@site.com', lastAt: 1 }];
  for (const q of ['(11) 98765-4321', '11 98765', '+55 11 9876', '4321', '987654321']) {
    assert.deepEqual(S.filterRecentPlayers(list, q), [list[0]], q);
  }
  assert.deepEqual(S.filterRecentPlayers(list, 'mar'), [list[1]]);
});

function make() {
  const redis = new FakeRedis();
  let clock = 1000;
  const session = createSessionManager(redis, {}, () => {}, { now: () => clock });
  return { redis, session, tick: () => { clock += 1000; } };
}

async function race(session, finish = [1, 2]) {
  await session.onRaceStarted();
  for (const player of [1, 2]) await session.onEsense({ player, source: 'real', attention: 70, timeStamp: 1 });
  for (const playerId of finish) await session.onHasFinished({ playerId });
}

test('celular nao e bot: registra como contato, guardado no formato unico', async () => {
  const { redis, session } = make();
  await session.registerPlayers('(11) 98765-4321', 'b@x.com');
  const p = await redis.hgetall('pending:players');
  assert.equal(p.player1Email, P);
  assert.equal(p.player1Kind, 'contact');
});

test('pronto 1: P1 celular e P2 e-mail geram 2 registros, um com player_phone e outro com player_email', async () => {
  const { redis, session } = make();
  await session.registerPlayers('11 98765-4321', 'b@x.com');
  await race(session);
  const queue = (await redis.lrange('dispatch:queue', 0, -1)).map((r) => JSON.parse(r));
  assert.equal(queue.length, 2);
  const [b1, b2] = queue.map(toCanonicalBody);
  assert.equal(b1.player_phone, P); assert.equal('player_email' in b1, false);
  assert.equal(b2.player_email, 'b@x.com'); assert.equal('player_phone' in b2, false);
});

test('pronto 2: P1 celular contra P2 Bot gera 1 registro', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('+55 11 98765-4321', '');
  await race(session);
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1);
  assert.equal(toCanonicalBody(JSON.parse(queue[0])).player_phone, P);
});

test('pronto 3: celular invalido nao registra e diz o campo', async () => {
  const { redis, session } = make();
  await assert.rejects(() => session.registerPlayers('a@x.com', '98765-4321'), (err) => err.code === 'invalid_phone' && err.field === 'player2Email' && /DDD/.test(err.reason));
  assert.deepEqual(await redis.hgetall('pending:players'), {});
  assert.deepEqual(await session.getRecentPlayers(), []);
});

test('pronto 4: "(11) 98765-4321" e "+5511987654321" viram uma linha so nos ultimos jogadores', async () => {
  const { session, tick } = make();
  await session.registerPlayers('(11) 98765-4321', '', { p2NoSignup: true });
  tick();
  await session.registerPlayers('+5511987654321', '', { p2NoSignup: true });
  const list = await session.getRecentPlayers();
  assert.deepEqual(list, [{ contact: P, lastAt: 2000 }]);
});

test('vincular aceita celular; celular invalido volta invalid_phone', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  assert.deepEqual(await session.linkPlayer(1, '11 9876'), { ok: false, error: 'invalid_phone' });
  const res = await session.linkPlayer(1, '(11) 98765-4321');
  assert.equal(res.ok, true);
  assert.equal((await redis.hgetall('session:current')).player1Email, P);
  assert.deepEqual((await session.getRecentPlayers()).map((p) => p.contact), [P]);
});

test('historico e Nao subiram mostram o celular mascarado', () => {
  assert.equal(maskContact(P), '(11) *****-4321');
  assert.equal(maskContact('joao@x.com'), maskEmail('joao@x.com'));
  assert.equal(maskContact(''), null);
  assert.equal(maskContact(undefined), null);
});

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP: celular invalido volta 400 invalid_phone com o campo', async () => {
  const { session } = make();
  const server = createHttpServer(() => ({ status: 'ok' }), session);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const res = await post(port, '/api/players', JSON.stringify({ player1Email: '11 2345', player2Email: 'b@x.com' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_phone');
    assert.equal(res.body.field, 'player1Email');
    const ok = await post(port, '/api/players', JSON.stringify({ player1Email: '11 98765-4321', player2Email: 'b@x.com' }));
    assert.equal(ok.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
