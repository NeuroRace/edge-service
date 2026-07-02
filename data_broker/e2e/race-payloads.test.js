// data_broker/e2e/race-payloads.test.js
//
// Testa os geradores puros de payload do harness produtor de corrida (NEU-70).
// Invariantes cobertas:
//  - ContractValid: os eventos gerados passam no validador REAL do broker
//    (event_contracts.js) E nas faixas numericas do contrato da nuvem (contract.ts).
//  - Deterministic: mesma entrada -> mesma saida (sem clock/random).
//  - LocalOnly: o guard anti-producao recusa alvos que nao sejam locais.
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateEventPayload } = require('../event_contracts');
const {
  buildEsense,
  buildTelemetry,
  buildHandGesture,
  assertLocalTarget,
} = require('./race-payloads');

const CLOUD_STATUS = new Set(['ok', 'poor', 'no-signal', 'unknown']);

function isInt(n) {
  return typeof n === 'number' && Number.isInteger(n);
}

test('ContractValid_esense_passa_no_validador_real_do_broker', () => {
  for (const player of [1, 2]) {
    for (const index of [0, 1, 5, 17, 42]) {
      const p = buildEsense({ player, index });
      assert.equal(
        validateEventPayload('eSense', p),
        null,
        `eSense player=${player} index=${index} deveria ser valido no broker`,
      );
    }
  }
});

test('ContractValid_esense_respeita_faixas_do_contrato_cloud', () => {
  for (const index of [0, 1, 2, 3, 4, 10, 99]) {
    const p = buildEsense({ player: 1, index });
    assert.ok(isInt(p.attention) && p.attention >= 0 && p.attention <= 100, 'attention int 0..100');
    assert.ok(isInt(p.meditation) && p.meditation >= 0 && p.meditation <= 100, 'meditation int 0..100');
    assert.ok(isInt(p.timeStamp), 't (timeStamp) inteiro');
    assert.ok(
      p.poorSignalLevel === null || (isInt(p.poorSignalLevel) && p.poorSignalLevel >= 0 && p.poorSignalLevel <= 200),
      'poorSignalLevel null ou int 0..200',
    );
    assert.ok(CLOUD_STATUS.has(p.status), 'status no enum do contrato');
    assert.ok(p.eegPower && typeof p.eegPower === 'object' && !Array.isArray(p.eegPower), 'eegPower objeto');
    assert.equal(p.source, 'real', 'source real (bot nao e persistido)');
    assert.equal(p.player, 1);
  }
});

test('ContractValid_handGesture_passa_no_validador_real_do_broker', () => {
  const g = buildHandGesture({ player: 2, index: 3 });
  assert.equal(validateEventPayload('handGesture', g), null);
});

test('Deterministic_mesma_entrada_mesma_saida', () => {
  assert.deepEqual(buildEsense({ player: 1, index: 7 }), buildEsense({ player: 1, index: 7 }));
  assert.deepEqual(
    buildTelemetry({ player: 2, points: 20 }),
    buildTelemetry({ player: 2, points: 20 }),
  );
});

test('Deterministic_timeStamps_estritamente_crescentes', () => {
  const seq = buildTelemetry({ player: 1, points: 10 });
  assert.equal(seq.length, 10);
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i].timeStamp > seq[i - 1].timeStamp, 'timeStamp deve crescer');
  }
});

test('LocalOnly_aceita_alvo_local', () => {
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.doesNotThrow(() => assertLocalTarget(url), `deveria aceitar ${url}`);
  }
});

test('LocalOnly_recusa_alvo_remoto', () => {
  for (const url of ['http://evil.example.com:3000', 'https://neurorace.vercel.app', 'http://10.0.0.5:3000']) {
    assert.throws(() => assertLocalTarget(url), /non_local|nao.?local|refus/i, `deveria recusar ${url}`);
  }
});

test('LocalOnly_trata_host_sem_esquema', () => {
  // host:port sem http:// (o URL parser trata 'localhost:' como esquema) — deve ACEITAR local
  for (const t of ['localhost:3000', '127.0.0.1:3000', 'localhost', '127.0.0.1']) {
    assert.doesNotThrow(() => assertLocalTarget(t), `deveria aceitar ${t}`);
  }
  // e RECUSAR remoto mesmo sem esquema (fail-closed)
  for (const t of ['evil.example.com:3000', '10.0.0.5:3000', 'neurorace.vercel.app']) {
    assert.throws(() => assertLocalTarget(t), /non_local|nao.?local|refus/i, `deveria recusar ${t}`);
  }
});
