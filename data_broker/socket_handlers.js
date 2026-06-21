const { Server } = require('socket.io');
const { ENFORCED_EVENTS, validateEventPayload } = require('./event_contracts');

const BROKER_EVENTS = [
  'blink',
  'eSense',
  'handGesture',
  'raceStarted',
  'hasFinished',
  'gameEvent',
];

function createSocketServer(server, allowedOrigins) {
  return new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });
}

function createForwardEventHandler({ log, socket, event, runtimeState }) {
  return (payload) => {
    const validationError = validateEventPayload(event, payload);

    if (validationError !== null) {
      runtimeState.markEventRejected();
      log('warn', 'event_rejected', {
        event,
        socketId: socket.id,
        validationError,
        payload,
      });
      return;
    }

    runtimeState.markEventValidated();
    log('info', 'event_received', {
      event,
      socketId: socket.id,
      payload,
      enforced: ENFORCED_EVENTS.has(event),
    });
    socket.broadcast.emit(event, payload);
  };
}

function registerSocketHandlers(io, log, runtimeState) {
  io.on('connection', (socket) => {
    runtimeState.markClientConnected();
    log('info', 'client_connected', { socketId: socket.id });

    socket.on('disconnect', (reason) => {
      runtimeState.markClientDisconnected();
      log('info', 'client_disconnected', { socketId: socket.id, reason });
    });

    for (const event of BROKER_EVENTS) {
      socket.on(event, createForwardEventHandler({ log, socket, event, runtimeState }));
    }
  });
}

module.exports = {
  BROKER_EVENTS,
  createForwardEventHandler,
  createSocketServer,
  registerSocketHandlers,
};
