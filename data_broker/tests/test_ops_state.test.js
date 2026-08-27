// NEU-68: logica pura da tela (estado por jogador, sinal, alertas). Determinista: now injetado.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

test('test_OpsState_normalizeEmail_and_validateEmail', () => {
  assert.equal(S.normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(S.normalizeEmail(''), '');
  assert.equal(S.validateEmail(''), true, 'vazio = anonimo, permitido');
  assert.equal(S.validateEmail('a@b.co'), true);
  assert.equal(S.validateEmail('foo'), false); assert.equal(S.validateEmail('a@b'), false); assert.equal(S.validateEmail('a b@x.com'), false);
});

test('test_OpsState_cardState_follows_operator_sequence', () => {
  const none = { status: 'none' };
  assert.equal(S.cardState({ slot: 1, session: none, pending: null, raceEvents: {}, history: [] }), 'waiting');
  const pending = { player1Email: 'a@x.com', player2Email: '' };
  assert.equal(S.cardState({ slot: 1, session: none, pending, raceEvents: {}, history: [] }), 'registered');
  assert.equal(S.cardState({ slot: 2, session: none, pending, raceEvents: {}, history: [] }), 'anonymous');
  const active = { status: 'active', sessionId: 's1', player1Email: 'a@x.com', player2Email: '', player1IsBot: false, player2IsBot: true, startedAt: 100 };
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: {}, history: [] }), 'racing');
  assert.equal(S.cardState({ slot: 2, session: active, pending: null, raceEvents: {}, history: [] }), 'anonymous');
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: { 1: true }, history: [] }), 'finished');
  const sent = [{ jobId: 'j', playerId: 1, status: 'sent', at: 150, sessionId: 's1' }];
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: { 1: true }, history: sent }), 'sent');
  const dead = [{ jobId: 'j', playerId: 1, status: 'deadletter', at: 150, sessionId: 's1' }];
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: { 1: true }, history: dead }), 'rejected');
  const old = [{ jobId: 'j', playerId: 1, status: 'sent', at: 50, sessionId: 's0' }];
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: { 1: true }, history: old }), 'finished', 'historico de corrida anterior nao conta');
});

test('test_OpsState_signalStatus_thresholds', () => {
  assert.deepEqual(S.signalStatus({ lastPacketAt: 9_000, now: 10_000, poorSignalLevel: 0 }), { link: 'ok', quality: 'good' });
  assert.deepEqual(S.signalStatus({ lastPacketAt: 5_000, now: 10_000, poorSignalLevel: 80 }), { link: 'slow', quality: 'weak' });
  assert.deepEqual(S.signalStatus({ lastPacketAt: 0, now: 20_000, poorSignalLevel: 200 }), { link: 'lost', quality: 'none' });
  assert.deepEqual(S.signalStatus({ lastPacketAt: null, now: 20_000, poorSignalLevel: null }), { link: 'lost', quality: 'none' });
});

test('test_OpsState_alerts_only_when_something_is_wrong', () => {
  const ok = S.alerts({
    session: { status: 'active', player1IsBot: false, player2IsBot: false },
    health: { discardedRaces: 0, dispatcher: { enabled: true, counts: { queue: 0, processing: 0, deadletter: 0 } } },
    signals: { 1: { link: 'ok' }, 2: { link: 'ok' } }, now: 10_000, queueSince: null, prevDiscarded: 0,
  });
  assert.deepEqual(ok, []);
  const bad = S.alerts({
    session: { status: 'active', player1IsBot: true, player2IsBot: true },
    health: { discardedRaces: 3, dispatcher: { enabled: false, reason: 'api_url_missing', counts: { queue: 2, processing: 0, deadletter: 0 } } },
    signals: { 1: { link: 'lost' }, 2: { link: 'ok' } }, now: 100_000, queueSince: 50_000, prevDiscarded: 2,
  });
  const codes = bad.map((a) => a.code);
  assert.deepEqual(codes, ['race_without_players', 'race_discarded', 'cloud_disabled', 'queue_stuck', 'signal_lost']);
  assert.ok(bad.every((a) => a.level === 'error' || a.level === 'warn'));
  assert.match(bad[0].text, /NÃO será salva/);
  assert.match(bad.find((a) => a.code === 'signal_lost').text, /jogador 1/i);
  const young = S.alerts({ session: { status: 'none' }, health: { discardedRaces: 0, dispatcher: { enabled: true, counts: { queue: 1, processing: 0, deadletter: 0 } } }, signals: {}, now: 60_000, queueSince: 40_000, prevDiscarded: 0 });
  assert.deepEqual(young.map((a) => a.code), [], 'fila com <30s nao alerta');
});

test('test_OpsState_cardState_survives_page_reload_history_implies_sent', () => {
  // Pagina aberta DEPOIS do hasFinished: raceEvents vazio, mas o historico da sessao atual existe.
  const active = { status: 'active', sessionId: 's1', player1Email: 'a@x.com', player2Email: 'b@x.com', player1IsBot: false, player2IsBot: false, startedAt: 100 };
  const hist = [{ jobId: 'j1', playerId: 1, status: 'sent', at: 150 }, { jobId: 'j2', playerId: 2, status: 'deadletter', at: 160 }];
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: {}, history: hist }), 'sent');
  assert.equal(S.cardState({ slot: 2, session: active, pending: null, raceEvents: {}, history: hist }), 'rejected');
});
