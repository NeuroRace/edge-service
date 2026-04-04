// data_broker/session_manager.js
const { randomUUID } = require('node:crypto');

function createSessionManager(redis, config, log) {
  async function validateEmail(email) {
    if (!email) return { email, uuid: null, validated: false };
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      log('warn', 'email_validation_skipped', { email });
      return { email, uuid: null, validated: false };
    }
    // Endpoint definido quando a Supabase Edge Function for implementada
    return { email, uuid: null, validated: false };
  }

  async function registerPlayers(player1Email, player2Email) {
    const player1 = await validateEmail(player1Email);
    const player2 = await validateEmail(player2Email);

    await redis.hset(
      'pending:players',
      'player1Email', player1Email,
      'player1Uuid', player1.uuid || '',
      'player2Email', player2Email,
      'player2Uuid', player2.uuid || '',
    );
    await redis.expire('pending:players', 3600);

    return { player1, player2 };
  }

  async function onRaceStarted() {
    const pending = await redis.hgetall('pending:players');

    const player1Email = pending?.player1Email || '';
    const player1Uuid = pending?.player1Uuid || '';
    const player2Email = pending?.player2Email || '';
    const player2Uuid = pending?.player2Uuid || '';

    const id = randomUUID();
    const startedAt = Date.now();

    await redis.multi()
      .hset(
        'session:current',
        'id', id,
        'startedAt', String(startedAt),
        'status', 'active',
        'player1Email', player1Email,
        'player1Uuid', player1Uuid,
        'player1IsBot', player1Email === '' ? 'true' : 'false',
        'player2Email', player2Email,
        'player2Uuid', player2Uuid,
        'player2IsBot', player2Email === '' ? 'true' : 'false',
      )
      .del('pending:players')
      .exec();

    log('info', 'race_started', {
      sessionId: id,
      player1IsBot: player1Email === '',
      player2IsBot: player2Email === '',
    });
  }

  async function onEsense() {}
  async function onHasFinished() {}

  return { registerPlayers, onRaceStarted, onEsense, onHasFinished };
}

module.exports = { createSessionManager };
