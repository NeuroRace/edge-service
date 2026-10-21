// NEU-179: o hasFinished do jogo nao diz de qual corrida e. Um atrasado da corrida anterior
// caia na seguinte com tempo falso (0,45 s no teste) e ganhava a rodada. Defesa barata:
// chegada antes do piso (MIN_RACE_SECONDS) e ignorada sem gastar o lado, e o raceStopped
// do jogo fecha a sessao (antes so era repassado).
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { createRuntimeState } = require('../runtime_state');
const { loadBrokerConfig } = require('../config');

function makeSession(config = { minRaceSeconds: 15 }) {
  const redis = new FakeRedis(); const logs = []; const ignored = []; const clock = { t: 1_000_000 };
  const session = createSessionManager(redis, config, (level, message, meta) => logs.push({ level, message, ...meta }), {
    now: () => clock.t,
    onFinishIgnored: (info) => ignored.push(info),
  });
  return { redis, session, logs, ignored, clock };
}

async function packet(session, player) {
  await session.onEsense({ player, source: 'real', attention: 50, timeStamp: 1 });
}

test('test_LateFinish_finish_before_floor_is_ignored_and_side_still_counts', async () => {
  const { redis, session, logs, ignored, clock } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  await packet(session, 2);

  clock.t += 450; // o hasFinished velho da corrida anterior chega 0,45 s depois da largada
  await session.onHasFinished({ playerId: 2 });
  assert.equal(await redis.llen('dispatch:queue'), 0, 'chegada antes do piso nao vira corrida');
  const warn = logs.find((l) => l.message === 'has_finished_too_soon');
  assert.ok(warn, 'log warn has_finished_too_soon');
  assert.equal(warn.playerId, 2); assert.equal(warn.sessionId, s.id);
  assert.equal(warn.elapsedMs, 450); assert.equal(warn.minRaceMs, 15000);
  assert.deepEqual(ignored, [{ playerId: 2, sessionId: s.id, reason: 'too_soon', elapsedMs: 450, minRaceMs: 15000 }]);

  clock.t += 40_000; // a chegada de verdade dela, 40 s depois
  await packet(session, 2);
  await session.onHasFinished({ playerId: 2 });
  assert.equal(await redis.llen('dispatch:queue'), 1, 'a chegada de verdade ainda conta (o lado nao foi gasto)');
  const rec = JSON.parse((await redis.lrange('dispatch:queue', 0, -1))[0]);
  assert.equal(rec.playerId, 2); assert.equal(rec.payload.email, 'b@x.com');
});

test('test_LateFinish_finish_after_floor_is_unchanged', async () => {
  const { redis, session, ignored, clock } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await packet(session, 1);
  clock.t += 15_000; // exatamente no piso vale
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 1);
  assert.equal(ignored.length, 0);
});

test('test_LateFinish_floor_zero_or_unset_keeps_old_behavior', async () => {
  for (const config of [{}, { minRaceSeconds: 0 }]) {
    const { redis, session, clock } = makeSession(config);
    await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
    await session.onRaceStarted();
    await packet(session, 1);
    clock.t += 450;
    await session.onHasFinished({ playerId: 1 });
    assert.equal(await redis.llen('dispatch:queue'), 1, `sem piso (${JSON.stringify(config)}) a chegada rapida entra como hoje`);
  }
});

test('test_LateFinish_reproduces_review_scenario_stop_start_late_finish', async () => {
  // Revisao do edge #36: corrida A com o P2 sem chegada -> Parar -> corrida B larga ->
  // chega o hasFinished velho do P2 -> a pessoa nova do P2 ficava com ~0,45 s.
  const { redis, session, clock } = makeSession();
  await session.registerPlayers('a1@x.com', 'a2@x.com');
  await session.onRaceStarted();
  clock.t += 30_000;
  assert.equal((await session.stopRace()).ok, true);
  await session.registerPlayers('b1@x.com', 'b2@x.com');
  await session.onRaceStarted();
  await packet(session, 2);
  clock.t += 450;
  await session.onHasFinished({ playerId: 2 });
  assert.equal(await redis.llen('dispatch:queue'), 0, 'a pessoa nova do P2 nao leva o tempo falso');
  assert.equal((await session.getCurrentSession()).player2Finished, false, 'o P2 da corrida B segue correndo');
});

