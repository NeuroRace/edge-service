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
// Mesma regra de contato (e-mail ou celular, NEU-160) da tela de operacao (public/ops_state.js): um so lugar.
const { parseContact, RACE_LOCK_MS } = require('./public/ops_state');
const { PLAYER_SETUP_KEY } = require('./player_setup');
const { CLOSE_SCRIPT, LINK_SCRIPT, ENQUEUE_SCRIPT } = require('./session_scripts');

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
// NEU-141: ultimos jogadores cadastrados (registrar de novo com um clique). Sorted set
// contato -> horario do ultimo registro; fica no Redis do PC central (funciona sem internet)
// e so e apagado a mao (botao "Limpar lista").
const RECENT_PLAYERS = 'players:recent';
const RECENT_PLAYERS_MAX = 200;

// NEU-140 (spec B8a): como cada lado entrou na corrida. So `contact` vai para a nuvem.
const KINDS = ['contact', 'nosignup', 'bot', 'missing'];
function kindOf(session, n) {
  const k = session && session[`player${n}Kind`];
  if (KINDS.includes(k)) return k;
  // Sessao gravada antes da NEU-140: so havia IsBot.
  return session && session[`player${n}IsBot`] === 'true' ? 'bot' : 'contact';
}

function createSessionManager(redis, config, log, hooks = {}) {
  const now = typeof hooks.now === 'function' ? hooks.now : Date.now;
  const minEegPackets = Number(config?.minEegPackets) || 1;
  // NEU-179: sem config (testes) nao ha piso; no estande vem do config.js (15 s).
  const minRaceMs = Math.max(0, Number(config?.minRaceSeconds) || 0) * 1000;
  const SESSION_KEY = 'session:current';
  const packetsKey = (id, n) => `session:${id}:player:${n}:packets`;
  // eSense de sessao fechada: um log por sessao, nao um por pacote (1/s por jogador).
  const loggedClosed = new Set();

  // Revisao do #41 (NEU-179): os eventos chegam do socket sem await entre si. Sem fila, o
  // raceStopped (o ultimo chega e o jogo volta para a espera na hora) fechava a sessao entre
  // o claim e o ENQUEUE do hasFinished: a chegada sumia em silencio, ou virava descarte falso
  // de "sem EEG" (o CLOSE apagava os pacotes). Um evento do socket por vez, na ordem.
  let tail = Promise.resolve();
  function serial(fn) {
    return (...args) => {
      const run = tail.then(() => fn(...args));
      tail = run.catch(() => {});
      return run;
    };
  }

  // NEU-140: fecha a sessao `id` de forma atomica (so se ainda for a atual e estiver aberta).
  async function closeSession(id, status, at) {
    const closed = await redis.eval(CLOSE_SCRIPT, 3, SESSION_KEY, packetsKey(id, 1), packetsKey(id, 2), id, status, String(at));
    return Number(closed) === 1;
  }

  // Le a sessao atual e aplica a expiracao (spec L3): 10 min da largada = esquecida.
  async function readSession(at = now()) {
    const s = await redis.hgetall(SESSION_KEY);
    if (!s || !s.id) return null;
    if (s.status === 'active' && !(at - Number(s.startedAt) < RACE_LOCK_MS)) {
      if (await closeSession(s.id, 'expired', at)) {
        log('info', 'session_expired', { sessionId: s.id, startedAt: Number(s.startedAt) });
        // Revisao do PR #32: lado de gente que nao chegou em 10 min perdeu a corrida. Avisa
        // como descarte (log + /health + painel), em vez de sumir so com o log acima.
        for (const n of [1, 2]) {
          if (!['contact', 'missing'].includes(kindOf(s, n)) || s[`player${n}Dispatched`] === 'true') continue;
          log('warn', 'session_expired_unfinished', { playerId: n, sessionId: s.id, kind: kindOf(s, n) });
          if (typeof hooks.onDiscarded === 'function') hooks.onDiscarded({ playerId: n, sessionId: s.id, reason: 'session_expired' });
        }
      }
      return redis.hgetall(SESSION_KEY);
    }
    return s;
  }

  // Identificacao por UUID Supabase ainda nao implementada (Stage 3 / NEU-37).
  // Ate la, todo e-mail e registrado sem validacao remota (`validated: false`).
  async function validateEmailRemote(email) {
    return { email, uuid: null, validated: false };
  }

  // D15 (NEU-68): normaliza e valida o formato no edge, sem consultar a nuvem. Vazio =
  // anonimo. Invalido -> erro com code/field (HTTP 400). NEU-160: celular vira +55DDD9XXXXXXXX
  // e fica no mesmo campo `player{N}Email` (sem renomear chaves do Redis).
  function checkEmail(raw, field) {
    const c = parseContact(raw);
    if (c.error) {
      const err = new Error(`${c.type === 'phone' ? 'celular' : 'e-mail ou apelido'} invalido em ${field}`);
      err.code = c.error.code;
      err.field = field;
      err.reason = c.error.text;
      throw err;
    }
    return c.value;
  }

  // NEU-86 (spec B2): lado escolhido como Bot no painel nunca e cadastrado nem enviado.
  async function botSlots() {
    const setup = (await redis.hgetall(PLAYER_SETUP_KEY)) || {};
    return { 1: setup.p1Source === 'bot', 2: setup.p2Source === 'bot' };
  }

  // NEU-140: lado NeuroSky vazio so vale com "Sem cadastro" marcado de proposito.
  function sideOf(raw, field, isBot, noSignup) {
    if (isBot) return { email: '', kind: 'bot', noSignup: false };
    const email = checkEmail(raw, field);
    if (email) return { email, kind: 'contact', noSignup: false };
    if (noSignup === true) return { email: '', kind: 'nosignup', noSignup: true };
    const err = new Error(`contato ausente em ${field}`);
    err.code = 'missing_contact';
    err.field = field;
    throw err;
  }

  async function registerPlayers(rawPlayer1Email, rawPlayer2Email, { p1NoSignup = false, p2NoSignup = false } = {}) {
    const bots = await botSlots();
    const side1 = sideOf(rawPlayer1Email, 'player1Email', bots[1], p1NoSignup);
    const side2 = sideOf(rawPlayer2Email, 'player2Email', bots[2], p2NoSignup);
    const player1 = await validateEmailRemote(side1.email);
    const player2 = await validateEmailRemote(side2.email);

    const multi = redis
      .multi()
      .hset(
        'pending:players',
        'player1Email', side1.email,
        'player1Uuid', player1.uuid || '',
        'player1Kind', side1.kind,
        'player1NoSignup', String(side1.noSignup),
        'player2Email', side2.email,
        'player2Uuid', player2.uuid || '',
        'player2Kind', side2.kind,
        'player2NoSignup', String(side2.noSignup),
      )
      .expire('pending:players', 3600);
    // So cadastrados entram na lista (anonimo nunca). Registrar de novo so atualiza o horario.
    const at = now();
    for (const email of [side1.email, side2.email]) if (email) multi.zadd(RECENT_PLAYERS, at, email);
    multi.zremrangebyrank(RECENT_PLAYERS, 0, -(RECENT_PLAYERS_MAX + 1));
    await execMulti(multi);

    log('info', 'session_transition', { from: 'none', to: 'setup' });
    return { player1, player2 };
  }

  async function onRaceStarted() {
    const pending = (await redis.hgetall('pending:players')) || {};
    const bots = await botSlots();
    // NEU-140: Bot do painel manda; depois contato; depois "Sem cadastro" marcado; senao, esqueceram.
    const sideAt = (n) => {
      if (bots[n]) return { email: '', uuid: '', kind: 'bot' };
      const email = pending[`player${n}Email`] || '';
      if (email) return { email, uuid: pending[`player${n}Uuid`] || '', kind: 'contact' };
      if (pending[`player${n}NoSignup`] === 'true') return { email: '', uuid: '', kind: 'nosignup' };
      return { email: '', uuid: '', kind: 'missing' };
    };
    const p1 = sideAt(1);
    const p2 = sideAt(2);

    // Limpa o estado da corrida anterior antes de criar a nova. Sem isto, as flags
    // `player{N}Dispatched` da corrida passada sobrevivem e fazem o `hasFinished`
    // da corrida seguinte ser tratado como duplicado (bug C3), e as listas de
    // pacotes da corrida anterior vazam no Redis (leak).
    const previous = await redis.hgetall('session:current');
    const id = randomUUID();
    const startedAt = now();

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
        'player1Email', p1.email,
        'player1Uuid', p1.uuid,
        'player1Kind', p1.kind,
        'player1IsBot', p1.kind === 'contact' ? 'false' : 'true',
        'player2Email', p2.email,
        'player2Uuid', p2.uuid,
        'player2Kind', p2.kind,
        'player2IsBot', p2.kind === 'contact' ? 'false' : 'true',
      )
      .del('pending:players');
    await execMulti(multi);

    log('info', 'race_started', {
      sessionId: id,
      player1Kind: p1.kind,
      player2Kind: p2.kind,
      player1IsBot: p1.kind !== 'contact',
      player2IsBot: p2.kind !== 'contact',
    });
    log('info', 'session_transition', { from: 'setup', to: 'active', sessionId: id });
  }

  async function onEsense(payload) {
    // Bots nao sao persistidos (apenas jogadores humanos geram telemetria de corrida).
    if (payload.source === 'bot') return;

    const session = await readSession();
    if (!session || !session.id) {
      log('warn', 'esense_no_active_session', { player: payload.player });
      return;
    }
    if (session.status !== 'active') {
      if (!loggedClosed.has(session.id)) {
        if (loggedClosed.size > 100) loggedClosed.clear();
        loggedClosed.add(session.id);
        log('warn', 'esense_ignored_closed_session', { sessionId: session.id, status: session.status });
      }
      return;
    }

    await redis.rpush(packetsKey(session.id, payload.player), JSON.stringify(payload));
  }

  async function onHasFinished(payload) {
    const { playerId } = payload;
    // hasFinished nao passa por validateEventPayload (nao e enforced); valida aqui
    // para nao persistir registro-lixo (player undefined) na fila duravel.
    if (playerId !== 1 && playerId !== 2) {
      log('warn', 'has_finished_invalid_player', { playerId });
      return;
    }

    const session = await readSession();
    if (!session || !session.id) {
      log('warn', 'has_finished_no_active_session', { playerId });
      return;
    }
    if (session.status !== 'active') {
      log('warn', 'has_finished_ignored_closed_session', { playerId, sessionId: session.id, status: session.status });
      return;
    }

    // NEU-179: o hasFinished nao diz de qual corrida e. Um atrasado da corrida anterior
    // caia nesta com tempo falso (0,45 s no teste) e ganhava a rodada. Antes do piso, ignora
    // SEM o claim: a chegada de verdade deste lado ainda conta.
    const elapsedMs = now() - Number(session.startedAt);
    if (minRaceMs > 0 && elapsedMs < minRaceMs) {
      log('warn', 'has_finished_too_soon', { playerId, sessionId: session.id, elapsedMs, minRaceMs });
      if (typeof hooks.onFinishIgnored === 'function') {
        hooks.onFinishIgnored({ playerId, sessionId: session.id, reason: 'too_soon', elapsedMs, minRaceMs });
      }
      return;
    }

    const dispatchedKey = `player${playerId}Dispatched`;

    // Claim atomico primeiro (bug H3: HSETNX), depois a releitura. NEU-140: depois do claim
    // nenhum vinculo grava (LINK_SCRIPT confere o Dispatched), entao a releitura e a verdade.
    const claimed = await redis.hsetnx(SESSION_KEY, dispatchedKey, 'true');
    if (claimed === 0) {
      log('warn', 'has_finished_duplicate', { playerId, sessionId: session.id });
      return;
    }
    const current = await redis.hgetall(SESSION_KEY);
    if (!current || current.id !== session.id || current.status !== 'active') {
      log('warn', 'has_finished_ignored_closed_session', { playerId, sessionId: session.id, status: current && current.status });
      return;
    }

    const kind = kindOf(current, playerId);
    const listKey = packetsKey(session.id, playerId);
    // Spec B8a: lado que nao vai para a nuvem nao deixa os pacotes no Redis ate a proxima largada.
    if (kind !== 'contact') await redis.del(listKey);
    if (kind === 'missing') {
      // NEU-73: largada sem registro — a forma mais provavel de perder a corrida de uma pessoa.
      log('warn', 'has_finished_discarded_bot', {
        playerId, sessionId: session.id, reason: 'no_email_registered',
      });
      if (typeof hooks.onDiscarded === 'function') {
        hooks.onDiscarded({ playerId, sessionId: session.id, reason: 'no_email_registered' });
      }
      return;
    }
    if (kind !== 'contact') {
      // Bot ou "Sem cadastro": escolha do operador, nada a gravar e nada a alertar.
      log('info', 'has_finished_not_saved', { playerId, sessionId: session.id, kind });
      return;
    }

    try {
      const rawPackets = await redis.lrange(listKey, 0, -1);

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
        // Revisao do #41: um Parar entre a releitura e o lrange apaga os pacotes (CLOSE). Sessao
        // fechada no meio nao e "sem EEG": o Parar ganha e nao ha banner falso de fone.
        const still = await redis.hgetall(SESSION_KEY);
        if (!still || still.id !== session.id || still.status !== 'active') {
          log('warn', 'has_finished_ignored_closed_session', { playerId, sessionId: session.id, status: still && still.status });
          return;
        }
        await redis.del(listKey);
        log('warn', 'has_finished_discarded_no_eeg', {
          playerId, sessionId: session.id, reason: 'no_eeg_signal', packets: packets.length, minPackets: minEegPackets,
        });
        if (typeof hooks.onDiscarded === 'function') {
          hooks.onDiscarded({ playerId, sessionId: session.id, reason: 'no_eeg_signal' });
        }
        return;
      }

      // NEU-160: o contato guardado e e-mail, celular (+55...) ou apelido do site.
      // Celular vai em `phone`; apelido em `nickname`; os dois com `email: null`.
      const contact = current[`player${playerId}Email`];
      const contactType = parseContact(contact).type;
      const record = {
        jobId: randomUUID(),
        playerId,
        sessionId: session.id,
        persistedAt: Date.now(),
        payload: {
          ...(contactType === 'phone' ? { email: null, phone: contact }
            : contactType === 'nickname' ? { email: null, nickname: contact } : { email: contact }),
          playerUuid: current[`player${playerId}Uuid`] || null,
          startedAt: Number(session.startedAt),
          finishedAt: Date.now(),
          packets,
        },
      };

      // Persiste o resultado e remove a lista de pacotes ja consolidada (anti-leak), so se a
      // sessao ainda estiver aberta: um Parar no meio ganha (ENQUEUE_SCRIPT, atomico).
      const enqueued = await redis.eval(ENQUEUE_SCRIPT, 3, SESSION_KEY, 'dispatch:queue', listKey, session.id, JSON.stringify(record), `player${playerId}Saved`);
      if (Number(enqueued) !== 1) {
        const closed = await redis.hgetall(SESSION_KEY);
        log('warn', 'has_finished_ignored_closed_session', { playerId, sessionId: session.id, status: closed && closed.status });
        return;
      }

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

  // NEU-140 (spec C6): Parar. Nada da corrida e gravado; a proxima dupla (pending) fica.
  // `expectedId` (opcional) = a corrida que o operador via: o jogo pode ter largado outra
  // entre a tela e o clique, e essa nao pode ser parada no lugar da que ele viu.
  async function stopRace(expectedId) {
    const at = now();
    const s = await readSession(at);
    if (!s || s.status !== 'active') return { ok: false, error: 'no_active_session' };
    if (expectedId && expectedId !== s.id) return { ok: false, error: 'session_changed' };
    if (!(await closeSession(s.id, 'cancelled', at))) return { ok: false, error: 'no_active_session' };
    // Revisao do #36: quem ja estava na fila continua la. Depois do CLOSE nenhum ENQUEUE grava,
    // entao a releitura e a verdade.
    const closed = (await redis.hgetall(SESSION_KEY)) || {};
    const saved = [1, 2].filter((n) => closed[`player${n}Saved`] === 'true');
    log('info', 'race_stopped', { sessionId: s.id, afterMs: at - Number(s.startedAt), saved });
    // `saved` so aparece quando alguem ja foi gravado: sem ninguem, a resposta e a de antes.
    return saved.length ? { ok: true, sessionId: s.id, saved } : { ok: true, sessionId: s.id };
  }

  // NEU-179: o jogo avisa que parou e voltou para a espera. Fecha a sessao, e o painel libera
  // o Largar sem precisar do Parar. Quem ja chegou fica na fila; quem nao chegou perde a
  // corrida, como no Parar. Um raceStopped atrasado da corrida anterior chegaria logo depois
  // da largada desta: antes do piso, ele e ignorado.
  // NEU-181 (revisao do #45): o raceStopped tambem nao diz de qual corrida e. O jogo manda um
  // a cada stopRace que recebe (NEU-146). Se ele travou, o operador larga mesmo assim, e o
  // raceStopped velho chegaria depois do piso fechando a corrida seguinte. Cada stopRace que o
  // painel manda deixa uma marca; o raceStopped seguinte e a confirmacao dela: so consome a
  // marca e nao fecha nada. Marca com mais de 10 min (RACE_LOCK_MS) e esquecida.
  const STOP_PENDING_KEY = 'game:stopPending';
  async function onStopCommand() {
    await redis.hincrby(STOP_PENDING_KEY, 'count', 1);
    await redis.hset(STOP_PENDING_KEY, 'at', String(now()));
  }

  async function onRaceStopped() {
    const at = now();
    const mark = (await redis.hgetall(STOP_PENDING_KEY)) || {};
    const pendingStops = Number(mark.count) || 0;
    if (pendingStops > 0 && at - Number(mark.at) < RACE_LOCK_MS) {
      await redis.hincrby(STOP_PENDING_KEY, 'count', -1);
      log('info', 'race_stopped_confirmed', { pendingStops: pendingStops - 1 });
      return;
    }
    if (pendingStops > 0) await redis.del(STOP_PENDING_KEY);
    const s = await readSession(at);
    if (!s || s.status !== 'active') return;
    const afterMs = at - Number(s.startedAt);
    if (minRaceMs > 0 && afterMs < minRaceMs) {
      log('warn', 'race_stopped_too_soon', { sessionId: s.id, afterMs, minRaceMs });
      return;
    }
    if (await closeSession(s.id, 'stopped', at)) log('info', 'race_stopped_by_game', { sessionId: s.id, afterMs });
  }

  // NEU-140: o jogo largou sem registro (lado missing); o operador vincula o contato
  // ate o hasFinished daquele lado. Atomico contra o claim do hasFinished (LINK_SCRIPT).
  async function linkPlayer(player, rawEmail, expectedId) {
    if (player !== 1 && player !== 2) return { ok: false, error: 'invalid_player' };
    // Nao-texto e vazio seguem invalid_email, como antes da NEU-160.
    const c = parseContact(typeof rawEmail === 'string' ? rawEmail : '');
    if (c.type === 'empty') return { ok: false, error: 'invalid_email' };
    if (c.error) return { ok: false, error: c.error.code };
    const email = c.value;
    const s = await readSession();
    if (!s || s.status !== 'active') return { ok: false, error: 'no_active_session' };
    // Mesma regra do Parar: a pessoa da corrida que o operador via nao vai para a seguinte.
    if (expectedId && expectedId !== s.id) return { ok: false, error: 'session_changed' };
    const result = await redis.eval(LINK_SCRIPT, 1, SESSION_KEY, String(player), email, s.id);
    if (result !== 'ok') return { ok: false, error: String(result) };
    await execMulti(redis.multi().zadd(RECENT_PLAYERS, now(), email).zremrangebyrank(RECENT_PLAYERS, 0, -(RECENT_PLAYERS_MAX + 1)));
    log('info', 'player_linked', { sessionId: s.id, playerId: player });
    return { ok: true, session: await getCurrentSession() };
  }

  // NEU-86: ha corrida de gente em andamento? Trava a troca de fonte e camera.
  // NEU-140: so sessao aberta; lado esquecido (missing) conta como gente.
  async function raceInProgress(at = now()) {
    const s = await readSession(at);
    if (!s || s.status !== 'active') return false;
    return [1, 2].some((n) => ['contact', 'missing'].includes(kindOf(s, n)) && s[`player${n}Dispatched`] !== 'true');
  }

  async function getCurrentSession() {
    const session = await readSession();
    // `pending` = jogadores registrados para a PROXIMA corrida (tela de operacao).
    const pendingRaw = await redis.hgetall('pending:players');
    const pending = pendingRaw && pendingRaw.player1Email !== undefined
      ? {
        player1Email: pendingRaw.player1Email,
        player2Email: pendingRaw.player2Email,
        player1Kind: pendingRaw.player1Kind || (pendingRaw.player1Email ? 'contact' : 'missing'),
        player2Kind: pendingRaw.player2Kind || (pendingRaw.player2Email ? 'contact' : 'missing'),
      }
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
      player1Kind: kindOf(session, 1),
      player2Kind: kindOf(session, 2),
      // hasFinished ja consolidado (claim persistido) — sobrevive a reload da tela.
      player1Finished: session.player1Dispatched === 'true',
      player2Finished: session.player2Dispatched === 'true',
      // Revisao do #36: o lado ja esta na fila da nuvem (o descarte sem EEG nao marca).
      player1Saved: session.player1Saved === 'true',
      player2Saved: session.player2Saved === 'true',
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

  async function getRecentPlayers() {
    const flat = await redis.zrevrange(RECENT_PLAYERS, 0, -1, 'WITHSCORES');
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ contact: flat[i], lastAt: Number(flat[i + 1]) });
    return out;
  }

  async function clearRecentPlayers() {
    await redis.del(RECENT_PLAYERS);
    log('info', 'recent_players_cleared', {});
  }

  return {
    registerPlayers,
    onRaceStarted: serial(onRaceStarted),
    onEsense: serial(onEsense),
    onHasFinished: serial(onHasFinished),
    onRaceStopped: serial(onRaceStopped),
    onStopCommand: serial(onStopCommand),
    // Parar e Vincular vem do painel (HTTP) e ja sao atomicos contra o claim (Lua): ficam fora
    // da fila, de proposito. Um Parar no meio do hasFinished continua ganhando (revisao do #32).
    stopRace, linkPlayer,
    getCurrentSession, getDispatchHistory, getRecentPlayers, clearRecentPlayers, raceInProgress,
  };
}

module.exports = { createSessionManager, execMulti, RECENT_PLAYERS_MAX };
