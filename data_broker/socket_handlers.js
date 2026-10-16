const { Server } = require('socket.io');
const { ENFORCED_EVENTS, validateEventPayload } = require('./event_contracts');

const BROKER_EVENTS = [
  'blink',
  'eSense',
  'handGesture',
  'raceStarted',
  'hasFinished',
  'gameEvent',
  // NEU-158: avisos do jogo. Sem estar nesta lista, o broker os ignorava em
  // silencio — o evento chegava e morria aqui, sem log e sem repasse.
  'countdownStarted',
  'raceStopped',
  'gameHello',
];

// NEU-158: comandos que o painel manda para o jogo. Ficam FORA de BROKER_EVENTS
// porque sao os unicos com dono: so o papel `panel` pode larga-los. Um test-client
// esquecido aberto, ou o proprio jogo, nao podem dar largada numa corrida.
const PANEL_COMMAND_EVENTS = ['startRace', 'stopRace'];

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
function createForwardEventHandler({ log, socket, event, runtimeState, session, presence = null, now = Date.now }) {
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
    if (presence) presence.onEvent(socket.id, event, payload, now());
    log('info', 'event_received', {
      event,
      socketId: socket.id,
      payload,
      enforced: ENFORCED_EVENTS.has(event),
    });
    socket.broadcast.emit(event, payload);

    // Nota (limitacao conhecida): os hooks sao disparados sem await e sem
    // serializacao entre si. Sob concorrencia extrema, um onEsense em voo pode
    // perder a janela do onHasFinished. Aceitavel no Stage 1; a serializacao por
    // sessao fica para quando o dispatcher (Stage 3) consumir a fila.
    if (session) {
      if (event === 'eSense') {
        session.onEsense(payload).catch((err) =>
          log('error', 'session_esense_error', { player: payload?.player, error: err?.message ?? String(err) }),
        );
      } else if (event === 'raceStarted') {
        session.onRaceStarted(payload).catch((err) =>
          log('error', 'session_race_started_error', { error: err?.message ?? String(err) }),
        );
      } else if (event === 'hasFinished') {
        session.onHasFinished(payload).catch((err) =>
          log('error', 'session_has_finished_error', { playerId: payload?.playerId, error: err?.message ?? String(err) }),
        );
      }
    }
  };
}

// `presence` (opcional, NEU-139): registro de quem esta conectado, alimentado pelo
// `socket.handshake.auth` de cada peca e pelos eventos que ela manda.
function registerSocketHandlers(io, log, runtimeState, session, presence = null, now = Date.now) {
  io.on('connection', (socket) => {
    runtimeState.markClientConnected();
    const piece = presence ? presence.onConnect(socket.id, socket.handshake && socket.handshake.auth, now()) : null;
    log('info', 'client_connected', { socketId: socket.id, piece });

    socket.on('disconnect', (reason) => {
      runtimeState.markClientDisconnected();
      if (presence) presence.onDisconnect(socket.id);
      log('info', 'client_disconnected', { socketId: socket.id, piece, reason });
    });

    for (const event of BROKER_EVENTS) {
      socket.on(event, createForwardEventHandler({ log, socket, event, runtimeState, session, presence, now }));
    }

    // NEU-139: sinal de vida do gesto. NAO entra em BROKER_EVENTS: nunca e repassado.
    socket.on('gestureStatus', (payload) => {
      if (!presence || validateEventPayload('gestureStatus', payload) !== null) return;
      presence.onEvent(socket.id, 'gestureStatus', payload, now());
    });

    // NEU-151: estado do EEG da acquisition. Mesma regra: so alimenta a presenca.
    socket.on('acquisitionStatus', (payload) => {
      if (!presence || validateEventPayload('acquisitionStatus', payload) !== null) return;
      presence.onEvent(socket.id, 'acquisitionStatus', payload, now());
    });

    // NEU-158: comando do painel para o jogo. `piece` vem do auth do connect, entao
    // quem nao se apresentou como painel nao passa. Recusa e barulhenta: um comando
    // engolido em silencio e exatamente o que esta issue veio consertar.
    for (const event of PANEL_COMMAND_EVENTS) {
      socket.on(event, (payload) => {
        if (piece !== 'panel') {
          runtimeState.markEventRejected();
          log('warn', 'command_rejected_not_panel', { event, socketId: socket.id, piece });
          return;
        }
        runtimeState.markEventValidated();
        if (presence) presence.onEvent(socket.id, event, payload, now());
        log('info', 'event_received', { event, socketId: socket.id, payload, enforced: false });
        socket.broadcast.emit(event, payload);
      });
    }
  });
}

module.exports = {
  BROKER_EVENTS,
  PANEL_COMMAND_EVENTS,
  createForwardEventHandler,
  createSocketServer,
  registerSocketHandlers,
};
