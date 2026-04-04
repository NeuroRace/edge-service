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
    supabaseUrl: env.SUPABASE_URL || null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || null,
    dispatchTtlMs: Number(env.DISPATCH_TTL_MS || 86400000),
    backoffBaseMs: Number(env.DISPATCH_BACKOFF_BASE_MS || 1000),
    backoffMaxMs: Number(env.DISPATCH_BACKOFF_MAX_MS || 60000),
  };
}

module.exports = {
  loadBrokerConfig,
};
