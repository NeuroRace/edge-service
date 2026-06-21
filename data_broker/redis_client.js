// data_broker/redis_client.js
const Redis = require('ioredis');

// Cliente Redis com logs estruturados de ciclo de vida. `RedisClient` e injetavel
// para testes (FakeRedis), evitando dependencia de um Redis real nos unit tests.
function createRedisClient(config, log = () => {}, RedisClient = Redis) {
  // Opcoes explicitas para o comportamento de falha ser deterministico
  // (em vez de depender dos defaults do ioredis).
  const client = new RedisClient(config.redisUrl, {
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
  });
  client.on('connect', () => log('info', 'redis_connected', {}));
  client.on('error', (err) => log('error', 'redis_error', { message: err.message }));
  client.on('close', () => log('warn', 'redis_closed', {}));
  return client;
}

module.exports = { createRedisClient };
