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
const redis = createRedisClient(config, log);
const redisBlocking = createRedisClient(config, log);
const session = createSessionManager(redis, config, log);
const server = createHttpServer(session);
const io = createSocketServer(server, config.allowedOrigins);
const emitFn = (event, payload) => io.emit(event, payload);
const dispatcher = createDispatcher(redisBlocking, config, log, fetch, undefined, emitFn);

registerSocketHandlers(io, log, session);
dispatcher.start().catch((err) =>
  log('error', 'dispatcher_fatal', { message: err?.message ?? String(err) }),
);
dispatcher.startHealthMonitor(config.queueHealthIntervalMs);

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
