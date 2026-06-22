const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');

test('lmove move da esquerda da origem para a direita do destino', async () => {
  const r = new FakeRedis();
  await r.rpush('q', 'a', 'b');
  const moved = await r.lmove('q', 'p', 'LEFT', 'RIGHT');
  assert.equal(moved, 'a');
  assert.deepEqual(await r.lrange('q', 0, -1), ['b']);
  assert.deepEqual(await r.lrange('p', 0, -1), ['a']);
});

test('blmove retorna null quando a origem esta vazia', async () => {
  const r = new FakeRedis();
  assert.equal(await r.blmove('q', 'p', 'LEFT', 'RIGHT', 1), null);
});

test('lrem com count negativo remove a partir da cauda', async () => {
  const r = new FakeRedis();
  await r.rpush('p', 'x', 'y', 'x');
  assert.equal(await r.lrem('p', -1, 'x'), 1);
  assert.deepEqual(await r.lrange('p', 0, -1), ['x', 'y']);
});

test('lpush insere no inicio', async () => {
  const r = new FakeRedis();
  await r.rpush('q', 'b');
  await r.lpush('q', 'a');
  assert.deepEqual(await r.lrange('q', 0, -1), ['a', 'b']);
});
