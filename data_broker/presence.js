// data_broker/presence.js
// NEU-139: quem esta conectado ao broker e quando deu noticia pela ultima vez.
// Cada peca nossa se apresenta no connect (`socket.handshake.auth`); o jogo nao se
// apresenta e e reconhecido como a conexao anonima (fallback da spec, secao 8).
const PIECES = ['acquisition-p1', 'gesture-p1', 'acquisition-p2', 'gesture-p2'];
const ROLES_WITH_PLAYER = new Set(['acquisition', 'gesture']);
const ROLES_WITHOUT_PLAYER = new Set(['panel', 'test-client']);
const GAME_EVENTS = new Set(['raceStarted', 'hasFinished', 'gameEvent']);

// Auth ausente ou invalido nunca derruba a conexao: vira 'unidentified' (= jogo).
function keyFromAuth(auth) {
  const role = auth && typeof auth === 'object' && typeof auth.role === 'string' ? auth.role : null;
  if (ROLES_WITH_PLAYER.has(role)) {
    const player = Number(auth.player);
    return player === 1 || player === 2 ? `${role}-p${player}` : 'unidentified';
  }
  if (ROLES_WITHOUT_PLAYER.has(role)) return role;
  return 'unidentified';
}

function emptyPiece() {
  return { connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null };
}

function createPresence() {
  const sockets = new Map(); // socketId -> { key, lastEventAt, data, lastGameEvent }

  function onConnect(socketId, auth, now) {
    const key = keyFromAuth(auth);
    sockets.set(socketId, { key, connectedAt: now, lastEventAt: null, data: {}, lastGameEvent: null });
    return key;
  }

  function onEvent(socketId, event, payload, now) {
    const s = sockets.get(socketId);
    if (!s) return;
    s.lastEventAt = now;
    const p = payload && typeof payload === 'object' ? payload : {};
    if (event === 'eSense') {
      s.data.attention = p.attention ?? null;
      s.data.poorSignalLevel = p.poorSignalLevel ?? null;
      s.data.source = p.source ?? null;
    } else if (event === 'gestureStatus') {
      s.data.handSeen = p.handSeen === true;
    }
    if (s.key === 'unidentified' && GAME_EVENTS.has(event)) s.lastGameEvent = { event, at: now };
  }

  function onDisconnect(socketId) {
    sockets.delete(socketId);
  }

  function snapshot() {
    const all = [...sockets.values()];
    const pieces = {};
    for (const key of PIECES) {
      const mine = all.filter((s) => s.key === key);
      if (mine.length === 0) { pieces[key] = emptyPiece(); continue; }
      // Reconexao com o socket velho ainda aberto: vale o que deu noticia por ultimo.
      const latest = mine.reduce((best, s) => ((s.lastEventAt ?? -1) > (best.lastEventAt ?? -1) ? s : best));
      pieces[key] = { ...emptyPiece(), ...latest.data, connected: true, lastEventAt: latest.lastEventAt };
    }
    const game = all.filter((s) => s.key === 'unidentified');
    const lastGameEvent = game.map((s) => s.lastGameEvent).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
    return { pieces, game: { connections: game.length, lastGameEvent } };
  }

  return { onConnect, onEvent, onDisconnect, snapshot };
}

module.exports = { createPresence, keyFromAuth, PIECES };
