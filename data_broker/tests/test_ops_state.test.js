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
  assert.equal(S.cardState({ slot: 2, session: none, pending, raceEvents: {}, history: [] }), 'waiting', 'pending sem kind (broker antigo) com vazio');
  const active = { status: 'active', sessionId: 's1', player1Email: 'a@x.com', player2Email: '', player1IsBot: false, player2IsBot: true, startedAt: 100 };
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: {}, history: [] }), 'racing');
  assert.equal(S.cardState({ slot: 2, session: active, pending: null, raceEvents: {}, history: [] }), 'bot');
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
    session: { status: 'active', player1IsBot: true, player2IsBot: true, player1Kind: 'missing', player2Kind: 'missing' },
    health: { discardedRaces: 3, dispatcher: { enabled: false, reason: 'api_url_missing', counts: { queue: 2, processing: 0, deadletter: 0 } } },
    signals: { 1: { link: 'lost' }, 2: { link: 'ok' } }, now: 100_000, queueSince: 50_000, prevDiscarded: 2,
  });
  const codes = bad.map((a) => a.code);
  assert.deepEqual(codes, ['race_missing_contact', 'race_discarded', 'cloud_disabled', 'queue_stuck', 'signal_lost']);
  assert.ok(bad.every((a) => a.level === 'error' || a.level === 'warn'));
  assert.match(bad[0].text, /largaram sem cadastro/);
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

test('test_OpsState_history_is_correlated_by_sessionId_not_time', () => {
  // Envio atrasado da corrida ANTERIOR (sessionId diferente) chega depois da largada da atual.
  const active = { status: 'active', sessionId: 's2', player1Email: 'a@x.com', player2Email: 'b@x.com', player1IsBot: false, player2IsBot: false, startedAt: 100 };
  const late = [{ jobId: 'j-old', sessionId: 's1', playerId: 1, status: 'sent', at: 150 }];
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: {}, history: late }), 'racing', 'resultado de outra sessao nao conta');
  const mine = [{ jobId: 'j-new', sessionId: 's2', playerId: 1, status: 'sent', at: 150 }];
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: {}, history: mine }), 'sent');
});

test('test_OpsState_finished_flag_from_session_survives_reload_before_dispatch', () => {
  // hasFinished ja aconteceu (flag persistida), mas o dispatcher ainda nao enviou (fila) e a pagina recarregou.
  const active = { status: 'active', sessionId: 's1', player1Email: 'a@x.com', player2Email: 'b@x.com', player1IsBot: false, player2IsBot: false, startedAt: 100, player1Finished: true, player2Finished: false };
  assert.equal(S.cardState({ slot: 1, session: active, pending: null, raceEvents: {}, history: [] }), 'finished');
  assert.equal(S.cardState({ slot: 2, session: active, pending: null, raceEvents: {}, history: [] }), 'racing');
});

test('test_OpsState_queue_stuck_counts_retrying_races (NEU-92)', () => {
  assert.equal(S.pendingCount({ queue: 1, retrying: 2 }), 3);
  assert.equal(S.pendingCount({ queue: 1 }), 1, 'broker antigo sem retrying');
  assert.equal(S.pendingCount(undefined), 0);
  const list = S.alerts({
    session: { status: 'none' },
    health: { discardedRaces: 0, dispatcher: { enabled: true, counts: { queue: 0, processing: 0, retrying: 2, deadletter: 0 } } },
    signals: {}, now: 100_000, queueSince: 50_000, prevDiscarded: 0,
  });
  const stuck = list.find((a) => a.code === 'queue_stuck');
  assert.ok(stuck, 'nuvem fora: corridas reagendadas tambem contam como fila parada');
  assert.match(stuck.text, /^2 corrida\(s\) aguardando envio/);
});

test('setupLocked: trava enquanto alguem corre, ate 10 min da largada (NEU-86)', () => {
  const { setupLocked, RACE_LOCK_MS } = require('../public/ops_state');
  const now = 1_000_000_000;
  const racing = { status: 'active', sessionId: 's1', startedAt: now - 60_000, player1Email: 'a@x.com', player2Email: '', player1IsBot: false, player2IsBot: true };
  assert.equal(setupLocked({ session: { status: 'none' }, raceEvents: {}, history: [], now }), false);
  assert.equal(setupLocked({ session: racing, raceEvents: { 1: false, 2: false }, history: [], now }), true);
  assert.equal(setupLocked({ session: { ...racing, player1Finished: true }, raceEvents: {}, history: [], now }), false);
  assert.equal(setupLocked({ session: { ...racing, startedAt: now - RACE_LOCK_MS - 1 }, raceEvents: {}, history: [], now }), false, 'sessao esquecida nao trava');
  assert.equal(setupLocked({ session: { ...racing, player1IsBot: true }, raceEvents: {}, history: [], now }), false, 'bot x bot nao trava');
  assert.equal(setupLocked({ session: { ...racing, pending: { player1Email: 'b@x.com', player2Email: '' } }, raceEvents: {}, history: [], now }), true, 'proxima dupla registrada nao destrava');
});

test('cameraText: erro, troca em andamento ou nada (NEU-86)', () => {
  const { cameraText } = require('../public/ops_state');
  assert.equal(cameraText({ chosen: 2, inUse: 0, error: 'Câmera 3 não abriu; voltou para a Câmera 1' }), 'Câmera 3 não abriu; voltou para a Câmera 1');
  assert.equal(cameraText({ chosen: 2, inUse: 0, error: null }), 'trocando para a Câmera 3…');
  assert.equal(cameraText({ chosen: 1, inUse: 1, error: null }), '');
  assert.equal(cameraText({ chosen: null, inUse: 0, error: null }), '');
  assert.equal(cameraText({ chosen: 1, inUse: null, error: null }), '');
});

test('cameraSelectValue: o seletor mostra a camera em uso, nao a escolha que falhou (NEU-86)', () => {
  const { cameraSelectValue } = require('../public/ops_state');
  assert.equal(cameraSelectValue({ chosen: 2, inUse: 1 }), '1');
  assert.equal(cameraSelectValue({ chosen: 2, inUse: null }), '2', 'detector sem noticia: mostra a escolha');
  assert.equal(cameraSelectValue({ chosen: null, inUse: 0 }), '0');
  assert.equal(cameraSelectValue({ chosen: null, inUse: null }), '0');
});
