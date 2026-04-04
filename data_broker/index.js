// data_broker/index.js
const { loadBrokerConfig } = require('./config');
const { createRedisClient } = require('./redis_client');
const { createSessionManager } = require('./session_manager');
const { createDispatcher } = require('./api_dispatcher');
const { createHttpServer } = require('./http_server');
const { createBrokerLogger } = require('./logger');
const { createSocketServer, registerSocketHandlers } = require('./socket_handlers');

const config = loadBrokerConfig();
const log = createBrokerLogger();
const redis = createRedisClient(config);
redis.on('error', (err) =>
  log('error', 'redis_connection_error', { message: err.message }),
);
const session = createSessionManager(redis, config, log);
const server = createHttpServer(session);
const io = createSocketServer(server, config.allowedOrigins);
const emitFn = (event, payload) => io.emit(event, payload);
const dispatcher = createDispatcher(redis, config, log, fetch, undefined, emitFn);

registerSocketHandlers(io, log, session);
dispatcher.start().catch((err) =>
  log('error', 'dispatcher_fatal', { message: err?.message ?? String(err) }),
);

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
