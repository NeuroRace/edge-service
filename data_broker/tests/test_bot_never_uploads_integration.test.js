// NEU-86 (spec B2), CA contra Redis real: a escolha do painel decide quem vai para a fila.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionManager } = require('../session_manager');
const { PLAYER_SETUP_KEY } = require('../player_setup');

const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : 'REDIS_URL nao definido';
const KEYS = ['pending:players', 'session:current', 'dispatch:queue', PLAYER_SETUP_KEY];

async function withRedis(fn) {
  const Redis = require('ioredis');
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  await redis.del(...KEYS);
  try { await fn(redis, createSessionManager(redis, {}, () => {})); } finally {
    await redis.del(...KEYS);
    await redis.zrem('players:recent', 'humano-neu86@x.com', 'bot-neu86@x.com');
    await redis.quit();
  }
}

async function race(session, { p1, p2 }) {
  await session.registerPlayers('humano-neu86@x.com', 'bot-neu86@x.com');
  await session.onRaceStarted();
  if (p1) await session.onEsense({ player: 1, source: 'real', attention: 50, timeStamp: 1 });
  if (p2) await session.onEsense({ player: 2, source: 'real', attention: 50, timeStamp: 1 });
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
}

test('integracao B2: NeuroSky cadastrado x Bot = 1 registro, o do P1', { skip }, async () => {
  await withRedis(async (redis, session) => {
    await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
    await race(session, { p1: true, p2: true });
    const queue = await redis.lrange('dispatch:queue', 0, -1);
    assert.deepEqual(queue.map((r) => JSON.parse(r).playerId), [1]);
  });
});

test('integracao B2: Bot x Bot = 0 registros', { skip }, async () => {
  await withRedis(async (redis, session) => {
    await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'bot', 'p2Source', 'bot');
    await race(session, { p1: true, p2: true });
    assert.equal(await redis.llen('dispatch:queue'), 0);
  });
});
