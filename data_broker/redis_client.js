// data_broker/redis_client.js
const Redis = require('ioredis');

// Cliente Redis com logs estruturados de ciclo de vida. `RedisClient` e injetavel
// para testes (FakeRedis), evitando dependencia de um Redis real nos unit tests.
function createRedisClient(config, log = () => {}, RedisClient = Redis) {
  const client = new RedisClient(config.redisUrl);
  client.on('connect', () => log('info', 'redis_connected', {}));
  client.on('error', (err) => log('error', 'redis_error', { message: err.message }));
  client.on('close', () => log('warn', 'redis_closed', {}));
  return client;
}

module.exports = { createRedisClient };
