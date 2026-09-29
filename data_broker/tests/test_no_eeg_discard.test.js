// NEU-104: corrida humana sem pacote de EEG (fone desconectado, sem contato, ThinkGear
// fechado) nao vira resultado de ranking. O descarte e barulhento como o da NEU-73:
// log warn + hook (contador do /health) + alerta na tela de operacao.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { createRuntimeState } = require('../runtime_state');
const { loadBrokerConfig } = require('../config');
const S = require('../public/ops_state');

function makeSession(config = {}) {
  const redis = new FakeRedis(); const logs = []; const discards = [];
  const session = createSessionManager(redis, config, (level, message, meta) => logs.push({ level, message, ...meta }), {
    onDiscarded: (info) => discards.push(info),
  });
  return { redis, session, logs, discards };
}

test('test_NoEeg_human_finish_without_packets_is_discarded_loudly', async () => {
  const { redis, session, logs, discards } = makeSession();
  await session.registerPlayers('h@x.com', '');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');

  await session.onHasFinished({ playerId: 1 });

  assert.equal(await redis.llen('dispatch:queue'), 0, 'sem EEG nao vai para a fila da nuvem');
  const warn = logs.find((l) => l.message === 'has_finished_discarded_no_eeg');
  assert.ok(warn, 'descarte deve gerar log warn has_finished_discarded_no_eeg');
  assert.equal(warn.level, 'warn'); assert.equal(warn.playerId, 1); assert.equal(warn.sessionId, s.id);
  assert.equal(warn.reason, 'no_eeg_signal'); assert.equal(warn.packets, 0); assert.equal(warn.minPackets, 1);
  assert.equal(warn.email, undefined, 'log nao expoe o e-mail');
  assert.deepEqual(discards, [{ playerId: 1, sessionId: s.id, reason: 'no_eeg_signal' }]);
});

test('test_NoEeg_duplicate_hasFinished_after_discard_is_ignored', async () => {
  const { redis, session, discards } = makeSession();
  await session.registerPlayers('h@x.com', '');
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 1 });
  assert.equal(discards.length, 1, 'o claim segura o duplicado: um descarte so');
  assert.equal((await session.getCurrentSession()).player1Finished, true);
  assert.equal(await redis.llen('dispatch:queue'), 0);
});

test('test_NoEeg_only_corrupt_packets_counts_as_no_eeg', async () => {
  const { redis, session, discards } = makeSession();
  await session.registerPlayers('h@x.com', '');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  await redis.rpush(`session:${s.id}:player:1:packets`, '{corrompido');
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
  assert.equal(discards.length, 1);
  assert.equal(await redis.llen(`session:${s.id}:player:1:packets`), 0, 'lista descartada nao vaza');
});

test('test_NoEeg_minEegPackets_threshold_from_config', async () => {
  const below = makeSession({ minEegPackets: 3 });
  await below.session.registerPlayers('h@x.com', '');
  await below.session.onRaceStarted();
  await below.session.onEsense({ player: 1, source: 'real', attention: 1, timeStamp: 1 });
  await below.session.onEsense({ player: 1, source: 'real', attention: 2, timeStamp: 2 });
  await below.session.onHasFinished({ playerId: 1 });
  assert.equal(await below.redis.llen('dispatch:queue'), 0, '2 pacotes < minimo 3');
  assert.equal(below.logs.find((l) => l.message === 'has_finished_discarded_no_eeg').minPackets, 3);

  const enough = makeSession({ minEegPackets: 3 });
  await enough.session.registerPlayers('h@x.com', '');
  await enough.session.onRaceStarted();
  for (let i = 0; i < 3; i += 1) await enough.session.onEsense({ player: 1, source: 'real', attention: i, timeStamp: i });
  await enough.session.onHasFinished({ playerId: 1 });
  assert.equal(await enough.redis.llen('dispatch:queue'), 1);
  assert.equal(enough.discards.length, 0);
});

test('test_NoEeg_bot_discard_hook_carries_reason', async () => {
  const { session, discards } = makeSession();
  await session.registerPlayers('', '');
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 2 });
  assert.equal(discards.length, 1);
  assert.equal(discards[0].reason, 'no_email_registered');
});

test('test_NoEeg_config_min_packets_default_and_env', () => {
  assert.equal(loadBrokerConfig({}).minEegPackets, 1);
  assert.equal(loadBrokerConfig({ MIN_EEG_PACKETS: '5' }).minEegPackets, 5);
});

test('test_NoEeg_health_exposes_last_discard_reason', () => {
  const state = createRuntimeState(0, () => 1_000);
  assert.equal(state.snapshot().lastDiscardReason, null);
  state.markRaceDiscarded('no_eeg_signal');
  assert.equal(state.snapshot().discardedRaces, 1);
  assert.equal(state.snapshot().lastDiscardReason, 'no_eeg_signal');
});

test('test_NoEeg_ops_alert_text_follows_discard_reason', () => {
  const base = { session: { status: 'none' }, signals: {}, now: 0, queueSince: null, prevDiscarded: 0 };
  const disp = { enabled: true, counts: {} };
  const noEeg = S.alerts({ ...base, health: { discardedRaces: 1, lastDiscardReason: 'no_eeg_signal', dispatcher: disp } });
  assert.equal(noEeg[0].code, 'race_discarded');
  assert.match(noEeg[0].text, /sem sinal de EEG/);
  const noEmail = S.alerts({ ...base, health: { discardedRaces: 1, lastDiscardReason: 'no_email_registered', dispatcher: disp } });
  assert.match(noEmail[0].text, /falta de e-mail/);
});

test('test_NoEeg_ops_alert_registered_player_without_signal_before_start', () => {
  const health = { discardedRaces: 0, dispatcher: { enabled: true, counts: {} } };
  const session = { status: 'none', pending: { player1Email: 'a@x.com', player2Email: '' } };
  const list = S.alerts({ session, health, signals: { 1: { link: 'lost' }, 2: { link: 'lost' } }, now: 0, queueSince: null, prevDiscarded: 0 });
  const codes = list.map((a) => a.code);
  assert.deepEqual(codes, ['registered_without_signal', 'signal_lost'], 'jogador 1 vira erro; o 2 (anonimo) segue so aviso');
  assert.equal(list[0].level, 'error');
  assert.match(list[0].text, /jogador 1/i);
  const ok = S.alerts({ session, health, signals: { 1: { link: 'ok' }, 2: { link: 'ok' } }, now: 0, queueSince: null, prevDiscarded: 0 });
  assert.deepEqual(ok, []);
});