test('test_LateFinish_raceStopped_from_game_closes_active_session', async () => {
  const { redis, session, logs, clock } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  await packet(session, 1);
  clock.t += 30_000;
  await session.onRaceStopped();
  assert.equal((await redis.hgetall('session:current')).status, 'stopped');
  assert.equal(await session.raceInProgress(), false, 'o painel libera o Largar sem precisar do Parar');
  assert.ok(logs.find((l) => l.message === 'race_stopped_by_game' && l.sessionId === s.id));
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 0, 'chegada depois do raceStopped nao grava');
});

test('test_LateFinish_raceStopped_keeps_sides_already_sent', async () => {
  const { redis, session, clock } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await packet(session, 1); await packet(session, 2);
  clock.t += 30_000;
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
  await session.onRaceStopped(); // o jogo volta para a espera depois do podio
  assert.equal(await redis.llen('dispatch:queue'), 2, 'quem ja chegou continua na fila');
  assert.equal((await redis.hgetall('session:current')).status, 'stopped');
});

test('test_LateFinish_late_raceStopped_right_after_start_is_ignored', async () => {
  const { redis, session, logs, clock } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  clock.t += 300; // raceStopped da corrida anterior chegando atrasado
  await session.onRaceStopped();
  assert.equal((await redis.hgetall('session:current')).status, 'active', 'nao derruba a corrida que acabou de largar');
  assert.ok(logs.find((l) => l.message === 'race_stopped_too_soon'));
});

test('test_LateFinish_raceStopped_without_active_session_is_noop', async () => {
  const { redis, session, clock } = makeSession();
  await session.onRaceStopped();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  clock.t += 30_000;
  await session.stopRace(); // Parar do painel; o jogo depois avisa raceStopped
  await session.onRaceStopped();
  assert.equal((await redis.hgetall('session:current')).status, 'cancelled', 'o Parar do painel continua valendo');
});

test('test_LateFinish_config_and_health_counter', () => {
  assert.equal(loadBrokerConfig({}).minRaceSeconds, 15, 'no estande o piso e 15 s');
  assert.equal(loadBrokerConfig({ MIN_RACE_SECONDS: '0' }).minRaceSeconds, 0, '0 desliga (volta ao de antes)');
  assert.equal(loadBrokerConfig({ MIN_RACE_SECONDS: '20' }).minRaceSeconds, 20);
  const rs = createRuntimeState(0, () => 5);
  assert.equal(rs.snapshot().ignoredFinishes, 0);
  rs.markFinishIgnored();
  assert.equal(rs.snapshot().ignoredFinishes, 1);
  assert.equal(rs.snapshot().lastIgnoredFinishAt, 5);
});

test('test_LateFinish_panel_warns_while_that_race_is_open', () => {
  const S = require('../public/ops_state');
  const rs = createRuntimeState(0, () => 5);
  rs.markFinishIgnored({ sessionId: 'B', playerId: 2, elapsedMs: 450, minRaceMs: 15000, reason: 'too_soon' });
  const health = { ...rs.snapshot(), dispatcher: { enabled: true, counts: {} } };
  assert.deepEqual(health.lastIgnoredFinish, { sessionId: 'B', playerId: 2, elapsedMs: 450, minRaceMs: 15000 });
  const base = { signals: {}, now: 0, queueSince: null, prevDiscarded: 0, health };
  const warn = S.alerts({ ...base, session: { status: 'active', sessionId: 'B' } }).find((a) => a.code === 'finish_ignored');
  assert.ok(warn, 'avisa na corrida em que a chegada foi ignorada');
  assert.equal(warn.level, 'warn');
  assert.match(warn.text, /P2 ignorada: veio 0,5 s depois da largada \(o mínimo é 15 s\)/);
  assert.match(warn.text, /Parar corrida/);
  for (const session of [{ status: 'active', sessionId: 'C' }, { status: 'stopped', sessionId: 'B' }, { status: 'none' }]) {
    assert.ok(!S.alerts({ ...base, session }).some((a) => a.code === 'finish_ignored'), `sem aviso em ${JSON.stringify(session)}`);
  }
});
