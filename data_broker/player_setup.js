// data_broker/player_setup.js
// NEU-86: fonte (NeuroSky | Bot) e camera de cada jogador, escolhidas no painel. Fica no
// Redis do PC central (sobrevive a reinicio do broker) e numa copia em memoria, porque o
// /api/status e sincrono. Quem manda o comando para a peca e o piece_commands (onChange).
const PLAYER_SETUP_KEY = 'players:setup';
const SOURCES = new Set(['neurosky', 'bot']);
const CAMERAS = new Set([0, 1, 2]);

const validPlayer = (p) => p === 1 || p === 2;
const validCamera = (c) => typeof c === 'number' && Number.isInteger(c) && CAMERAS.has(c);

function parse(hash) {
  const h = hash || {};
  const out = {};
  for (const p of [1, 2]) {
    const source = SOURCES.has(h[`p${p}Source`]) ? h[`p${p}Source`] : 'neurosky';
    const raw = h[`p${p}Camera`];
    const camera = raw !== undefined && raw !== '' && validCamera(Number(raw)) ? Number(raw) : null;
    out[p] = { source, camera };
  }
  return out;
}

function createPlayerSetup(redis, { raceInProgress = async () => false, onChange = () => {}, log = () => {} } = {}) {
  let current = parse({});

  const get = () => ({ 1: { ...current[1] }, 2: { ...current[2] } });

  async function load() {
    current = parse(await redis.hgetall(PLAYER_SETUP_KEY));
    return get();
  }

  async function set(player, field, value) {
    if (await raceInProgress()) return { ok: false, error: 'race_in_progress' };
    await redis.hset(PLAYER_SETUP_KEY, `p${player}${field === 'source' ? 'Source' : 'Camera'}`, String(value));
    current[player][field] = value;
    log('info', 'player_setup_changed', { player, field, value });
    onChange(field, player);
    return { ok: true, setup: get() };
  }

  async function setSource(player, source) {
    if (!validPlayer(player)) return { ok: false, error: 'invalid_player' };
    if (!SOURCES.has(source)) return { ok: false, error: 'invalid_source' };
    return set(player, 'source', source);
  }

  async function setCamera(player, camera) {
    if (!validPlayer(player)) return { ok: false, error: 'invalid_player' };
    if (!validCamera(camera)) return { ok: false, error: 'invalid_camera' };
    return set(player, 'camera', camera);
  }

  return { load, get, setSource, setCamera };
}

module.exports = { createPlayerSetup, PLAYER_SETUP_KEY };
