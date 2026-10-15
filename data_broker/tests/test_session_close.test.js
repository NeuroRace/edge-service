// NEU-140 (spec C6, L3): Parar e expirar fecham a sessao; eventos atrasados sao ignorados.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { RACE_LOCK_MS } = require('../public/ops_state');

function make() {
  const redis = new FakeRedis(); const logs = []; const clock = { t: 1_000_000 };
  const session = createSessionManager(redis, {}, (level, message, meta) => logs.push({ level, message, ...meta }), { now: () => clock.t });
  return { redis, session, logs, clock };
}
const esense = (player) => ({ player, source: 'real', attention: 50, timeStamp: 1 });

test('Parar: cancela, apaga pacotes e o hasFinished atrasado nao vai para a fila', async () => {
  const { redis, session, logs } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.onEsense(esense(1));
  assert.deepEqual(await session.stopRace(), { ok: true, sessionId: id });
  const s = await redis.hgetall('session:current');
  assert.equal(s.status, 'cancelled'); assert.ok(s.closedAt);
  assert.equal(await redis.llen(`session:${id}:player:1:packets`), 0);
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
  assert.ok(logs.find((l) => l.message === 'has_finished_ignored_closed_session' && l.status === 'cancelled' && l.playerId === 1));
  assert.ok(logs.find((l) => l.message === 'race_stopped' && l.sessionId === id));
});

test('Parar: a proxima largada consolida normalmente (CA de C6)', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.stopRace();
  await session.onHasFinished({ playerId: 1 });
  await session.registerPlayers('c@x.com', 'd@x.com');
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  await session.onHasFinished({ playerId: 1 });
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1); assert.equal(JSON.parse(queue[0]).payload.email, 'c@x.com');
});

test('Parar: nao mexe na proxima dupla registrada', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.registerPlayers('c@x.com', 'd@x.com');
  await session.stopRace();
  assert.equal((await redis.hgetall('pending:players')).player1Email, 'c@x.com');
});

test('Parar sem corrida aberta: no_active_session', async () => {
  const { session } = make();
  assert.deepEqual(await session.stopRace(), { ok: false, error: 'no_active_session' });
});

test('Parar duas vezes: a segunda e no_active_session', async () => {
  const { session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.stopRace();
  assert.deepEqual(await session.stopRace(), { ok: false, error: 'no_active_session' });
});

test('eSense depois do Parar: nao cria lista e loga uma vez so', async () => {
  const { redis, session, logs } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.stopRace();
  await session.onEsense(esense(1)); await session.onEsense(esense(1)); await session.onEsense(esense(2));
  assert.equal(await redis.llen(`session:${id}:player:1:packets`), 0);
  assert.equal(logs.filter((l) => l.message === 'esense_ignored_closed_session').length, 1);
});

test('expira: com 10 min da largada a sessao vira expired na leitura, uma vez', async () => {
  const { redis, session, logs, clock } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.onEsense(esense(1));
  clock.t += RACE_LOCK_MS - 1;
  assert.equal((await session.getCurrentSession()).status, 'active');
  clock.t += 1;
  assert.equal((await session.getCurrentSession()).status, 'expired');
  assert.equal((await session.getCurrentSession()).status, 'expired');
  assert.equal(logs.filter((l) => l.message === 'session_expired').length, 1);
  assert.equal(await redis.llen(`session:${id}:player:1:packets`), 0);
});

test('expira: hasFinished depois de 11 min e ignorado', async () => {
  const { redis, session, logs, clock } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  clock.t += 11 * 60 * 1000;
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
  assert.ok(logs.find((l) => l.message === 'has_finished_ignored_closed_session' && l.status === 'expired'));
});

test('raceInProgress: falso depois do Parar; lado missing conta como humano', async () => {
  const { session, clock } = make();
  await session.onRaceStarted(); // ninguem registrado: os dois missing
  assert.equal(await session.raceInProgress(clock.t + 1000), true);
  await session.stopRace();
  assert.equal(await session.raceInProgress(clock.t + 1000), false);
});

test('fechar nao fecha a sessao nova se o jogo largou no meio (id confere)', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const old = await redis.hgetall('session:current');
  // Simula: a leitura do Parar viu a sessao velha, mas o jogo ja largou a nova.
  const realHgetall = redis.hgetall.bind(redis);
  let once = true;
  redis.hgetall = async (key) => {
    if (once && key === 'session:current') {
      once = false;
      const snapshot = await realHgetall(key);
      await session.registerPlayers('c@x.com', 'd@x.com');
      await session.onRaceStarted();
      return snapshot;
    }
    return realHgetall(key);
  };
  const res = await session.stopRace();
  redis.hgetall = realHgetall;
  assert.deepEqual(res, { ok: false, error: 'no_active_session' });
  const cur = await redis.hgetall('session:current');
  assert.notEqual(cur.id, old.id); assert.equal(cur.status, 'active');
});
