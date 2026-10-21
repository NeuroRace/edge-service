// NEU-86 (spec B2): quem decide que o jogador e bot e a escolha do painel, nao o rotulo do dado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { PLAYER_SETUP_KEY } = require('../player_setup');
const { RACE_LOCK_MS } = require('../public/ops_state');

const T = 1_700_000_000_000;
function make(redis = new FakeRedis()) {
  return { redis, session: createSessionManager(redis, {}, () => {}, { now: () => T }) };
}

test('lado em Bot: o registro ignora o e-mail e ele nao entra nos ultimos jogadores', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', 'b@x.com');
  const pending = await redis.hgetall('pending:players');
  assert.deepEqual([pending.player1Email, pending.player2Email], ['a@x.com', '']);
  assert.deepEqual((await session.getRecentPlayers()).map((p) => p.contact), ['a@x.com']);
});

test('largada: lado que virou Bot depois do registro corre como bot', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'bot');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.deepEqual([s.player1IsBot, s.player1Email, s.player2IsBot, s.player2Email], ['true', '', 'false', 'b@x.com']);
});

test('B2: NeuroSky cadastrado x Bot = 1 registro na fila, mesmo com o bot mandando dado "real"', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onEsense({ player: 1, source: 'real', attention: 50, timeStamp: 1 });
  await session.onEsense({ player: 2, source: 'real', attention: 60, timeStamp: 1 }); // perfil banca: simulador como real
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1);
  assert.equal(JSON.parse(queue[0]).playerId, 1);
});

test('B2: Bot x Bot = 0 registros', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'bot', 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onEsense({ player: 1, source: 'real', attention: 50, timeStamp: 1 });
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
});

async function activeSession(redis, fields) {
  await redis.hset('session:current', 'id', 's1', 'status', 'active', 'player1IsBot', 'false', 'player2IsBot', 'true', ...fields);
}

test('raceInProgress: sem sessao, nao', async () => {
  const { session } = make();
  assert.equal(await session.raceInProgress(), false);
});

test('raceInProgress: humano correndo ha 1 min, sim; depois que ele termina, nao', async () => {
  const { redis, session } = make();
  await activeSession(redis, ['startedAt', String(T - 60_000)]);
  assert.equal(await session.raceInProgress(), true);
  await redis.hset('session:current', 'player1Dispatched', 'true');
  assert.equal(await session.raceInProgress(), false);
});

test('raceInProgress: sessao esquecida (mais de 10 min) nao trava para sempre', async () => {
  const { redis, session } = make();
  await activeSession(redis, ['startedAt', String(T - RACE_LOCK_MS - 60_000)]);
  assert.equal(await session.raceInProgress(), false);
});

test('raceInProgress: bot contra bot nao trava', async () => {
  const { redis, session } = make();
  await activeSession(redis, ['startedAt', String(T - 60_000), 'player1IsBot', 'true']);
  assert.equal(await session.raceInProgress(), false);
});
