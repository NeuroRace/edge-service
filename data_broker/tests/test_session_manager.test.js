const test = require('node:test');
const assert = require('node:assert/strict');

const { FakeRedis } = require('./fake_redis');
const { createSessionManager, execMulti } = require('../session_manager');

const noopLog = () => {};

function makeSession(redis = new FakeRedis()) {
  return { redis, session: createSessionManager(redis, {}, noopLog) };
}

test('registerPlayers grava emails em pending:players', async () => {
  const { redis, session } = makeSession();
  const result = await session.registerPlayers('a@x.com', 'b@x.com');

  const pending = await redis.hgetall('pending:players');
  assert.equal(pending.player1Email, 'a@x.com');
  assert.equal(pending.player2Email, 'b@x.com');
  assert.equal(result.player1.validated, false);
});

test('onRaceStarted cria sessao com raceId e detecta bot por email vazio', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();

  const s = await redis.hgetall('session:current');
  assert.ok(s.id, 'deve ter um raceId (uuid)');
  assert.equal(s.status, 'active');
  assert.equal(s.player1IsBot, 'false');
  assert.equal(s.player2IsBot, 'true');
  // pending consumido
  assert.deepEqual(await redis.hgetall('pending:players'), {});
});

test('onEsense acumula pacote de humano e ignora bot e sem-sessao', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');

  await session.onEsense({ player: 1, source: 'real', attention: 50, timeStamp: 1 });
  await session.onEsense({ player: 1, source: 'bot', attention: 99, timeStamp: 2 }); // ignorado
  const stored = await redis.lrange(`session:${s.id}:player:1:packets`, 0, -1);
  assert.equal(stored.length, 1, 'so o pacote humano e acumulado');

  // sem sessao ativa: nao lanca, nao acumula
  await redis.del('session:current');
  await session.onEsense({ player: 1, source: 'real', attention: 10, timeStamp: 3 });
});

test('onHasFinished persiste resultado em dispatch:queue e remove a lista de pacotes', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  await session.onEsense({ player: 1, source: 'real', attention: 70, meditation: 40, timeStamp: 10 });

  await session.onHasFinished({ playerId: 1 });

  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1);
  const record = JSON.parse(queue[0]);
  assert.equal(record.playerId, 1);
  assert.equal(record.sessionId, s.id);
  assert.equal(record.payload.email, 'human@x.com');
  assert.equal(record.payload.packets.length, 1);
  // lista de pacotes consolidada e removida (anti-leak)
  assert.equal(await redis.llen(`session:${s.id}:player:1:packets`), 0);
});

test('onHasFinished e idempotente: segundo evento do mesmo jogador e ignorado (claim atomico)', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();

  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 1 }); // duplicado

  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1, 'duplicado nao gera segundo registro');
});

test('onHasFinished ignora jogador bot', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('human@x.com', ''); // player2 = bot
  await session.onRaceStarted();

  await session.onHasFinished({ playerId: 2 });
  assert.equal((await redis.lrange('dispatch:queue', 0, -1)).length, 0);
});

test('REGRESSAO C3: flags Dispatched nao vazam entre corridas — 2a corrida persiste', async () => {
  const { redis, session } = makeSession();

  // Corrida 1
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 1 });
  assert.equal((await redis.lrange('dispatch:queue', 0, -1)).length, 1);

  // Corrida 2 (mesmo processo/Redis)
  await session.registerPlayers('human2@x.com', '');
  await session.onRaceStarted();
  await session.onEsense({ player: 1, source: 'real', attention: 5, timeStamp: 1 });
  await session.onHasFinished({ playerId: 1 });

  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 2, 'a 2a corrida tambem deve persistir (flag foi resetada)');
  assert.equal(JSON.parse(queue[1]).payload.email, 'human2@x.com');
});

test('onRaceStarted limpa as listas de pacotes da corrida anterior (anti-leak)', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();
  const s1 = await redis.hgetall('session:current');
  await session.onEsense({ player: 1, source: 'real', attention: 1, timeStamp: 1 });
  assert.equal(await redis.llen(`session:${s1.id}:player:1:packets`), 1);

  // Nova corrida sem finalizar a anterior: a lista antiga deve sumir
  await session.registerPlayers('human2@x.com', '');
  await session.onRaceStarted();
  assert.equal(await redis.llen(`session:${s1.id}:player:1:packets`), 0);
});

test('REGRESSAO H2: um pacote corrompido nao derruba a consolidacao', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  const key = `session:${s.id}:player:1:packets`;
  await redis.rpush(key, JSON.stringify({ attention: 1 }));
  await redis.rpush(key, '{corrompido'); // JSON invalido
  await redis.rpush(key, JSON.stringify({ attention: 2 }));

  await session.onHasFinished({ playerId: 1 });

  const record = JSON.parse((await redis.lrange('dispatch:queue', 0, -1))[0]);
  assert.equal(record.payload.packets.length, 2, 'mantem os 2 validos, descarta o corrompido');
});

test('onHasFinished libera o claim em falha para permitir reprocessamento', async () => {
  const redis = new FakeRedis();
  // Forca falha no lrange (apos o claim) uma unica vez
  let failed = false;
  const original = redis.lrange.bind(redis);
  redis.lrange = async (...args) => {
    if (!failed) {
      failed = true;
      throw new Error('redis indisponivel');
    }
    return original(...args);
  };
  const session = createSessionManager(redis, {}, noopLog);
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();

  await assert.rejects(() => session.onHasFinished({ playerId: 1 }), /indisponivel/);
  // flag liberada -> retry funciona
  await session.onHasFinished({ playerId: 1 });
  assert.equal((await redis.lrange('dispatch:queue', 0, -1)).length, 1);
});

test('onHasFinished com playerId invalido nao persiste nem grava flag', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();

  await session.onHasFinished({}); // sem playerId
  await session.onHasFinished({ playerId: 3 }); // fora de {1,2}

  assert.equal((await redis.lrange('dispatch:queue', 0, -1)).length, 0);
  const s = await redis.hgetall('session:current');
  assert.ok(!('playerundefinedDispatched' in s), 'nao grava flag para player undefined');
  assert.ok(!('player3Dispatched' in s), 'nao grava flag para player fora do range');
});

test('execMulti lanca quando uma op do multi falha (erro por-comando)', async () => {
  const fakeMulti = { exec: async () => [[null, 1], [new Error('WRONGTYPE'), null]] };
  await assert.rejects(() => execMulti(fakeMulti), /WRONGTYPE/);
});

test('execMulti retorna normalmente quando todas as ops sao ok', async () => {
  const fakeMulti = { exec: async () => [[null, 1], [null, 2]] };
  const results = await execMulti(fakeMulti);
  assert.equal(results.length, 2);
});

test('getCurrentSession reporta none e depois active', async () => {
  const { session } = makeSession();
  assert.deepEqual(await session.getCurrentSession(), { status: 'none' });

  await session.registerPlayers('human@x.com', '');
  await session.onRaceStarted();
  const cur = await session.getCurrentSession();
  assert.equal(cur.status, 'active');
  assert.equal(cur.player1Email, 'human@x.com');
  assert.ok(cur.sessionId);
});
