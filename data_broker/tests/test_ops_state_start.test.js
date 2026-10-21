// NEU-140: Largar pelo painel. Formato do jogo combinado com o Thiago em 20/10 (NEU-146).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

test('startRacePayload: dois NeuroSky = player; P2 Bot = bot; dois Bot = player', () => {
  assert.deepEqual(S.startRacePayload({ 1: 'neurosky', 2: 'neurosky' }), { startRace: true, gameMode: 'player' });
  assert.deepEqual(S.startRacePayload({ 1: 'neurosky', 2: 'bot' }), { startRace: true, gameMode: 'bot' });
  assert.deepEqual(S.startRacePayload({ 1: 'bot', 2: 'bot' }), { startRace: true, gameMode: 'player' });
  // Sem noticia do setup (broker antigo): o padrao e os dois NeuroSky.
  assert.deepEqual(S.startRacePayload({ 1: null, 2: null }), { startRace: true, gameMode: 'player' });
});

const ready = { register: [], gameConnected: true, panelConnected: true, sessionActive: false, sources: { 1: 'neurosky', 2: 'neurosky' } };

test('startBlockers: tudo pronto nao trava', () => {
  assert.deepEqual(S.startBlockers(ready), []);
});

test('startBlockers: herda as travas do Registrar', () => {
  const register = [{ slot: 1, code: 'missing_contact', text: 'P1: digite o contato ou marque Sem cadastro' }];
  assert.deepEqual(S.startBlockers({ ...ready, register }), register);
});

test('startBlockers: jogo fora, painel sem broker e corrida em andamento travam com o motivo', () => {
  assert.deepEqual(S.startBlockers({ ...ready, gameConnected: false }).map((b) => b.code), ['game_down']);
  assert.deepEqual(S.startBlockers({ ...ready, panelConnected: false }).map((b) => b.code), ['panel_offline']);
  assert.deepEqual(S.startBlockers({ ...ready, sessionActive: true }).map((b) => b.code), ['race_active']);
  for (const b of S.startBlockers({ ...ready, gameConnected: false, panelConnected: false, sessionActive: true })) assert.ok(b.text);
});

test('startBlockers: com um Bot so, a pessoa joga no P1 (o jogo trata o P2 como bot)', () => {
  const out = S.startBlockers({ ...ready, sources: { 1: 'bot', 2: 'neurosky' } });
  assert.deepEqual(out.map((b) => b.code), ['human_on_p2']);
  assert.match(out[0].text, /P1/);
});
