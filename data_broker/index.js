const { loadBrokerConfig } = require('./config');
const { createHttpServer } = require('./http_server');
const { createBrokerLogger } = require('./logger');
const { createRuntimeState } = require('./runtime_state');
const { createSocketServer, registerSocketHandlers } = require('./socket_handlers');

const config = loadBrokerConfig();
const log = createBrokerLogger();
const runtimeState = createRuntimeState();
const server = createHttpServer(() => runtimeState.snapshot());
const io = createSocketServer(server, config.allowedOrigins);

registerSocketHandlers(io, log, runtimeState);

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
