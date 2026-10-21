// Revisoes do #37 e do #36 (NEU-140/141).
// #37: com um lado em "Terminou" e o outro ainda correndo, o Registrar ficava liberado. O campo
// de quem corre fica travado mostrando o contato em uso, entao registrar ali mandava esse
// contato para a proxima dupla: a pessoa seguinte levava o contato de quem ainda estava na pista.
// #36: Parar depois que um lado ja chegou dizia "nada foi gravado", mas o tempo dele ja estava na fila.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const S = require('../public/ops_state');

test('registerBlockers: lado correndo trava o Registrar com o motivo', () => {
  const ok = { source: 'neurosky', email: 'a@x.com', noSignup: false, state: 'waiting' };
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, state: 'finished' }, 2: { ...ok, state: 'racing' } }),
    [{ slot: 2, code: 'side_racing', text: 'P2 ainda está correndo: espere a chegada para registrar a próxima dupla' }]);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, state: 'racing' }, 2: { ...ok, state: 'racing' } }).map((b) => b.code), ['side_racing', 'side_racing'],
    'os dois correndo: os dois campos mostram quem esta na pista');
  for (const state of ['finished', 'sent', 'rejected', 'registered', 'waiting']) {
    assert.deepEqual(S.registerBlockers({ 1: { ...ok, state }, 2: ok }), [], `${state} nao trava`);
  }
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, source: 'bot', state: 'racing' }, 2: ok }), [], 'Bot nao tem contato');
});

test('startBlockers: com corrida em andamento, o Largar mostra o motivo uma vez so', () => {
  const register = S.registerBlockers({ 1: { source: 'neurosky', email: 'a@x.com', state: 'racing' }, 2: { source: 'neurosky', email: 'b@x.com', state: 'finished' } });
  const out = S.startBlockers({ register, gameConnected: true, panelConnected: true, sessionActive: true, sources: { 1: 'neurosky', 2: 'neurosky' } });
  assert.deepEqual(out.map((b) => b.code), ['race_active']);
});

function makeSession() {
  const redis = new FakeRedis();
  return { redis, session: createSessionManager(redis, {}, () => {}) };
}

test('stopRace: diz quem ja tinha o tempo gravado', async () => {
  const { redis, session } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onEsense({ player: 1, source: 'real', attention: 50, timeStamp: 1 });
  await session.onHasFinished({ playerId: 1 });
  assert.equal((await session.getCurrentSession()).player1Saved, true, 'o painel ve que o P1 ja foi gravado');
  assert.equal((await session.getCurrentSession()).player2Saved, false);
  const r = await session.stopRace();
  assert.equal(r.ok, true);
  assert.deepEqual(r.saved, [1], 'o P1 ja estava na fila');
  assert.equal(await redis.llen('dispatch:queue'), 1, 'o Parar nao tira o P1 da fila');
});

test('stopRace: ninguem chegou -> saved vazio; descarte sem EEG nao conta como gravado', async () => {
  const { session } = makeSession();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 2 }); // sem pacote: descarte, nao gravado
  const r = await session.stopRace();
  assert.equal(r.saved, undefined, 'ninguem gravado: a resposta e a de antes ({ ok, sessionId })');
});

test('stopFeedback: texto do painel depois do Parar', () => {
  assert.equal(S.stopFeedback({ saved: [], told: true }), 'Corrida parada, nada foi gravado. O jogo volta para a espera.');
  assert.equal(S.stopFeedback({ saved: [], told: false }), 'Corrida parada, nada foi gravado. Pare também no jogo.');
  assert.equal(S.stopFeedback({ saved: [1], told: true }), 'Corrida parada. O tempo do P1 já tinha sido gravado e vai para o site; o do P2 não foi gravado. O jogo volta para a espera.');
  assert.equal(S.stopFeedback({ saved: [2], told: false }), 'Corrida parada. O tempo do P2 já tinha sido gravado e vai para o site; o do P1 não foi gravado. Pare também no jogo.');
  assert.equal(S.stopFeedback({ saved: undefined, told: true }), 'Corrida parada, nada foi gravado. O jogo volta para a espera.', 'broker antigo sem saved');
});
