const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://localhost:8000',
];

function loadBrokerConfig(env = process.env) {
  const allowedOrigins = (env.BROKER_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    port: Number(env.BROKER_PORT || 3000),
    allowedOrigins,
    redisUrl: env.REDIS_URL || 'redis://redis:6379',
    apiUrl: env.API_URL || null,
    edgeIngestToken: env.EDGE_INGEST_TOKEN || '',
    dispatchBackoffBaseMs: Number(env.DISPATCH_BACKOFF_BASE_MS || 500),
    dispatchBackoffMaxMs: Number(env.DISPATCH_BACKOFF_MAX_MS || 10000),
    dispatchMaxAttempts: Number(env.DISPATCH_MAX_ATTEMPTS || 8),
    dispatchBlockTimeoutSec: Number(env.DISPATCH_BLOCK_TIMEOUT_SEC || 5),
    dispatchHttpTimeoutMs: Number(env.DISPATCH_HTTP_TIMEOUT_MS || 15000),
  };
}

module.exports = {
  loadBrokerConfig,
};
