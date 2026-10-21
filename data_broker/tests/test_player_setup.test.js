// NEU-86: escolha de fonte e camera por jogador, guardada no Redis do PC central.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createPlayerSetup, PLAYER_SETUP_KEY } = require('../player_setup');

const DEFAULT = { 1: { source: 'neurosky', camera: null }, 2: { source: 'neurosky', camera: null } };

test('padrao: NeuroSky nos dois e camera sem escolha', async () => {
  const setup = createPlayerSetup(new FakeRedis());
  assert.deepEqual(setup.get(), DEFAULT);
  assert.deepEqual(await setup.load(), DEFAULT);
});

test('grava no Redis e outro broker le de volta (sobrevive a reinicio)', async () => {
  const redis = new FakeRedis(); const changes = [];
  const a = createPlayerSetup(redis, { onChange: (field, player) => changes.push([field, player]) });
  assert.deepEqual(await a.setSource(2, 'bot'), { ok: true, setup: { 1: DEFAULT[1], 2: { source: 'bot', camera: null } } });
  assert.equal((await a.setCamera(1, 2)).ok, true);
  assert.deepEqual(changes, [['source', 2], ['camera', 1]]);
  const b = createPlayerSetup(redis);
  await b.load();
  assert.deepEqual(b.get(), { 1: { source: 'neurosky', camera: 2 }, 2: { source: 'bot', camera: null } });
});

test('valores invalidos sao recusados sem gravar nem avisar', async () => {
  const redis = new FakeRedis(); const changes = [];
  const setup = createPlayerSetup(redis, { onChange: () => changes.push(1) });
  for (const [p, s, error] of [[3, 'bot', 'invalid_player'], ['1', 'bot', 'invalid_player'], [1, 'real', 'invalid_source'], [1, 'BOT', 'invalid_source'], [1, undefined, 'invalid_source']]) {
    assert.deepEqual(await setup.setSource(p, s), { ok: false, error }, `${p}/${s}`);
  }
  for (const [p, c, error] of [[0, 1, 'invalid_player'], [1, 3, 'invalid_camera'], [1, -1, 'invalid_camera'], [1, '1', 'invalid_camera'], [1, 1.5, 'invalid_camera'], [1, true, 'invalid_camera']]) {
    assert.deepEqual(await setup.setCamera(p, c), { ok: false, error }, `${p}/${c}`);
  }
  assert.deepEqual(await redis.hgetall(PLAYER_SETUP_KEY), {});
  assert.deepEqual(changes, []);
});

test('durante a corrida nada muda', async () => {
  const setup = createPlayerSetup(new FakeRedis(), { raceInProgress: async () => true });
  assert.deepEqual(await setup.setSource(1, 'bot'), { ok: false, error: 'race_in_progress' });
  assert.deepEqual(await setup.setCamera(1, 1), { ok: false, error: 'race_in_progress' });
  assert.deepEqual(setup.get(), DEFAULT);
});

test('lixo no Redis vira o padrao', async () => {
  const redis = new FakeRedis();
  await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'xyz', 'p1Camera', '9', 'p2Camera', '');
  const setup = createPlayerSetup(redis);
  assert.deepEqual(await setup.load(), DEFAULT);
});

test('get devolve copia (quem chama nao muda o estado)', () => {
  const setup = createPlayerSetup(new FakeRedis());
  setup.get()[1].source = 'bot';
  assert.equal(setup.get()[1].source, 'neurosky');
});
