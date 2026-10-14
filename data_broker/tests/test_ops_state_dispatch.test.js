// NEU-143: texto do motivo de cada corrida que nao subiu e o alerta de falhas no painel.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

test('failureText explica o motivo em portugues, com o que fazer', () => {
  assert.equal(S.failureText({ reason: 'exhausted', attempts: 8, httpStatus: null }), 'a nuvem não respondeu após 8 tentativas (sem internet?)');
  assert.equal(S.failureText({ reason: 'exhausted', attempts: 8, httpStatus: 503 }), 'a nuvem não respondeu após 8 tentativas (último HTTP 503)');
  assert.equal(S.failureText({ reason: 'permanent', httpStatus: 422, errorCode: 'invalid_payload' }), 'a nuvem recusou (HTTP 422: invalid_payload)');
  assert.equal(S.failureText({ reason: 'permanent', httpStatus: 401 }), 'a nuvem recusou a chave do estande (HTTP 401) · confira o EDGE_INGEST_TOKEN');
  assert.equal(S.failureText({ reason: 'mapping_failed', error: 'sem pacotes' }), 'erro ao montar o envio: sem pacotes');
  assert.equal(S.failureText({ reason: 'malformed_record' }), 'registro corrompido, não dá para reenviar');
  assert.equal(S.failureText({ reason: 'outra_coisa' }), 'outra_coisa');
  assert.equal(S.failureText({}), 'motivo desconhecido');
});

const base = { session: { status: 'none' }, health: { discardedRaces: 0, dispatcher: { enabled: true, counts: {} } }, signals: {}, now: 0, queueSince: null, prevDiscarded: 0 };

test('alerts: corrida que nao subiu gera aviso com a acao', () => {
  const list = S.alerts({ ...base, overview: { counts: { waiting: 0, sending: 0, failed: 2 } } });
  const a = list.find((x) => x.code === 'cloud_failed');
  assert.ok(a, 'alerta cloud_failed presente');
  assert.equal(a.level, 'warn');
  assert.match(a.text, /2 corrida\(s\) não subiram/);
  assert.match(a.text, /Reenviar/);
});

test('alerts: sem overview ou sem falhas, nada de cloud_failed', () => {
  assert.ok(!S.alerts(base).some((x) => x.code === 'cloud_failed'));
  assert.ok(!S.alerts({ ...base, overview: { counts: { failed: 0 } } }).some((x) => x.code === 'cloud_failed'));
});

test('cloudNeedsAttention: falha ou espera longa pedem atencao (bolinha Nuvem, NEU-139)', () => {
  const t = S.QUEUE_STUCK_MS;
  assert.equal(S.cloudNeedsAttention({ overview: null, waitingSince: null, now: 0 }), false);
  assert.equal(S.cloudNeedsAttention({ overview: { counts: { failed: 1, waiting: 0 } }, waitingSince: null, now: 0 }), true);
  assert.equal(S.cloudNeedsAttention({ overview: { counts: { failed: 0, waiting: 3 } }, waitingSince: 0, now: t - 1 }), false);
  assert.equal(S.cloudNeedsAttention({ overview: { counts: { failed: 0, waiting: 3 } }, waitingSince: 0, now: t + 1 }), true);
});
