// NEU-142: blocos do Diagnostico (estado, versao, detalhes, o que fazer) e aviso de versao.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

const T = 500_000;
const piece = (extra = {}) => ({ connected: true, lastEventAt: T - 2000, attention: 61, poorSignalLevel: 26, source: 'real', handSeen: true, meta: {}, ...extra });
const off = () => ({ connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null, meta: {} });
function status(over = {}) {
  return {
    now: T,
    pieces: {
      'acquisition-p1': piece({ meta: { version: 'aaaaaaa', source: 'real', eegHost: 'host.docker.internal', acqPort: 13854 } }),
      'gesture-p1': piece({ meta: { version: 'bbbbbbb', camera: 0, commit: 'abc1234', branch: 'main' } }),
      'acquisition-p2': piece({ meta: { version: 'aaaaaaa', source: 'real', eegHost: 'host.docker.internal', acqPort: 13854 } }),
      'gesture-p2': piece({ meta: { version: 'bbbbbbb', camera: 1 } }),
    },
    game: { connections: 1, lastGameEvent: null, recentEvents: [{ event: 'raceStarted', at: T - 12_000 }, { event: 'hasFinished', at: T - 80_000 }] },
    connections: { 'acquisition-p1': 1, 'gesture-p1': 1, 'acquisition-p2': 1, 'gesture-p2': 1, panel: 2, unidentified: 1 },
    redis: { status: 'ready' },
    broker: { version: 'ccccccc', uptimeSeconds: 600 },
    ...over,
  };
}
const find = (d, key) => d.pcs.flatMap((pc) => pc.pieces).find((p) => p.key === key);

test('grupos PC CENTRAL e PC COLETOR com as pecas na ordem', () => {
  const d = S.diagnostics({ status: status() });
  assert.deepEqual(d.pcs.map((pc) => [pc.name, pc.pieces.map((p) => p.key)]), [
    ['PC CENTRAL', ['broker', 'redis', 'acquisition-p1', 'gesture-p1', 'jogo']],
    ['PC COLETOR', ['acquisition-p2', 'gesture-p2']],
  ]);
  assert.deepEqual(d.versionWarnings, []);
});

test('acquisition: estado, versao por hash e detalhes', () => {
  const p = find(S.diagnostics({ status: status() }), 'acquisition-p1');
  assert.deepEqual([p.level, p.word, p.version, p.line], ['ok', 'OK', 'código aaaaaaa', null]);
  assert.deepEqual(p.details, [['fonte', 'real'], ['ThinkGear', 'host.docker.internal:13854'], ['EEG', '—'], ['último erro', '—'], ['Poor Signal', '26'], ['atenção', '61'], ['último dado', 'há 2 s']]);
});

test('gesture: commit quando houver, senao hash; camera N = indice + 1', () => {
  const d = S.diagnostics({ status: status() });
  assert.equal(find(d, 'gesture-p1').version, 'main · abc1234');
  assert.equal(find(d, 'gesture-p2').version, 'código bbbbbbb');
  assert.deepEqual(find(d, 'gesture-p2').details, [['câmera', 'Câmera 2'], ['mão vista', 'sim'], ['última notícia', 'há 2 s']]);
});

test('peca fora: palavra, linha de o que fazer e versao desconhecida', () => {
  const st = status(); st.pieces['acquisition-p2'] = off();
  const p = find(S.diagnostics({ status: st }), 'acquisition-p2');
  assert.deepEqual([p.level, p.word, p.version], ['down', 'Fora', 'versão desconhecida']);
  // NEU-151: peca fora agora e so peca fora — o ThinkGear ganhou linha propria.
  assert.equal(p.line, 'acquisition-p2 desligado · suba as peças do PC coletor');
  assert.deepEqual(p.details[1], ['ThinkGear', '—']);
});

// NEU-151: a peca de pe com o EEG fora. Antes isso nem chegava ao painel, porque a
// acquisition so conectava no broker depois de conectar no EEG.
test('ThinkGear fora: peca conectada, EEG conectando, com o ultimo erro a vista', () => {
  const st = status();
  st.pieces['acquisition-p2'] = piece({ eeg: 'connecting', lastError: 'Connection refused', meta: {} });
  const p = find(S.diagnostics({ status: st }), 'acquisition-p2');
  assert.deepEqual([p.level, p.word], ['eeg_down', 'ThinkGear fora']);
  assert.equal(p.line, 'ThinkGear do P2 fechado · abra o ThinkGear Connector no PC coletor');
  assert.deepEqual(p.details[2], ['EEG', 'conectando']);
  assert.deepEqual(p.details[3], ['último erro', 'Connection refused']);
});

test('sem noticia ha mais de 10 s: Sem notícia', () => {
  const st = status(); st.pieces['gesture-p1'] = piece({ lastEventAt: T - 11_000, meta: {} });
  const p = find(S.diagnostics({ status: st }), 'gesture-p1');
  assert.deepEqual([p.level, p.word], ['stale', 'Sem notícia']);
});

test('broker, redis e jogo', () => {
  const d = S.diagnostics({ status: status() });
  const broker = find(d, 'broker');
  assert.deepEqual([broker.level, broker.version], ['ok', 'código ccccccc']);
  assert.deepEqual(broker.details, [['conectados', 'acquisition-p1 ×1 · gesture-p1 ×1 · acquisition-p2 ×1 · gesture-p2 ×1 · painel ×2 · não identificado (jogo) ×1'], ['no ar há', '10 min']]);
  assert.deepEqual(find(d, 'redis').details, [['estado', 'ready']]);
  const jogo = find(d, 'jogo');
  assert.deepEqual([jogo.level, jogo.version], ['ok', '—']);
  assert.deepEqual(jogo.details, [['conexões', '1'], ['últimos eventos', 'raceStarted há 12 s · hasFinished há 80 s']]);
  const st = status({ redis: { status: 'reconnecting' }, game: { connections: 0, lastGameEvent: null, recentEvents: [] } });
  const d2 = S.diagnostics({ status: st });
  assert.deepEqual([find(d2, 'redis').level, find(d2, 'redis').line], ['down', 'redis fora · reinicie o redis no PC central (a fila fica guardada)']);
  assert.deepEqual([find(d2, 'jogo').level, find(d2, 'jogo').line], ['down', 'jogo não conectado · abra o jogo no PC central']);
});

test('aviso de versao so quando o par existe e difere; peca antiga sem versao nao avisa', () => {
  const st = status(); st.pieces['acquisition-p2'].meta.version = 'ddddddd';
  assert.deepEqual(S.diagnostics({ status: st }).versionWarnings, [
    'versões diferentes entre central e coletor: acquisition (central aaaaaaa · coletor ddddddd) · atualize o coletor (git pull) e reabra as peças',
  ]);
  const old = status(); old.pieces['gesture-p2'].meta = {};
  assert.deepEqual(S.diagnostics({ status: old }).versionWarnings, []);
});

test('statusStrip poe o aviso de versao no topo das linhas', () => {
  const st = status(); st.pieces['gesture-p2'].meta.version = 'eeeeeee';
  const r = S.statusStrip({ status: st, health: { dispatcher: { enabled: true } }, overview: { counts: { waiting: 0, failed: 0 } }, waitingSince: null, now: T });
  assert.equal(r.lines[0], 'versões diferentes entre central e coletor: gesture (central bbbbbbb · coletor eeeeeee) · atualize o coletor (git pull) e reabra as peças');
});

test('sem status (broker sem resposta): nada a mostrar', () => {
  assert.deepEqual(S.diagnostics({ status: null }), { pcs: [], versionWarnings: [] });
});
