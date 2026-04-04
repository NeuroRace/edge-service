// data_broker/tests/test_redis_client.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRedisClient } = require('../redis_client');

class FakeRedis extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
  }
}

test('evento connect loga redis_connected no nível info', () => {
  const logs = [];
  const client = createRedisClient(
    { redisUrl: 'redis://fake:6379' },
    (level, message, meta) => logs.push({ level, message, meta }),
    FakeRedis,
  );

  client.emit('connect');

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'info');
  assert.equal(logs[0].message, 'redis_connected');
});

test('evento error loga redis_error com message no nível error', () => {
  const logs = [];
  const client = createRedisClient(
    { redisUrl: 'redis://fake:6379' },
    (level, message, meta) => logs.push({ level, message, meta }),
    FakeRedis,
  );

  client.emit('error', new Error('connection refused'));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'error');
  assert.equal(logs[0].message, 'redis_error');
  assert.equal(logs[0].meta.message, 'connection refused');
});

test('evento close loga redis_closed no nível warn', () => {
  const logs = [];
  const client = createRedisClient(
    { redisUrl: 'redis://fake:6379' },
    (level, message, meta) => logs.push({ level, message, meta }),
    FakeRedis,
  );

  client.emit('close');

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].message, 'redis_closed');
});
