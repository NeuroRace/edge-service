// data_broker/presence.js
// NEU-139: quem esta conectado ao broker e quando deu noticia pela ultima vez.
// Cada peca nossa se apresenta no connect (`socket.handshake.auth`); o jogo nao se
// apresenta e e reconhecido como a conexao anonima (fallback da spec, secao 8).
const PIECES = ['acquisition-p1', 'gesture-p1', 'acquisition-p2', 'gesture-p2'];
const ROLES_WITH_PLAYER = new Set(['acquisition', 'gesture']);
const ROLES_WITHOUT_PLAYER = new Set(['panel', 'test-client']);
const GAME_EVENTS = new Set(['raceStarted', 'hasFinished', 'gameEvent']);
const META_FIELDS = ['version', 'source', 'eegHost', 'acqPort', 'commit', 'branch', 'camera'];
const RECENT_GAME_EVENTS = 5;

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

// NEU-142: so campos conhecidos do auth; string cortada em 64, numero so se finito.
function sanitizeMeta(auth) {
  const out = {};
  if (!auth || typeof auth !== 'object') return out;
  for (const k of META_FIELDS) {
    const v = auth[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v.slice(0, 64);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function emptyPiece() {
  return { connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null, meta: {} };
}

function createPresence() {
  const sockets = new Map(); // socketId -> { key, lastEventAt, data, meta, lastGameEvent }
  const recentEvents = []; // NEU-142: ultimos eventos do jogo, mais recente primeiro

  function onConnect(socketId, auth, now) {
    const key = keyFromAuth(auth);
    sockets.set(socketId, { key, connectedAt: now, lastEventAt: null, data: {}, meta: sanitizeMeta(auth), lastGameEvent: null });
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
    if (s.key === 'unidentified' && GAME_EVENTS.has(event)) {
      s.lastGameEvent = { event, at: now };
      recentEvents.unshift({ event, at: now });
      recentEvents.length = Math.min(recentEvents.length, RECENT_GAME_EVENTS);
    }
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
      pieces[key] = { ...emptyPiece(), ...latest.data, connected: true, lastEventAt: latest.lastEventAt, meta: { ...latest.meta } };
    }
    const game = all.filter((s) => s.key === 'unidentified');
    const lastGameEvent = game.map((s) => s.lastGameEvent).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
    const connections = {};
    for (const s of all) connections[s.key] = (connections[s.key] || 0) + 1;
    return { pieces, game: { connections: game.length, lastGameEvent, recentEvents: recentEvents.map((e) => ({ ...e })) }, connections };
  }

  return { onConnect, onEvent, onDisconnect, snapshot };
}

// NEU-142: corpo do GET /api/status (relogio do broker em `now`).
function buildStatus({ presence, redisStatus, brokerVersion, startedAt, now }) {
  return {
    now,
    ...presence.snapshot(),
    redis: { status: redisStatus },
    broker: { version: brokerVersion, uptimeSeconds: Math.floor((now - startedAt) / 1000) },
  };
}

module.exports = { createPresence, keyFromAuth, sanitizeMeta, buildStatus, PIECES };
