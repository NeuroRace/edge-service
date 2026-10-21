// NEU-140: estados novos do card, travas do Registrar e alerta por lado.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

const active = (over = {}) => ({ status: 'active', sessionId: 's1', startedAt: 100, player1Email: '', player2Email: '', player1IsBot: true, player2IsBot: true, ...over });
const card = (slot, session, extra = {}) => S.cardState({ slot, session, pending: null, raceEvents: {}, history: [], ...extra });

test('cardState: pending com kind', () => {
  const pending = { player1Email: 'a@x.com', player2Email: '', player1Kind: 'contact', player2Kind: 'nosignup' };
  assert.equal(S.cardState({ slot: 1, session: { status: 'none' }, pending, raceEvents: {}, history: [] }), 'registered');
  assert.equal(S.cardState({ slot: 2, session: { status: 'none' }, pending, raceEvents: {}, history: [] }), 'nosignup');
  assert.equal(S.cardState({ slot: 2, session: { status: 'none' }, pending: { ...pending, player2Kind: 'bot' }, raceEvents: {}, history: [] }), 'bot');
  assert.equal(S.cardState({ slot: 2, session: { status: 'none' }, pending: { ...pending, player2Kind: 'missing' }, raceEvents: {}, history: [] }), 'waiting');
});

test('cardState: corrida com missing, lost, nosignup e bot', () => {
  const s = active({ player1Kind: 'missing', player2Kind: 'nosignup' });
  assert.equal(card(1, s), 'missing');
  assert.equal(card(1, { ...s, player1Finished: true }), 'lost');
  assert.equal(card(1, s, { raceEvents: { 1: true } }), 'lost');
  assert.equal(card(2, s), 'nosignup');
  assert.equal(card(2, active({ player2Kind: 'bot' })), 'bot');
  assert.equal(card(1, active({ player1Kind: 'contact', player1IsBot: false, player1Email: 'a@x.com' })), 'racing');
});

test('cardState: sessao sem kind (broker antigo) deriva do IsBot', () => {
  assert.equal(card(2, active()), 'bot');
  assert.equal(card(1, active({ player1IsBot: false })), 'racing');
});

test('cardState: sessao cancelled ou expired = waiting', () => {
  assert.equal(card(1, active({ status: 'cancelled', player1Kind: 'contact' })), 'waiting');
  assert.equal(card(1, active({ status: 'expired', player1Kind: 'missing' })), 'waiting');
});

test('setupLocked: lado missing trava; sessao cancelled nao', () => {
  const now = 200;
  assert.equal(S.setupLocked({ session: active({ player1Kind: 'missing', player2Kind: 'bot' }), raceEvents: {}, history: [], now }), true);
  assert.equal(S.setupLocked({ session: active({ status: 'cancelled', player1Kind: 'contact', player1IsBot: false }), raceEvents: {}, history: [], now }), false);
});

test('registerBlockers: contato, vazio, Sem cadastro, invalido, Bot e corrida sem cadastro', () => {
  const ok = { source: 'neurosky', email: 'a@x.com', noSignup: false, state: 'waiting' };
  assert.deepEqual(S.registerBlockers({ 1: ok, 2: ok }), []);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, email: '  ' }, 2: ok }), [{ slot: 1, code: 'missing_contact', text: 'P1: digite o contato ou marque Sem cadastro' }]);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, email: '', noSignup: true }, 2: ok }), []);
  assert.deepEqual(S.registerBlockers({ 1: ok, 2: { ...ok, email: 'foo' } }), [{ slot: 2, code: 'invalid_email', text: 'P2: e-mail inválido' }]);
  assert.deepEqual(S.registerBlockers({ 1: ok, 2: { ...ok, email: 'foo', noSignup: true } }), [{ slot: 2, code: 'invalid_email', text: 'P2: e-mail inválido' }]);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, source: 'bot', email: '' }, 2: ok }), []);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, source: null, email: '' }, 2: ok }).map((b) => b.code), ['missing_contact'], 'sem resposta do broker = NeuroSky');
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, state: 'missing' }, 2: ok }), [{ slot: 1, code: 'link_first', text: 'P1: corrida sem cadastro, use Vincular' }]);
});

test('alerts: um lado missing acende o alerta daquele lado; dois lados, um alerta so', () => {
  const base = { health: { discardedRaces: 0, dispatcher: { enabled: true, counts: { queue: 0, processing: 0, deadletter: 0 } } }, signals: {}, now: 10_000, queueSince: null, prevDiscarded: 0 };
  const one = S.alerts({ ...base, session: active({ player1Kind: 'missing', player2Kind: 'bot' }) });
  assert.deepEqual(one.map((a) => a.code), ['race_missing_contact']);
  assert.equal(one[0].text, 'P1 largou sem cadastro. Digite o contato e clique em Vincular antes de terminar.');
  const two = S.alerts({ ...base, session: active({ player1Kind: 'missing', player2Kind: 'missing' }) });
  assert.equal(two[0].text, 'P1 e P2 largaram sem cadastro. Digite o contato e clique em Vincular antes de terminar.');
  assert.deepEqual(S.alerts({ ...base, session: active({ player1Kind: 'bot', player2Kind: 'bot' }) }), [], 'bot x bot de proposito nao alerta');
  assert.deepEqual(S.alerts({ ...base, session: active({ player1Kind: 'missing', player1Finished: true, player2Kind: 'bot' }) }), [], 'depois do fim vira descarte, nao Vincular');
});
