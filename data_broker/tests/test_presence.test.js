// NEU-139: quem esta conectado ao broker e quando deu noticia.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresence, keyFromAuth, PIECES } = require('../presence');

test('keyFromAuth: papeis validos, player como string e auth invalido', () => {
  assert.equal(keyFromAuth({ role: 'acquisition', player: 1 }), 'acquisition-p1');
  assert.equal(keyFromAuth({ role: 'gesture', player: '2' }), 'gesture-p2', 'player de env chega como string');
  assert.equal(keyFromAuth({ role: 'panel' }), 'panel');
  assert.equal(keyFromAuth({ role: 'test-client' }), 'test-client');
  assert.equal(keyFromAuth({ role: 'acquisition', player: 3 }), 'unidentified');
  assert.equal(keyFromAuth({ role: 'hacker' }), 'unidentified');
  assert.equal(keyFromAuth(undefined), 'unidentified');
  assert.equal(keyFromAuth('lixo'), 'unidentified');
});

test('snapshot: peca esperada sem socket fica desconectada', () => {
  const p = createPresence();
  const s = p.snapshot();
  assert.deepEqual(Object.keys(s.pieces), PIECES);
  assert.deepEqual(s.pieces['acquisition-p2'], { connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null, meta: {} });
  assert.deepEqual(s.game, { connections: 0, lastGameEvent: null, recentEvents: [] });
});

test('eSense e gestureStatus atualizam a peca; desconectar tira', () => {
  const p = createPresence();
  p.onConnect('a2', { role: 'acquisition', player: 2 }, 100);
  p.onConnect('g2', { role: 'gesture', player: 2 }, 100);
  p.onEvent('a2', 'eSense', { player: 2, attention: 70, poorSignalLevel: 26, source: 'real' }, 500);
  p.onEvent('g2', 'gestureStatus', { player: 2, handSeen: true }, 600);
  let s = p.snapshot();
  assert.deepEqual(s.pieces['acquisition-p2'], { connected: true, lastEventAt: 500, attention: 70, poorSignalLevel: 26, source: 'real', handSeen: null, meta: {} });
  assert.equal(s.pieces['gesture-p2'].handSeen, true);
  assert.equal(s.pieces['gesture-p2'].lastEventAt, 600);
  p.onDisconnect('a2');
  s = p.snapshot();
  assert.equal(s.pieces['acquisition-p2'].connected, false);
  assert.equal(s.pieces['acquisition-p2'].lastEventAt, null);
});

test('conectada sem nunca mandar nada: connected sem lastEventAt', () => {
  const p = createPresence();
  p.onConnect('a1', { role: 'acquisition', player: 1 }, 100);
  assert.deepEqual([p.snapshot().pieces['acquisition-p1'].connected, p.snapshot().pieces['acquisition-p1'].lastEventAt], [true, null]);
});

test('reconexao com socket velho aberto: vale a noticia mais recente', () => {
  const p = createPresence();
  p.onConnect('old', { role: 'acquisition', player: 1 }, 100);
  p.onEvent('old', 'eSense', { attention: 10, poorSignalLevel: 0, source: 'real' }, 200);
  p.onConnect('new', { role: 'acquisition', player: 1 }, 300);
  p.onEvent('new', 'eSense', { attention: 90, poorSignalLevel: 0, source: 'real' }, 400);
  let piece = p.snapshot().pieces['acquisition-p1'];
  assert.deepEqual([piece.connected, piece.lastEventAt, piece.attention], [true, 400, 90]);
  p.onDisconnect('old');
  piece = p.snapshot().pieces['acquisition-p1'];
  assert.deepEqual([piece.connected, piece.attention], [true, 90]);
});

test('jogo = conexoes nao identificadas; painel e test-client nao contam', () => {
  const p = createPresence();
  p.onConnect('panel-1', { role: 'panel' }, 1);
  p.onConnect('panel-2', { role: 'panel' }, 1);
  p.onConnect('tc', { role: 'test-client' }, 1);
  assert.equal(p.snapshot().game.connections, 0);
  p.onConnect('game', {}, 1);
  p.onEvent('game', 'raceStarted', {}, 50);
  p.onEvent('panel-1', 'hasFinished', {}, 60);
  assert.deepEqual(p.snapshot().game, { connections: 1, lastGameEvent: { event: 'raceStarted', at: 50 }, recentEvents: [{ event: 'raceStarted', at: 50 }] });
});

test('evento de socket desconhecido e ignorado', () => {
  const p = createPresence();
  assert.doesNotThrow(() => p.onEvent('nope', 'eSense', { attention: 1 }, 1));
});
