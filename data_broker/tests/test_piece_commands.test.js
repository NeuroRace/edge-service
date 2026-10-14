// NEU-86: o broker manda a escolha do painel so para a peca certa.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPieceCommands } = require('../piece_commands');

function fakeSetup(state) { return { get: () => JSON.parse(JSON.stringify(state)) }; }
function fakeSocket() {
  return { sent: [], handlers: {}, emit(event, payload) { this.sent.push([event, payload]); }, on(event, fn) { this.handlers[event] = fn; } };
}
const STATE = { 1: { source: 'bot', camera: null }, 2: { source: 'neurosky', camera: 2 } };

test('acquisition recebe a fonte guardada assim que conecta', () => {
  const cmds = createPieceCommands(fakeSetup(STATE));
  const a1 = fakeSocket(); const a2 = fakeSocket();
  cmds.attach(a1, 'acquisition-p1'); cmds.attach(a2, 'acquisition-p2');
  assert.deepEqual(a1.sent, [['setSource', { source: 'bot' }]]);
  assert.deepEqual(a2.sent, [['setSource', { source: 'neurosky' }]]);
});

test('gesto so recebe camera quando ha escolha guardada', () => {
  const cmds = createPieceCommands(fakeSetup(STATE));
  const g1 = fakeSocket(); const g2 = fakeSocket();
  cmds.attach(g1, 'gesture-p1'); cmds.attach(g2, 'gesture-p2');
  assert.deepEqual(g1.sent, []);
  assert.deepEqual(g2.sent, [['setCamera', { camera: 2 }]]);
});

test('pushSource vai so para a acquisition daquele jogador', () => {
  const state = JSON.parse(JSON.stringify(STATE));
  const cmds = createPieceCommands({ get: () => state });
  const s = { a1: fakeSocket(), a1b: fakeSocket(), a2: fakeSocket(), g1: fakeSocket(), panel: fakeSocket() };
  cmds.attach(s.a1, 'acquisition-p1'); cmds.attach(s.a1b, 'acquisition-p1'); cmds.attach(s.a2, 'acquisition-p2');
  cmds.attach(s.g1, 'gesture-p1'); cmds.attach(s.panel, 'panel');
  for (const x of Object.values(s)) x.sent = [];
  state[1].source = 'neurosky';
  cmds.pushSource(1);
  assert.deepEqual(s.a1.sent, [['setSource', { source: 'neurosky' }]]);
  assert.deepEqual(s.a1b.sent, [['setSource', { source: 'neurosky' }]]); // reconexao com socket velho aberto
  for (const k of ['a2', 'g1', 'panel']) assert.deepEqual(s[k].sent, [], k);
});

test('socket desconectado nao recebe mais', () => {
  const cmds = createPieceCommands(fakeSetup(STATE));
  const g2 = fakeSocket();
  cmds.attach(g2, 'gesture-p2');
  g2.handlers.disconnect();
  g2.sent = [];
  cmds.pushCamera(2);
  assert.deepEqual(g2.sent, []);
});

test('pushAll reenvia tudo (broker leu a escolha do Redis depois que as pecas conectaram)', () => {
  const state = { 1: { source: 'neurosky', camera: null }, 2: { source: 'neurosky', camera: null } };
  const cmds = createPieceCommands({ get: () => state });
  const a2 = fakeSocket(); const g1 = fakeSocket();
  cmds.attach(a2, 'acquisition-p2'); cmds.attach(g1, 'gesture-p1');
  state[2].source = 'bot'; state[1].camera = 1;
  cmds.pushAll();
  assert.deepEqual(a2.sent.at(-1), ['setSource', { source: 'bot' }]);
  assert.deepEqual(g1.sent, [['setCamera', { camera: 1 }]]);
});
