// data_broker/session_manager.js
//
// Camada de persistencia local da corrida (NEU-36). Responsavel por:
//  - registrar e-mails dos jogadores antes da largada (`pending:players`)
//  - criar a sessao com raceId (UUID) no `raceStarted` (`session:current`)
//  - acumular pacotes eSense por jogador humano durante a corrida
//  - consolidar o resultado por jogador no `hasFinished` numa fila duravel
//    (`dispatch:queue`) que o dispatcher do Stage 3 (NEU-37) ira consumir
//
// Esta fase NAO envia nada para a Cloud. O `dispatch:queue` e apenas produzido
// (dado persistido aguardando o dispatcher do Stage 3).
const { randomUUID } = require('node:crypto');

function createSessionManager(redis, config, log) {
  // Identificacao por UUID Supabase ainda nao implementada (Stage 3 / NEU-37).
  // Ate la, todo e-mail e registrado sem validacao remota (`validated: false`).
  async function validateEmail(email) {
    return { email, uuid: null, validated: false };
  }

  async function registerPlayers(player1Email, player2Email) {
    const player1 = await validateEmail(player1Email);
    const player2 = await validateEmail(player2Email);

    await redis
      .multi()
      .hset(
        'pending:players',
        'player1Email', player1Email,
        'player1Uuid', player1.uuid || '',
        'player2Email', player2Email,
        'player2Uuid', player2.uuid || '',
      )
      .expire('pending:players', 3600)
      .exec();

    log('info', 'session_transition', { from: 'none', to: 'setup' });
    return { player1, player2 };
  }

  async function onRaceStarted() {
    const pending = await redis.hgetall('pending:players');
    const player1Email = pending?.player1Email || '';
    const player1Uuid = pending?.player1Uuid || '';
    const player2Email = pending?.player2Email || '';
    const player2Uuid = pending?.player2Uuid || '';

    // Limpa o estado da corrida anterior antes de criar a nova. Sem isto, as flags
    // `player{N}Dispatched` da corrida passada sobrevivem e fazem o `hasFinished`
    // da corrida seguinte ser tratado como duplicado (bug C3), e as listas de
    // pacotes da corrida anterior vazam no Redis (leak).
    const previous = await redis.hgetall('session:current');
    const id = randomUUID();
    const startedAt = Date.now();

    const multi = redis.multi();
    if (previous && previous.id) {
      multi.del(`session:${previous.id}:player:1:packets`);
      multi.del(`session:${previous.id}:player:2:packets`);
    }
    multi
      .del('session:current')
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
      .del('pending:players');
    await multi.exec();

    log('info', 'race_started', {
      sessionId: id,
      player1IsBot: player1Email === '',
      player2IsBot: player2Email === '',
    });
    log('info', 'session_transition', { from: 'setup', to: 'active', sessionId: id });
  }

  async function onEsense(payload) {
    // Bots nao sao persistidos (apenas jogadores humanos geram telemetria de corrida).
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
    if (!session || !session.id) {
      log('warn', 'has_finished_no_active_session', { playerId });
      return;
    }

    if (session[`player${playerId}IsBot`] === 'true') return;

    const dispatchedKey = `player${playerId}Dispatched`;

    // Claim atomico: garante que apenas um `hasFinished` consolida o jogador,
    // mesmo com eventos concorrentes/reemitidos (bug H3 — substitui o
    // read-check-write nao atomico por um HSETNX).
    const claimed = await redis.hsetnx('session:current', dispatchedKey, 'true');
    if (claimed === 0) {
      log('warn', 'has_finished_duplicate', { playerId, sessionId: session.id });
      return;
    }

    const packetsKey = `session:${session.id}:player:${playerId}:packets`;

    try {
      const rawPackets = await redis.lrange(packetsKey, 0, -1);

      // Parse defensivo: um pacote corrompido nao derruba a corrida inteira (bug H2).
      const packets = [];
      let corrupt = 0;
      for (const raw of rawPackets) {
        try {
          packets.push(JSON.parse(raw));
        } catch {
          corrupt += 1;
        }
      }
      if (corrupt > 0) {
        log('warn', 'has_finished_corrupt_packets', {
          sessionId: session.id,
          playerId,
          corrupt,
          kept: packets.length,
        });
      }

      const record = {
        jobId: randomUUID(),
        playerId,
        sessionId: session.id,
        persistedAt: Date.now(),
        payload: {
          email: session[`player${playerId}Email`],
          playerUuid: session[`player${playerId}Uuid`] || null,
          startedAt: Number(session.startedAt),
          finishedAt: Date.now(),
          packets,
        },
      };

      // Persiste o resultado e remove a lista de pacotes ja consolidada (anti-leak).
      await redis
        .multi()
        .rpush('dispatch:queue', JSON.stringify(record))
        .del(packetsKey)
        .exec();

      log('info', 'race_result_persisted', {
        jobId: record.jobId,
        playerId,
        sessionId: session.id,
        packets: packets.length,
      });
    } catch (err) {
      // Falha ao consolidar: libera o claim para permitir reprocessamento futuro
      // (evita perder a corrida por uma falha transitoria de Redis).
      await redis.hdel('session:current', dispatchedKey).catch(() => {});
      throw err;
    }
  }

  async function getCurrentSession() {
    const session = await redis.hgetall('session:current');
    if (!session || !session.id) return { status: 'none' };
    return {
      status: session.status,
      sessionId: session.id,
      player1Email: session.player1Email,
      player2Email: session.player2Email,
    };
  }

  return { registerPlayers, onRaceStarted, onEsense, onHasFinished, getCurrentSession };
}

module.exports = { createSessionManager };
