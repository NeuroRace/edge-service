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

  async function onEsense(payload) {
    if (payload.source === 'bot') return;

    const session = await redis.hgetall('session:current');
    if (!session || !session.id) {
      log('warn', 'esense_no_active_session', { player: payload.player });
      return;
    }

    await redis.rpush(
      `session:${session.id}:player:${payload.player}:packets`,
      JSON.stringify(payload),
    );
  }

  async function onHasFinished(payload) {
    const { playerId } = payload;
    const session = await redis.hgetall('session:current');
    if (!session) {
      log('warn', 'has_finished_no_active_session', { playerId });
      return;
    }

    const isBotKey = `player${playerId}IsBot`;
    const dispatchedKey = `player${playerId}Dispatched`;

    if (session[isBotKey] === 'true') return;

    if (session[dispatchedKey] === 'true') {
      log('warn', 'has_finished_duplicate', { playerId, sessionId: session.id });
      return;
    }

    const rawPackets = await redis.lrange(
      `session:${session.id}:player:${playerId}:packets`,
      0,
      -1,
    );
    const packets = rawPackets.map((p) => JSON.parse(p));

    const job = {
      jobId: randomUUID(),
      playerId,
      sessionId: session.id,
      expiresAt: Date.now() + config.dispatchTtlMs,
      attempts: 0,
      payload: {
        email: session[`player${playerId}Email`],
        playerUuid: session[`player${playerId}Uuid`] || null,
        startedAt: Number(session.startedAt),
        finishedAt: Date.now(),
        packets,
      },
    };

    await redis.rpush('dispatch:queue', JSON.stringify(job));
    await redis.hset('session:current', dispatchedKey, 'true');
    log('info', 'job_enqueued', { jobId: job.jobId, playerId, sessionId: session.id });
  }

  return { registerPlayers, onRaceStarted, onEsense, onHasFinished };
}

module.exports = { createSessionManager };
