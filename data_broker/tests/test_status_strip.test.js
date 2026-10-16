// NEU-139: faixa de status (Central, Coletor, Jogo, Nuvem) e cor do Poor Signal.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

const T = 100_000;
const live = (extra = {}) => ({ connected: true, lastEventAt: T - 1000, attention: 50, poorSignalLevel: 0, source: 'real', handSeen: true, ...extra });
const off = () => ({ connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null });
const allOk = () => ({
  now: T,
  pieces: { 'acquisition-p1': live(), 'gesture-p1': live(), 'acquisition-p2': live(), 'gesture-p2': live() },
  game: { connections: 1, lastGameEvent: null },
  redis: { status: 'ready' },
});
const health = { dispatcher: { enabled: true } };
const overview = { counts: { waiting: 0, sending: 0, failed: 0 } };
const strip = (status, extra = {}) => S.statusStrip({ status, health, overview, waitingSince: null, now: T, ...extra });

test('tudo bem: 4 verdes e nenhuma linha', () => {
  assert.deepEqual(strip(allOk()), { groups: { central: 'ok', coletor: 'ok', jogo: 'ok', nuvem: 'ok' }, lines: [] });
});

test('CA: acquisition-p2 parado com gesture-p2 vivo -> Coletor amarelo com o que fazer', () => {
  const st = allOk(); st.pieces['acquisition-p2'] = off();
  const r = strip(st);
  assert.equal(r.groups.coletor, 'warn');
  // NEU-151: a acquisition conecta no broker ANTES do EEG, entao "sem conexao" so pode
  // ser a peca fora. ThinkGear fechado tem linha propria, no teste abaixo.
  assert.deepEqual(r.lines, ['acquisition-p2 desligado · suba as peças do PC coletor']);
});

// NEU-151: os tres casos que o operador precisa distinguir em ate 30 s (S2 do projeto).
test('CA: ThinkGear fechado -> peca viva e a linha aponta o ThinkGear, nao as pecas', () => {
  const st = allOk();
  st.pieces['acquisition-p2'] = live({ eeg: 'connecting', lastError: 'Connection refused' });
  const r = strip(st);
  assert.equal(r.groups.coletor, 'warn');
  assert.deepEqual(r.lines, ['ThinkGear do P2 fechado · abra o ThinkGear Connector no PC coletor']);
});

test('CA: fone sem dados com o ThinkGear aberto continua como "sem dados"', () => {
  const st = allOk();
  st.pieces['acquisition-p2'] = live({ eeg: 'connected', lastEventAt: T - 11_000 });
  const r = strip(st);
  assert.deepEqual(r.lines, ['acquisition-p2 sem dados · confira o fone do P2 no PC coletor']);
});

// Sem o ramo 'eeg_down' a peca passaria por verde: ela manda acquisitionStatus a cada
// 2 s, entao o lastEventAt fica fresco mesmo sem nenhum dado de EEG chegando.
test('CA: EEG fora com noticia fresca nao pode aparecer como OK', () => {
  const st = allOk();
  st.pieces['acquisition-p1'] = live({ eeg: 'connecting', lastEventAt: T - 100 });
  const r = strip(st);
  assert.equal(r.groups.central, 'warn');
  assert.deepEqual(r.lines, ['ThinkGear do P1 fechado · abra o ThinkGear Connector no PC central']);
});

test('CA: PC coletor desligado -> vermelho e uma linha so', () => {
  const st = allOk(); st.pieces['acquisition-p2'] = off(); st.pieces['gesture-p2'] = off();
  const r = strip(st);
  assert.equal(r.groups.coletor, 'down');
  assert.deepEqual(r.lines, ['Coletor sem resposta · confira se o PC coletor está ligado e o cabo plugado']);
});

test('sem noticia ha mais de 10 s nao e verde; exatamente 10 s ainda e', () => {
  const st = allOk(); st.pieces['acquisition-p1'] = live({ lastEventAt: T - 10_000 });
  assert.equal(strip(st).groups.central, 'ok');
  st.pieces['acquisition-p1'] = live({ lastEventAt: T - 10_001 });
  const r = strip(st);
  assert.equal(r.groups.central, 'warn');
  assert.deepEqual(r.lines, ['acquisition-p1 sem dados · confira o fone do P1 no PC central']);
});

test('conectada mas nunca mandou nada: amarelo, nunca verde', () => {
  const st = allOk(); st.pieces['gesture-p2'] = live({ lastEventAt: null });
  const r = strip(st);
  assert.equal(r.groups.coletor, 'warn');
  assert.deepEqual(r.lines, ['gesture-p2 sem notícia · reinicie o detector de gesto no PC coletor']);
});

test('gesture-p1 desligado e redis fora: Central amarelo com as duas linhas, redis primeiro', () => {
  const st = allOk(); st.pieces['gesture-p1'] = off(); st.redis = { status: 'reconnecting' };
  const r = strip(st);
  assert.equal(r.groups.central, 'warn');
  assert.deepEqual(r.lines, ['redis fora · reinicie o redis no PC central (a fila fica guardada)', 'gesture-p1 desligado · abra o detector de gesto no PC central']);
});

test('idade usa o relogio do broker (status.now), nao o do navegador', () => {
  const st = allOk();
  const r = S.statusStrip({ status: st, health, overview, waitingSince: null, now: T + 60_000 });
  assert.equal(r.groups.central, 'ok');
});

test('jogo sem conexao -> vermelho', () => {
  const st = allOk(); st.game = { connections: 0, lastGameEvent: null };
  const r = strip(st);
  assert.equal(r.groups.jogo, 'down');
  assert.deepEqual(r.lines, ['jogo não conectado · abra o jogo no PC central']);
});

test('nuvem: desligada vermelho; falha amarelo; espera longa amarelo; /health falhou = cinza', () => {
  let r = strip(allOk(), { health: { dispatcher: { enabled: false, reason: 'api_url_missing' } } });
  assert.deepEqual([r.groups.nuvem, r.lines], ['down', ['nuvem desligada · corridas ficam guardadas no PC central']]);
  r = strip(allOk(), { overview: { counts: { waiting: 0, failed: 2 } } });
  assert.deepEqual([r.groups.nuvem, r.lines], ['warn', ['2 corrida(s) não subiram · use Reenviar no bloco Nuvem']]);
  r = strip(allOk(), { overview: { counts: { waiting: 3, failed: 0 } }, waitingSince: T - 31_000 });
  assert.deepEqual([r.groups.nuvem, r.lines], ['warn', ['corridas esperando há mais de 30 s · internet do evento?']]);
  r = strip(allOk(), { health: null });
  assert.deepEqual([r.groups.nuvem, r.lines], ['unknown', []]);
});

test('broker sem resposta: tudo cinza com uma linha', () => {
  assert.deepEqual(S.statusStrip({ status: null, health: null, overview: null, waitingSince: null, now: T }), {
    groups: { central: 'unknown', coletor: 'unknown', jogo: 'unknown', nuvem: 'unknown' },
    lines: ['broker sem resposta · confira o PC central'],
  });
});

test('pslLevel: 0 verde, 1..199 amarelo, 200 vermelho, sem valor = none', () => {
  assert.equal(S.pslLevel(0), 'good');
  assert.equal(S.pslLevel(1), 'weak');
  assert.equal(S.pslLevel(199), 'weak');
  assert.equal(S.pslLevel(200), 'bad');
  assert.equal(S.pslLevel(null), 'none');
  assert.equal(S.pslLevel(undefined), 'none');
  assert.equal(S.STALE_MS, 10_000);
});
