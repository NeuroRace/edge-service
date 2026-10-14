// data_broker/piece_commands.js
// NEU-86: comandos do broker para as pecas. A acquisition recebe `setSource` (NeuroSky |
// Bot) e o detector recebe `setCamera`, na conexao (escolha guardada) e quando o operador
// troca. So a peca daquele jogador recebe. Peca antiga sem handler ignora em silencio.
const KEY_RE = /^(acquisition|gesture)-p([12])$/;

function createPieceCommands(playerSetup, log = () => {}) {
  const sockets = new Map(); // pieceKey -> Set(socket)

  function sendTo(socket, key) {
    const m = KEY_RE.exec(key);
    if (!m) return;
    const setup = playerSetup.get()[Number(m[2])];
    if (m[1] === 'acquisition') socket.emit('setSource', { source: setup.source });
    else if (setup.camera !== null) socket.emit('setCamera', { camera: setup.camera });
  }

  function attach(socket, key) {
    if (!KEY_RE.test(key)) return;
    if (!sockets.has(key)) sockets.set(key, new Set());
    sockets.get(key).add(socket);
    socket.on('disconnect', () => sockets.get(key).delete(socket));
    sendTo(socket, key);
  }

  function push(key) {
    const set = sockets.get(key);
    for (const socket of set || []) sendTo(socket, key);
    log('info', 'piece_command_pushed', { piece: key, sockets: set ? set.size : 0 });
  }

  return {
    attach,
    pushSource: (player) => push(`acquisition-p${player}`),
    pushCamera: (player) => push(`gesture-p${player}`),
    pushAll: () => { for (const p of [1, 2]) { push(`acquisition-p${p}`); push(`gesture-p${p}`); } },
  };
}

module.exports = { createPieceCommands };
