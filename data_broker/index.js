const { loadBrokerConfig } = require('./config');
const { createHttpServer } = require('./http_server');
const { createBrokerLogger } = require('./logger');
const { createRuntimeState } = require('./runtime_state');
const { createRedisClient } = require('./redis_client');
const { createSessionManager } = require('./session_manager');
const { createSocketServer, registerSocketHandlers } = require('./socket_handlers');

const config = loadBrokerConfig();
const log = createBrokerLogger();
const runtimeState = createRuntimeState();
const redis = createRedisClient(config, log);
const session = createSessionManager(redis, config, log);
const server = createHttpServer(() => runtimeState.snapshot(), session, log);
const io = createSocketServer(server, config.allowedOrigins);

registerSocketHandlers(io, log, runtimeState, session);

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
