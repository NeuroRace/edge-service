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
// Mesma regra de e-mail da tela de operacao (public/ops_state.js): um so lugar.
const { normalizeEmail, validateEmail } = require('./public/ops_state');

// ioredis `multi().exec()` resolve com um array de tuplas [err, result] e NAO
// rejeita quando um comando individual falha — so rejeita em abort de transacao.
// Sem isto, uma falha parcial (ex.: rpush ok, del falha) passaria silenciosa.
// execMulti varre as tuplas e lanca o primeiro erro por-comando.
async function execMulti(multi) {
  const results = await multi.exec();
  if (Array.isArray(results)) {
    for (const entry of results) {
      if (Array.isArray(entry) && entry[0]) throw entry[0];
    }
  }
  return results;
}

// `hooks.onDiscarded({ playerId, sessionId, reason })` (opcional) e chamado quando uma
// corrida consolidada e descartada: jogador sem e-mail registrado (NEU-73,
// `no_email_registered`) ou humano sem EEG (NEU-104, `no_eeg_signal`). Alimenta o /health.
function createSessionManager(redis, config, log, hooks = {}) {
  const minEegPackets = Number(config?.minEegPackets) || 1;

  // Identificacao por UUID Supabase ainda nao implementada (Stage 3 / NEU-37).
  // Ate la, todo e-mail e registrado sem validacao remota (`validated: false`).
  async function validateEmailRemote(email) {
    return { email, uuid: null, validated: false };
  }

  // D15 (NEU-68): normaliza (lower/trim) e valida o formato no edge, sem consultar a
  // nuvem. Vazio = anonimo (permitido). Invalido -> erro com code/field (HTTP 400).
  function checkEmail(raw, field) {
    const email = normalizeEmail(raw);
    if (!validateEmail(email)) {
      const err = new Error(`e-mail invalido em ${field}`);
      err.code = 'invalid_email';
      err.field = field;
      throw err;
    }
    return email;
  }

  async function registerPlayers(rawPlayer1Email, rawPlayer2Email) {
    const player1Email = checkEmail(rawPlayer1Email, 'player1Email');
    const player2Email = checkEmail(rawPlayer2Email, 'player2Email');
    const player1 = await validateEmailRemote(player1Email);
    const player2 = await validateEmailRemote(player2Email);

    await execMulti(
      redis
        .multi()
        .hset(
          'pending:players',
          'player1Email', player1Email,
          'player1Uuid', player1.uuid || '',
          'player2Email', player2Email,
          'player2Uuid', player2.uuid || '',
        )
        .expire('pending:players', 3600),
    );

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
    await execMulti(multi);

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
    // hasFinished nao passa por validateEventPayload (nao e enforced); valida aqui
    // para nao persistir registro-lixo (player undefined) na fila duravel.
    if (playerId !== 1 && playerId !== 2) {
      log('warn', 'has_finished_invalid_player', { playerId });
      return;
    }

    const session = await redis.hgetall('session:current');
    if (!session || !session.id) {
      log('warn', 'has_finished_no_active_session', { playerId });
      return;
    }

    if (session[`player${playerId}IsBot`] === 'true') {
      // NEU-73: antes era um return mudo — a forma mais provavel de perder a corrida de
      // uma pessoa real (largada sem registrar e-mails) sem ninguem perceber.
      log('warn', 'has_finished_discarded_bot', {
        playerId, sessionId: session.id, reason: 'no_email_registered',
      });
      if (typeof hooks.onDiscarded === 'function') {
        hooks.onDiscarded({ playerId, sessionId: session.id, reason: 'no_email_registered' });
      }
      return;
    }

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

      // NEU-104: fone desconectado/sem contato gera zero eSense, mas o jogo ainda manda
      // hasFinished — o tempo entraria no ranking como corrida valida. Descarta sem ir
      // para a fila, de forma barulhenta (log + /health + tela). O claim fica gravado:
      // um hasFinished duplicado nao dispara um segundo descarte.
      if (packets.length < minEegPackets) {
        await redis.del(packetsKey);
        log('warn', 'has_finished_discarded_no_eeg', {
          playerId, sessionId: session.id, reason: 'no_eeg_signal', packets: packets.length, minPackets: minEegPackets,
        });
        if (typeof hooks.onDiscarded === 'function') {
          hooks.onDiscarded({ playerId, sessionId: session.id, reason: 'no_eeg_signal' });
        }
        return;
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
      // execMulti garante que uma falha por-comando nao passe como sucesso.
      await execMulti(
        redis.multi().rpush('dispatch:queue', JSON.stringify(record)).del(packetsKey),
      );

      log('info', 'race_result_persisted', {
        jobId: record.jobId,
        playerId,
        sessionId: session.id,
        packets: packets.length,
      });
    } catch (err) {
      // Falha ao consolidar: libera o claim para permitir reprocessamento futuro
      // (evita perder a corrida por uma falha transitoria de Redis). Se ate o
      // rollback falhar, loga com contexto em vez de engolir silenciosamente.
      await redis.hdel('session:current', dispatchedKey).catch((rollbackErr) =>
        log('error', 'has_finished_rollback_failed', {
          sessionId: session.id,
          playerId,
          error: rollbackErr?.message ?? String(rollbackErr),
        }),
      );
      throw err;
    }
  }

  async function getCurrentSession() {
    const session = await redis.hgetall('session:current');
    // `pending` = jogadores registrados para a PROXIMA corrida (tela de operacao).
    const pendingRaw = await redis.hgetall('pending:players');
    const pending = pendingRaw && pendingRaw.player1Email !== undefined
      ? { player1Email: pendingRaw.player1Email, player2Email: pendingRaw.player2Email }
      : null;
    // `pending` so aparece quando existe (mantem o shape antigo para os chamadores atuais).
    if (!session || !session.id) return pending ? { status: 'none', pending } : { status: 'none' };
    const out = {
      status: session.status,
      sessionId: session.id,
      startedAt: Number(session.startedAt),
      player1Email: session.player1Email,
      player2Email: session.player2Email,
      player1IsBot: session.player1IsBot === 'true',
      player2IsBot: session.player2IsBot === 'true',
      // hasFinished ja consolidado (claim persistido) — sobrevive a reload da tela.
      player1Finished: session.player1Dispatched === 'true',
      player2Finished: session.player2Dispatched === 'true',
    };
    if (pending) out.pending = pending;
    return out;
  }

  // Ultimas corridas enviadas/rejeitadas pelo dispatcher (mais recente primeiro) — NEU-68.
  async function getDispatchHistory() {
    const items = await redis.lrange('dispatch:history', 0, -1);
    const out = [];
    for (const raw of items) {
      try { out.push(JSON.parse(raw)); } catch { /* entrada corrompida: ignora */ }
    }
    return out;
  }

  return { registerPlayers, onRaceStarted, onEsense, onHasFinished, getCurrentSession, getDispatchHistory };
}

module.exports = { createSessionManager, execMulti };
