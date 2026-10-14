// NEU-142: metadados das pecas (versao, ThinkGear, camera), conexoes e eventos do jogo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresence, sanitizeMeta, buildStatus } = require('../presence');

test('sanitizeMeta: so campos conhecidos; string cortada em 64; numero nao finito fora', () => {
  assert.deepEqual(sanitizeMeta({ role: 'acquisition', player: 1, version: 'abc1234', source: 'real', eegHost: 'x'.repeat(10_000), acqPort: 13854, hack: 'y', camera: NaN, commit: '' }), {
    version: 'abc1234', source: 'real', eegHost: 'x'.repeat(64), acqPort: 13854,
  });
  assert.deepEqual(sanitizeMeta(undefined), {});
  assert.deepEqual(sanitizeMeta('lixo'), {});
});

test('peca leva a meta do socket mais recente; peca sem socket tem meta vazia', () => {
  const p = createPresence();
  p.onConnect('a2', { role: 'acquisition', player: 2, version: 'v2', eegHost: 'host.docker.internal', acqPort: 13854 }, 1);
  const s = p.snapshot();
  assert.deepEqual(s.pieces['acquisition-p2'].meta, { version: 'v2', eegHost: 'host.docker.internal', acqPort: 13854 });
  assert.deepEqual(s.pieces['acquisition-p1'].meta, {});
});

test('connections conta sockets abertos por chave', () => {
  const p = createPresence();
  p.onConnect('a', { role: 'panel' }, 1);
  p.onConnect('b', { role: 'panel' }, 1);
  p.onConnect('c', {}, 1);
  p.onConnect('d', { role: 'gesture', player: 1 }, 1);
  assert.deepEqual(p.snapshot().connections, { panel: 2, unidentified: 1, 'gesture-p1': 1 });
  p.onDisconnect('b');
  assert.equal(p.snapshot().connections.panel, 1);
});

test('recentEvents: ultimos 5 eventos do jogo, mais recente primeiro; sobrevivem a desconexao', () => {
  const p = createPresence();
  p.onConnect('g', {}, 1);
  for (let i = 1; i <= 7; i += 1) p.onEvent('g', i % 2 ? 'raceStarted' : 'hasFinished', {}, i * 10);
  p.onConnect('panel', { role: 'panel' }, 1);
  p.onEvent('panel', 'gameEvent', {}, 999);
  p.onDisconnect('g');
  const ev = p.snapshot().game.recentEvents;
  assert.equal(ev.length, 5);
  assert.deepEqual(ev[0], { event: 'raceStarted', at: 70 });
  assert.deepEqual(ev[4], { event: 'raceStarted', at: 30 }); // 7 eventos (10..70): ficam 70..30
});

test('buildStatus: inclui broker.version e uptime pelo relogio do broker', () => {
  const p = createPresence();
  const s = buildStatus({ presence: p, redisStatus: 'ready', brokerVersion: 'abc1234', startedAt: 1_000, now: 181_000 });
  assert.equal(s.now, 181_000);
  assert.deepEqual(s.redis, { status: 'ready' });
  assert.deepEqual(s.broker, { version: 'abc1234', uptimeSeconds: 180 });
  assert.ok(s.pieces && s.game && s.connections);
});
