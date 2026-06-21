const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createRedisClient } = require('../redis_client');

class FakeRedisClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
  }
}

test('createRedisClient conecta na url do config e loga eventos de ciclo de vida', () => {
  const logs = [];
  const log = (level, message, meta) => logs.push({ level, message, meta });

  const client = createRedisClient({ redisUrl: 'redis://example:6379' }, log, FakeRedisClient);
  assert.equal(client.url, 'redis://example:6379');

  client.emit('connect');
  client.emit('error', new Error('boom'));
  client.emit('close');

  assert.deepEqual(
    logs.map((l) => [l.level, l.message]),
    [
      ['info', 'redis_connected'],
      ['error', 'redis_error'],
      ['warn', 'redis_closed'],
    ],
  );
  assert.equal(logs[1].meta.message, 'boom');
});
