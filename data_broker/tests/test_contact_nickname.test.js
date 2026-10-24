// O painel aceita tambem o APELIDO do site (profiles.display_name), alem de e-mail e
// celular. Sem `@`, nao-celular e com 3..20 caracteres = apelido; vai para a nuvem em
// player_nickname (sem player_email). A nuvem compara sem caixa; o edge guarda como digitado.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { createHttpServer } = require('../http_server');
const { createDispatchAdmin } = require('../dispatch_admin');
const { toCanonicalBody } = require('../dispatch_mapping');
const { contactLabel } = require('../api_dispatcher');
const S = require('../public/ops_state');

test('test_Nickname_parseContact: 3..20 chars sem @ e nao-celular = apelido, guardado com trim e caixa original', () => {
  assert.deepEqual(S.parseContact('  Corredor99 '), { type: 'nickname', value: 'Corredor99', error: null });
  assert.deepEqual(S.parseContact('foo'), { type: 'nickname', value: 'foo', error: null });
  assert.deepEqual(S.parseContact('Ana Paula'), { type: 'nickname', value: 'Ana Paula', error: null });
  assert.deepEqual(S.parseContact('a'.repeat(20)), { type: 'nickname', value: 'a'.repeat(20), error: null });
  assert.deepEqual(S.parseContact('11 9876 x'), { type: 'nickname', value: '11 9876 x', error: null });
  assert.equal(S.parseContact('\u{1F600}'.repeat(20)).type, 'nickname', 'emoji conta 1 caractere');
});

test('test_Nickname_parseContact: curto ou longo demais continua invalid_email', () => {
  for (const bad of ['ab', ' ab ', 'a'.repeat(21), '\u{1F600}a']) {
    const c = S.parseContact(bad);
    assert.equal(c.error && c.error.code, 'invalid_email', bad);
    assert.equal(c.error.text, 'e-mail ou apelido inválido', bad);
  }
});

test('test_Nickname_parseContact: com @ e celular seguem iguais', () => {
  assert.deepEqual(S.parseContact('A@X.com '), { type: 'email', value: 'a@x.com', error: null });
  assert.deepEqual(S.parseContact('a@b'), { type: 'email', value: 'a@b', error: { code: 'invalid_email', text: 'e-mail inválido' } });
  assert.deepEqual(S.parseContact('11 98765-4321'), { type: 'phone', value: '+5511987654321', error: null });
  assert.equal(S.parseContact('11 9876').error.code, 'invalid_phone');
});

test('test_Nickname_registerBlockers: apelido libera o Registrar', () => {
  const ok = { source: 'neurosky', email: 'a@x.com', noSignup: false, state: 'waiting' };
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, email: 'Corredor' }, 2: ok }), []);
});

test('test_Nickname_contactFieldState: placeholder fala de apelido', () => {
  assert.equal(S.contactFieldState({ source: 'neurosky', noSignup: false, state: 'waiting' }).placeholder, 'e-mail, celular ou apelido');
});

test('test_Nickname_mapping: payload.nickname vira player_nickname, sem player_email nem player_phone', () => {
  const body = toCanonicalBody({ jobId: 'j', sessionId: 's', playerId: 1, payload: { email: null, nickname: 'Corredor', startedAt: 1, finishedAt: 2, packets: [] } });
  assert.equal(body.player_nickname, 'Corredor');
  assert.equal('player_email' in body, false);
  assert.equal('player_phone' in body, false);
  const email = toCanonicalBody({ jobId: 'j', sessionId: 's', playerId: 1, payload: { email: 'a@x.com', startedAt: 1, finishedAt: 2, packets: [] } });
  assert.equal(email.player_email, 'a@x.com');
  assert.equal('player_nickname' in email, false);
});

function make() {
  const redis = new FakeRedis();
  let clock = 1000;
  const session = createSessionManager(redis, {}, () => {}, { now: () => clock });
  return { redis, session };
}

async function race(session) {
  await session.onRaceStarted();
  for (const player of [1, 2]) await session.onEsense({ player, source: 'real', attention: 70, timeStamp: 1 });
  for (const playerId of [1, 2]) await session.onHasFinished({ playerId });
}

test('test_Nickname_session: P1 apelido e P2 e-mail geram payload { email: null, nickname } e player_email', async () => {
  const { redis, session } = make();
  await session.registerPlayers('  Corredor ', 'b@x.com');
  const p = await redis.hgetall('pending:players');
  assert.equal(p.player1Email, 'Corredor');
  assert.equal(p.player1Kind, 'contact');
  await race(session);
  const queue = (await redis.lrange('dispatch:queue', 0, -1)).map((r) => JSON.parse(r));
  assert.equal(queue.length, 2);
  assert.equal(queue[0].payload.email, null);
  assert.equal(queue[0].payload.nickname, 'Corredor');
  assert.equal('phone' in queue[0].payload, false);
  const [b1, b2] = queue.map(toCanonicalBody);
  assert.equal(b1.player_nickname, 'Corredor'); assert.equal('player_email' in b1, false);
  assert.equal(b2.player_email, 'b@x.com'); assert.equal('player_nickname' in b2, false);
});

test('test_Nickname_link: Vincular aceita apelido; curto demais volta invalid_email', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  assert.deepEqual(await session.linkPlayer(1, 'ab'), { ok: false, error: 'invalid_email' });
  const res = await session.linkPlayer(1, ' Corredor ');
  assert.equal(res.ok, true);
  assert.equal((await redis.hgetall('session:current')).player1Email, 'Corredor');
});

test('test_Nickname_label: historico e Nao subiram mostram o apelido inteiro; e-mail e celular mascarados', async () => {
  assert.equal(contactLabel({ email: null, nickname: 'Corredor' }), 'Corredor');
  assert.equal(contactLabel({ email: null, phone: '+5511987654321' }), '(11) *****-4321');
  assert.equal(contactLabel({ email: 'joao@x.com' }), 'jo***@x.com');
  assert.equal(contactLabel(undefined), null);
  const redis = new FakeRedis();
  const raw = JSON.stringify({ jobId: 'job-n', playerId: 1, sessionId: 's', persistedAt: 1, payload: { email: null, nickname: 'Corredor', packets: [] } });
  await redis.rpush('dispatch:deadletter', JSON.stringify({ reason: 'permanent', jobId: 'job-n', httpStatus: 422, errorCode: 'player_nickname_not_found', attempts: 1, error: null, raw, failedAt: 1 }));
  const o = await createDispatchAdmin(redis, () => {}).overview();
  assert.equal(o.failed[0].email, 'Corredor');
  assert.equal(o.failed[0].retryable, true);
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

test('test_Nickname_http: /api/players aceita apelido; curto demais volta 400 invalid_email', async () => {
  const { redis, session } = make();
  const server = createHttpServer(() => ({ status: 'ok' }), session);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const bad = await post(port, '/api/players', JSON.stringify({ player1Email: 'ab', player2Email: 'b@x.com' }));
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: 'invalid_email', field: 'player1Email' });
    const ok = await post(port, '/api/players', JSON.stringify({ player1Email: 'Corredor', player2Email: 'b@x.com' }));
    assert.equal(ok.status, 200);
    assert.equal((await redis.hgetall('pending:players')).player1Email, 'Corredor');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
