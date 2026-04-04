// data_broker/socket_handlers.js
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

function createForwardEventHandler({ log, socket, event, session }) {
  return (payload) => {
    const validationError = validateEventPayload(event, payload);

    if (validationError !== null) {
      log('warn', 'event_rejected', {
        event,
        socketId: socket.id,
        validationError,
        payload,
      });
      return;
    }

    log('info', 'event_received', {
      event,
      socketId: socket.id,
      payload,
      enforced: ENFORCED_EVENTS.has(event),
    });
    socket.broadcast.emit(event, payload);

    if (session) {
      if (event === 'eSense') {
        session.onEsense(payload).catch((err) =>
          log('error', 'session_esense_error', { err: err?.message ?? String(err) }),
        );
      } else if (event === 'raceStarted') {
        session.onRaceStarted(payload).catch((err) =>
          log('error', 'session_race_started_error', { err: err?.message ?? String(err) }),
        );
      } else if (event === 'hasFinished') {
        session.onHasFinished(payload).catch((err) =>
          log('error', 'session_has_finished_error', { err: err?.message ?? String(err) }),
        );
      }
    }
  };
}

function registerSocketHandlers(io, log, session) {
  io.on('connection', (socket) => {
    log('info', 'client_connected', { socketId: socket.id });

    socket.on('disconnect', (reason) => {
      log('info', 'client_disconnected', { socketId: socket.id, reason });
    });

    for (const event of BROKER_EVENTS) {
      socket.on(event, createForwardEventHandler({ log, socket, event, session }));
    }
  });
}

module.exports = {
  BROKER_EVENTS,
  createForwardEventHandler,
  createSocketServer,
  registerSocketHandlers,
};
