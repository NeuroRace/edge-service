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
  };
}

module.exports = {
  loadBrokerConfig,
};
