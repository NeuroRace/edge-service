const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionManager } = require('../session_manager');

// Teste de integracao contra um Redis REAL. So roda quando REDIS_URL esta definido
// (localmente e no CI via service). Sem REDIS_URL, e pulado — nao quebra quem nao
// tem Redis. Use um Redis dedicado/efemero: o teste limpa suas chaves fixas.
const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : 'REDIS_URL nao definido';

const noopLog = () => {};
const FIXED_KEYS = ['pending:players', 'session:current', 'dispatch:queue'];

async function freshClient() {
  const Redis = require('ioredis');
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  await client.del(...FIXED_KEYS);
  return client;
}

test('integracao: fluxo completo persiste resultado no Redis real', { skip }, async () => {
  const redis = await freshClient();
  try {
    const session = createSessionManager(redis, {}, noopLog);
    await session.registerPlayers('human@x.com', '');
    await session.onRaceStarted();
    await session.onEsense({ player: 1, source: 'real', attention: 70, timeStamp: 1 });
    await session.onEsense({ player: 1, source: 'real', attention: 71, timeStamp: 2 });
    await session.onHasFinished({ playerId: 1 });

    const queue = await redis.lrange('dispatch:queue', 0, -1);
    assert.equal(queue.length, 1);
    const record = JSON.parse(queue[0]);
    assert.equal(record.payload.email, 'human@x.com');
    assert.equal(record.payload.packets.length, 2);
  } finally {
    await redis.del(...FIXED_KEYS);
    await redis.quit();
  }
});

test('integracao: flag Dispatched nao vaza entre corridas (HSETNX real)', { skip }, async () => {
  const redis = await freshClient();
  try {
    const session = createSessionManager(redis, {}, noopLog);

    // Corrida 1
    await session.registerPlayers('a@x.com', '');
    await session.onRaceStarted();
    await session.onHasFinished({ playerId: 1 });
    await session.onHasFinished({ playerId: 1 }); // duplicado real -> HSETNX bloqueia

    // Corrida 2
    await session.registerPlayers('b@x.com', '');
    await session.onRaceStarted();
    await session.onHasFinished({ playerId: 1 });

    const queue = await redis.lrange('dispatch:queue', 0, -1);
    assert.equal(queue.length, 2, 'corrida 1 (sem duplicar) + corrida 2');
    assert.equal(JSON.parse(queue[1]).payload.email, 'b@x.com');
  } finally {
    await redis.del(...FIXED_KEYS);
    await redis.quit();
  }
});
