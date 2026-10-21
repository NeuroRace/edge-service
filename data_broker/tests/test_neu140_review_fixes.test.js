// NEU-140: itens 1 a 3 da revisao do PR #32 (Pedro, 15/10).
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { RACE_LOCK_MS } = require('../public/ops_state');
const S = require('../public/ops_state');

function make() {
  const redis = new FakeRedis(); const logs = []; const discarded = []; const clock = { t: 1_000_000 };
  const session = createSessionManager(redis, {}, (level, message, meta) => logs.push({ level, message, ...meta }), {
    now: () => clock.t,
    onDiscarded: (info) => discarded.push(info),
  });
  return { redis, session, logs, discarded, clock };
}
const esense = (player) => ({ player, source: 'real', attention: 50, timeStamp: 1 });

// Item 1 (spec B8a): lado "Sem cadastro" ou esquecido nao e gravado, nem os pacotes.
test('item 1: chegada de lado Sem cadastro apaga a lista de pacotes', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.onEsense(esense(2)); await session.onEsense(esense(2));
  await session.onHasFinished({ playerId: 2 });
  assert.equal(await redis.llen(`session:${id}:player:2:packets`), 0);
  assert.equal(await redis.llen('dispatch:queue'), 0);
});

test('item 1: chegada de lado esquecido (sem vinculo) apaga a lista de pacotes', async () => {
  const { redis, session, discarded } = make();
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.onEsense(esense(1));
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen(`session:${id}:player:1:packets`), 0);
  assert.deepEqual(discarded.map((d) => d.reason), ['no_email_registered']);
});

// Item 2: Parar e chegada atomicos. O Parar cai entre a leitura dos pacotes e o enfileirar.
test('item 2: Parar entre a leitura dos pacotes e o enfileirar nao grava a corrida', async () => {
  const { redis, session, logs } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  const original = redis.lrange.bind(redis);
  redis.lrange = async (...args) => {
    const out = await original(...args);
    redis.lrange = original;
    await session.stopRace();
    return out;
  };
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
  assert.ok(logs.find((l) => l.message === 'has_finished_ignored_closed_session' && l.status === 'cancelled'));
});

test('item 2: sem Parar, a corrida continua indo para a fila e a lista some', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.onEsense(esense(1));
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 1);
  assert.equal(await redis.llen(`session:${id}:player:1:packets`), 0);
});

// Item 3: corrida humana que passa de 10 min nao some em silencio.
test('item 3: expirar com lado de gente que nao chegou conta como descarte', async () => {
  const { redis, session, logs, discarded, clock } = make();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  clock.t += RACE_LOCK_MS;
  await session.getCurrentSession();
  assert.deepEqual(discarded, [{ playerId: 1, sessionId: id, reason: 'session_expired' }]);
  assert.ok(logs.find((l) => l.message === 'session_expired_unfinished' && l.level === 'warn' && l.playerId === 1));
  await session.getCurrentSession();
  assert.equal(discarded.length, 1);
});

test('item 3: lado esquecido tambem conta; quem ja chegou nao', async () => {
  const { session, discarded, clock } = make();
  // O jogo largou sem ninguem registrado: P1 e P2 esquecidos. O P1 e vinculado e chega.
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  await session.linkPlayer(1, 'a@x.com');
  await session.onHasFinished({ playerId: 1 });
  clock.t += RACE_LOCK_MS;
  await session.getCurrentSession();
  assert.deepEqual(discarded.map((d) => [d.playerId, d.reason]), [[2, 'session_expired']]);
});

test('item 3: o painel explica o descarte por tempo', () => {
  const out = S.alerts({
    session: { status: 'none' },
    health: { discardedRaces: 1, lastDiscardReason: 'session_expired', dispatcher: { enabled: true, counts: { queue: 0, processing: 0, deadletter: 0 } } },
    signals: {}, now: 0, queueSince: null, prevDiscarded: 0,
  });
  const alert = out.find((a) => a.code === 'race_discarded');
  assert.match(alert.text, /10 min/);
});
