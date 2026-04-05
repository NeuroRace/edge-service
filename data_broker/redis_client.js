// data_broker/redis_client.js
const Redis = require('ioredis');

function createRedisClient(config, log = () => {}, RedisClient = Redis) {
  const client = new RedisClient(config.redisUrl);
  client.on('connect', () => log('info', 'redis_connected', {}));
  client.on('error', (err) => log('error', 'redis_error', { message: err.message }));
  client.on('close', () => log('warn', 'redis_closed', {}));
  return client;
}

module.exports = { createRedisClient };
