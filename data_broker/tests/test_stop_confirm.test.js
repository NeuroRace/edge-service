// NEU-181: depois do Parar, o painel espera o raceStopped do jogo (NEU-146: o jogo manda
// ao receber o stopRace, antes de voltar ao menu) antes de dizer que o jogo voltou para a
// espera. Sem confirmacao em 5 s, avisa e o operador decide (parar de novo ou largar).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

test('stopWaitState: esperando, confirmado e sem resposta', () => {
  assert.equal(S.STOP_CONFIRM_MS, 5000);
  assert.equal(S.stopWaitState({ wait: null, now: 0 }), 'none');
  assert.equal(S.stopWaitState({ wait: { since: 1000 }, now: 1000 }), 'waiting');
  assert.equal(S.stopWaitState({ wait: { since: 1000 }, now: 5999 }), 'waiting');
  assert.equal(S.stopWaitState({ wait: { since: 1000 }, now: 6000 }), 'timeout');
  assert.equal(S.stopWaitState({ wait: { since: 1000, confirmed: true }, now: 1200 }), 'confirmed');
  assert.equal(S.stopWaitState({ wait: { since: 1000, confirmed: true }, now: 99999 }), 'confirmed');
});

test('startBlockers: enquanto o jogo nao confirma o Parar, o Largar espera', () => {
  const base = { register: [], gameConnected: true, panelConnected: true, sessionActive: false, sources: { 1: 'neurosky', 2: 'neurosky' } };
  assert.deepEqual(S.startBlockers({ ...base, gameStopping: true }).map((b) => b.code), ['game_stopping']);
  assert.equal(S.startBlockers({ ...base, gameStopping: true })[0].text, 'Esperando o jogo confirmar que parou');
  assert.deepEqual(S.startBlockers({ ...base, gameStopping: false }), []);
  assert.deepEqual(S.startBlockers(base), [], 'sem o campo, como antes');
});

test('stopFeedback: texto do Parar em cada fase da confirmacao do jogo', () => {
  assert.equal(S.stopFeedback({ saved: [], told: true, game: 'waiting' }), 'Corrida parada, nada foi gravado. Parando o jogo…');
  assert.equal(S.stopFeedback({ saved: [], told: true, game: 'confirmed' }), 'Corrida parada, nada foi gravado. O jogo voltou para a espera.');
  assert.equal(S.stopFeedback({ saved: [1], told: true, game: 'timeout' }),
    'Corrida parada. O tempo do P1 já tinha sido gravado e vai para o site; o do P2 não foi gravado. O jogo não confirmou que parou: confira a tela do jogo e mande parar de novo. Largue mesmo assim só com o jogo no menu.');
  assert.equal(S.stopFeedback({ saved: [], told: false, game: 'waiting' }), 'Corrida parada, nada foi gravado. Pare também no jogo.', 'sem socket nao ha o que esperar');
});
