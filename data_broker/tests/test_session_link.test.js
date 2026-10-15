// NEU-140: vincular o contato a uma corrida largada sem registro (lado missing).
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');

function make() {
  const redis = new FakeRedis(); const logs = []; const discards = [];
  const session = createSessionManager(redis, {}, (level, message, meta) => logs.push({ level, message, ...meta }), { onDiscarded: (d) => discards.push(d) });
  return { redis, session, logs, discards };
}
const esense = (player) => ({ player, source: 'real', attention: 50, timeStamp: 1 });

test('vincular no meio: o hasFinished consolida com o e-mail vinculado', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  const res = await session.linkPlayer(1, '  Late@X.com ');
  assert.equal(res.ok, true); assert.equal(res.session.player1Kind, 'contact'); assert.equal(res.session.player1Email, 'late@x.com');
  await session.onHasFinished({ playerId: 1 });
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1); assert.equal(JSON.parse(queue[0]).payload.email, 'late@x.com');
  assert.equal((await session.getRecentPlayers())[0].contact, 'late@x.com');
});

test('vincular depois do hasFinished: already_finished e fila sem mudanca', async () => {
  const { redis, session, discards } = make();
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 1 });
  assert.equal(discards.length, 1); assert.equal(discards[0].reason, 'no_email_registered');
  assert.deepEqual(await session.linkPlayer(1, 'late@x.com'), { ok: false, error: 'already_finished' });
  assert.equal(await redis.llen('dispatch:queue'), 0);
});

test('vincular lado que nao e missing: not_missing', async () => {
  const { session } = make();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  await session.onRaceStarted();
  assert.deepEqual(await session.linkPlayer(1, 'b@x.com'), { ok: false, error: 'not_missing' });
  assert.deepEqual(await session.linkPlayer(2, 'b@x.com'), { ok: false, error: 'not_missing' });
});

test('vincular sem corrida, depois do Parar ou com entrada ruim', async () => {
  const { session } = make();
  assert.deepEqual(await session.linkPlayer(1, 'a@x.com'), { ok: false, error: 'no_active_session' });
  await session.onRaceStarted();
  assert.deepEqual(await session.linkPlayer(3, 'a@x.com'), { ok: false, error: 'invalid_player' });
  assert.deepEqual(await session.linkPlayer('1', 'a@x.com'), { ok: false, error: 'invalid_player' });
  assert.deepEqual(await session.linkPlayer(1, ''), { ok: false, error: 'invalid_email' });
  assert.deepEqual(await session.linkPlayer(1, 'foo'), { ok: false, error: 'invalid_email' });
  await session.stopRace();
  assert.deepEqual(await session.linkPlayer(1, 'a@x.com'), { ok: false, error: 'no_active_session' });
});

test('claim antes da releitura: vinculo gravado entre a chegada do hasFinished e o claim consolida', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  const realHsetnx = redis.hsetnx.bind(redis);
  let once = true;
  redis.hsetnx = async (key, field, value) => {
    if (once && field === 'player1Dispatched') { once = false; await session.linkPlayer(1, 'late@x.com'); }
    return realHsetnx(key, field, value);
  };
  await session.onHasFinished({ playerId: 1 });
  redis.hsetnx = realHsetnx;
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1); assert.equal(JSON.parse(queue[0]).payload.email, 'late@x.com');
});

test('bot e sem cadastro: nao vao para a fila e nao contam como descarte', async () => {
  const { redis, session, logs, discards } = make();
  await session.registerPlayers('', '', { p1NoSignup: true, p2NoSignup: true });
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
  assert.equal(discards.length, 0);
  assert.equal(logs.filter((l) => l.message === 'has_finished_not_saved' && l.kind === 'nosignup').length, 2);
});

test('hasFinished duplicado de lado missing: um descarte so', async () => {
  const { session, discards } = make();
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 2 });
  await session.onHasFinished({ playerId: 2 });
  assert.equal(discards.length, 1);
});
