// NEU-140 (spec B8a): cada lado entra na corrida como contact, nosignup, bot ou missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { PLAYER_SETUP_KEY } = require('../player_setup');

function make() {
  const redis = new FakeRedis();
  return { redis, session: createSessionManager(redis, {}, () => {}) };
}

test('registro: lado NeuroSky vazio sem Sem cadastro e recusado com missing_contact', async () => {
  const { session } = make();
  await assert.rejects(() => session.registerPlayers('a@x.com', ''), (err) => err.code === 'missing_contact' && err.field === 'player2Email');
  await assert.rejects(() => session.registerPlayers('', 'b@x.com'), (err) => err.code === 'missing_contact' && err.field === 'player1Email');
});

test('registro: Sem cadastro grava kind nosignup no pending', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  const p = await redis.hgetall('pending:players');
  assert.equal(p.player1Kind, 'contact'); assert.equal(p.player1NoSignup, 'false');
  assert.equal(p.player2Kind, 'nosignup'); assert.equal(p.player2NoSignup, 'true');
  const cur = await session.getCurrentSession();
  assert.equal(cur.pending.player1Kind, 'contact'); assert.equal(cur.pending.player2Kind, 'nosignup');
});

test('registro: contato valido ganha de Sem cadastro marcado', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com', { p2NoSignup: true });
  assert.equal((await redis.hgetall('pending:players')).player2Kind, 'contact');
});

test('registro: e-mail invalido continua invalid_email, mesmo com Sem cadastro', async () => {
  const { session } = make();
  await assert.rejects(() => session.registerPlayers('ab', '', { p1NoSignup: true, p2NoSignup: true }), (err) => err.code === 'invalid_email' && err.field === 'player1Email');
});

test('registro: lado em Bot ignora e-mail e Sem cadastro', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', '');
  assert.equal((await redis.hgetall('pending:players')).player2Kind, 'bot');
});

test('largada: cada lado vira o kind certo e IsBot so e false para contact', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.equal(s.player1Kind, 'contact'); assert.equal(s.player1IsBot, 'false');
  assert.equal(s.player2Kind, 'nosignup'); assert.equal(s.player2IsBot, 'true');
  const cur = await session.getCurrentSession();
  assert.equal(cur.player1Kind, 'contact'); assert.equal(cur.player2Kind, 'nosignup');
});

test('largada sem registro: os dois lados ficam missing', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.equal(s.player1Kind, 'missing'); assert.equal(s.player2Kind, 'missing');
  assert.equal(s.player1IsBot, 'true');
});

test('largada: Bot no setup manda, mesmo com contato registrado', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'bot');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.equal(s.player1Kind, 'bot'); assert.equal(s.player1Email, '');
});

test('largada: lado registrado como Bot que voltou a NeuroSky vira missing', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', '');
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'neurosky');
  await session.onRaceStarted();
  assert.equal((await redis.hgetall('session:current')).player2Kind, 'missing');
});

test('pending antigo (sem NoSignup) com e-mail vazio vira missing na largada', async () => {
  const { redis, session } = make();
  await redis.hset('pending:players', 'player1Email', 'a@x.com', 'player1Uuid', '', 'player2Email', '', 'player2Uuid', '');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.equal(s.player1Kind, 'contact'); assert.equal(s.player2Kind, 'missing');
});

test('sessao antiga sem kind: getCurrentSession deriva do IsBot', async () => {
  const { redis, session } = make();
  await redis.hset('session:current', 'id', 's-old', 'startedAt', '1000', 'status', 'active',
    'player1Email', 'a@x.com', 'player1IsBot', 'false', 'player2Email', '', 'player2IsBot', 'true');
  const cur = await session.getCurrentSession();
  assert.equal(cur.player1Kind, 'contact'); assert.equal(cur.player2Kind, 'bot');
});
