const { loadBrokerConfig } = require('./config');
const { createHttpServer } = require('./http_server');
const { createBrokerLogger } = require('./logger');
const { createSocketServer, registerSocketHandlers } = require('./socket_handlers');

const config = loadBrokerConfig();
const log = createBrokerLogger();
const server = createHttpServer();
const io = createSocketServer(server, config.allowedOrigins);

registerSocketHandlers(io, log);

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
