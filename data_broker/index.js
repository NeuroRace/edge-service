const http = require('http');
const { Server } = require('socket.io');
const { ENFORCED_EVENTS, validateEventPayload } = require('./event_contracts');

const BROKER_PORT = Number(process.env.BROKER_PORT || 3000);
const allowedOrigins = (process.env.BROKER_ALLOWED_ORIGINS ||
  'http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://localhost:8000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'broker' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

function log(level, message, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'broker',
    message,
    ...metadata
  }));
}

function forwardEvent(socket, event) {
  return (payload) => {
    const validationError = validateEventPayload(event, payload);

    if (validationError !== null) {
      log('warn', 'event_rejected', {
        event,
        socketId: socket.id,
        validationError,
        payload
      });
      return;
    }

    log('info', 'event_received', {
      event,
      socketId: socket.id,
      payload,
      enforced: ENFORCED_EVENTS.has(event)
    });
    socket.broadcast.emit(event, payload);
  };
}

io.on('connection', (socket) => {
  log('info', 'client_connected', { socketId: socket.id });

  socket.on('disconnect', (reason) => {
    log('info', 'client_disconnected', { socketId: socket.id, reason });
  });

  socket.on('blink', forwardEvent(socket, 'blink'));
  socket.on('eSense', forwardEvent(socket, 'eSense'));
  socket.on('handGesture', forwardEvent(socket, 'handGesture'));
  socket.on('raceStarted', forwardEvent(socket, 'raceStarted'));
  socket.on('hasFinished', forwardEvent(socket, 'hasFinished'));
  socket.on('gameEvent', forwardEvent(socket, 'gameEvent'));
});

server.listen(BROKER_PORT, () => {
  log('info', 'broker_listening', {
    port: BROKER_PORT,
    allowedOrigins
  });
});
