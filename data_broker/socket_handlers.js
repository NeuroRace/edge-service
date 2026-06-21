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

// `session` e opcional: quando presente (persistencia habilitada), os eventos de
// corrida sao espelhados para a camada de persistencia APOS o broadcast, em
// fire-and-forget (uma falha de persistencia nunca bloqueia o broadcast em tempo real).
function createForwardEventHandler({ log, socket, event, runtimeState, session }) {
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

    if (session) {
      if (event === 'eSense') {
        session.onEsense(payload).catch((err) =>
          log('error', 'session_esense_error', { error: err?.message ?? String(err) }),
        );
      } else if (event === 'raceStarted') {
        session.onRaceStarted(payload).catch((err) =>
          log('error', 'session_race_started_error', { error: err?.message ?? String(err) }),
        );
      } else if (event === 'hasFinished') {
        session.onHasFinished(payload).catch((err) =>
          log('error', 'session_has_finished_error', { error: err?.message ?? String(err) }),
        );
      }
    }
  };
}

function registerSocketHandlers(io, log, runtimeState, session) {
  io.on('connection', (socket) => {
    runtimeState.markClientConnected();
    log('info', 'client_connected', { socketId: socket.id });

    socket.on('disconnect', (reason) => {
      runtimeState.markClientDisconnected();
      log('info', 'client_disconnected', { socketId: socket.id, reason });
    });

    for (const event of BROKER_EVENTS) {
      socket.on(event, createForwardEventHandler({ log, socket, event, runtimeState, session }));
    }
  });
}

module.exports = {
  BROKER_EVENTS,
  createForwardEventHandler,
  createSocketServer,
  registerSocketHandlers,
};
