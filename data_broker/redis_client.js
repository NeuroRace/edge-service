// data_broker/redis_client.js
const Redis = require('ioredis');

function createRedisClient(config) {
  return new Redis(config.redisUrl);
}

module.exports = { createRedisClient };
