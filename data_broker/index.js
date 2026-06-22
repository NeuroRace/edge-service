const { loadBrokerConfig } = require('./config');
const { createHttpServer } = require('./http_server');
const { createBrokerLogger } = require('./logger');
const { createRuntimeState } = require('./runtime_state');
const { createRedisClient, createBlockingRedisClient } = require('./redis_client');
const { createSessionManager } = require('./session_manager');
const { createSocketServer, registerSocketHandlers } = require('./socket_handlers');
const { createDispatcher } = require('./api_dispatcher');

const config = loadBrokerConfig();
const log = createBrokerLogger();
const runtimeState = createRuntimeState();
const redis = createRedisClient(config, log);
const session = createSessionManager(redis, config, log);
const server = createHttpServer(() => runtimeState.snapshot(), session, log);
const io = createSocketServer(server, config.allowedOrigins);

registerSocketHandlers(io, log, runtimeState, session);

// Dispatcher (Stage 3 / NEU-7): opt-in via API_URL. Sem API_URL, os jobs
// acumulam duravelmente em dispatch:queue (comportamento atual preservado).
if (config.apiUrl && config.edgeIngestToken) {
  const redisBlocking = createBlockingRedisClient(config, log);
  const dispatcher = createDispatcher(redisBlocking, config, log);
  dispatcher.start().catch((err) =>
    log('error', 'dispatcher_fatal', { message: err?.message ?? String(err) }),
  );
} else if (config.apiUrl && !config.edgeIngestToken) {
  log('error', 'dispatch_token_missing', {
    hint: 'API_URL setado mas EDGE_INGEST_TOKEN vazio; dispatcher NAO iniciado (jobs ficam em dispatch:queue) para nao dead-letter tudo com 401',
  });
} else {
  log('warn', 'dispatcher_disabled', { reason: 'API_URL nao definido' });
}

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
