// data_broker/api_dispatcher.js
// Consome dispatch:queue e entrega cada resultado de corrida a Edge Function
// ingest-race (Supabase). Fila confiavel via BLMOVE -> dispatch:processing com
// recuperacao no boot; dead-letter para falhas permanentes/esgotadas/malformadas;
// timeout HTTP. Ver spec §5.
//
// NEU-92: falha transitoria NAO retenta em linha (isso segurava a fila inteira durante
// uma queda da nuvem). O job sai de processing para dispatch:retry (ZSET, score = hora
// da proxima tentativa, com backoff) e o dispatcher segue para o proximo. Quando vence,
// o job volta para o fim da fila. O contador de tentativas fica em dispatch:attempts
// (hash por jobId), para o registro seguir intacto ate o dead-letter.
const { toCanonicalBody } = require('./dispatch_mapping');
const { execMulti } = require('./session_manager');

const QUEUE = 'dispatch:queue';
const PROCESSING = 'dispatch:processing';
const DEADLETTER = 'dispatch:deadletter';
const RETRY = 'dispatch:retry';
const ATTEMPTS = 'dispatch:attempts';
// Historico curto (ultimas N corridas enviadas/rejeitadas) para a tela de operacao (NEU-68).
const HISTORY = 'dispatch:history';
const HISTORY_MAX = 20;

// Mascara o e-mail para logs/historico: 2 primeiros chars + ***@dominio (nunca o e-mail inteiro).
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

function targetOf(apiUrl) {
  try { return new URL(apiUrl).host; } catch { return null; }
}

function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'success';
  if (status === 429) return 'transient';
  if (status >= 400 && status < 500) return 'permanent';
  return 'transient'; // 5xx e qualquer outro
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

async function postRace(fetchFn, config, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.dispatchHttpTimeoutMs);
  try {
    return await fetchFn(config.apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-edge-ingest-token': config.edgeIngestToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function isValidRecord(r) {
  return r && typeof r === 'object'
    && typeof r.jobId === 'string'
    && (r.playerId === 1 || r.playerId === 2)
    && typeof r.sessionId === 'string'
    && r.payload && typeof r.payload === 'object'
    && Array.isArray(r.payload.packets);
}

// Normaliza a forma de cada entrada no dead-letter para que todos os sites
// produzam o mesmo conjunto de chaves (facilita inspecao e alertas).
// `raw` (o registro original da fila, string) e OBRIGATORIO em todos os caminhos:
// sem ele a corrida e irrecuperavel (bug F1 / NEU-82 — exhausted/permanent/
// mapping_failed chegavam aqui sem raw). Requeue manual = RPUSH dispatch:queue <raw>.
function deadLetterEntry({ raw = null, record = null, reason, httpStatus = null, errorCode = null, attempts = 1, error = null, now = Date.now }) {
  return { reason, jobId: record?.jobId ?? null, httpStatus, errorCode, attempts, error, raw, failedAt: now() };
}

function createDispatcher(
  redis,
  config,
  log,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
) {
  let running = false;
  // Estado observavel (D11 / NEU-69): exposto via getState() -> /health. Nunca derruba
  // o processo nem muda o status do /health; apenas informa.
  const state = {
    enabled: true,
    target: targetOf(config.apiUrl),
    lastPollAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    inFlightJobId: null,
    counts: { queue: null, processing: null, retrying: null, deadletter: null },
  };

  async function refreshCounts() {
    try {
      state.counts = {
        queue: await redis.llen(QUEUE),
        processing: await redis.llen(PROCESSING),
        retrying: await redis.zcard(RETRY),
        deadletter: await redis.llen(DEADLETTER),
      };
    } catch (err) {
      log('warn', 'dispatch_counts_error', { error: err?.message ?? String(err) });
    }
  }

  // Observabilidade NUNCA interfere no fluxo confiavel (achado do critico codex, NEU-82):
  // o POST ja aconteceu e o item ja saiu de processing quando isto roda. Uma falha aqui
  // (tipo errado da chave, ACL, Redis instavel) vira warn, nao excecao no loop.
  async function pushHistory(entry) {
    try {
      await redis.lpush(HISTORY, JSON.stringify(entry));
      await redis.ltrim(HISTORY, 0, HISTORY_MAX - 1);
    } catch (err) {
      log('warn', 'dispatch_history_error', { jobId: entry.jobId, error: err?.message ?? String(err) });
    }
  }

  function historyEntry(record, { status, result = null, httpStatus = null, reason = null, attempts }) {
    return {
      jobId: record?.jobId ?? null,
      sessionId: record?.sessionId ?? null,
      playerId: record?.playerId ?? null,
      email: maskEmail(record?.payload?.email),
      status, result, httpStatus, reason, attempts, at: now(),
    };
  }

  async function recoverProcessing() {
    let count = 0;
    // LMOVE e atomico por elemento: sem janela de duplicacao entre processing e queue.
    // LEFT->RIGHT preserva a ordem FIFO. Loop ate processing esvaziar.
    while ((await redis.lmove(PROCESSING, QUEUE, 'LEFT', 'RIGHT')) !== null) {
      count += 1;
    }
    if (count) log('warn', 'dispatch_recovered_orphans', { count });
  }

  async function deadLetter(raw, entry, record = null) {
    await redis.rpush(DEADLETTER, JSON.stringify(entry));
    await redis.lrem(PROCESSING, -1, raw);
    if (record) await redis.hdel(ATTEMPTS, record.jobId);
    state.lastErrorAt = now();
    state.inFlightJobId = null;
    await pushHistory(historyEntry(record, {
      status: 'deadletter', reason: entry.reason, httpStatus: entry.httpStatus, attempts: entry.attempts,
    }));
    await refreshCounts();
  }

  // Devolve ao fim da fila os reagendados que ja venceram. ZREM + RPUSH atomicos: o job
  // nunca fica fora das duas estruturas (at-least-once).
  async function promoteDueRetries() {
    const due = await redis.zrangebyscore(RETRY, '-inf', now());
    for (const raw of due) {
      await execMulti(redis.multi().zrem(RETRY, raw).rpush(QUEUE, raw));
    }
    if (due.length) log('info', 'dispatch_retry_due', { count: due.length });
  }

  // Com reagendados pendentes, o BLMOVE nao pode dormir alem da proxima tentativa.
  // Nunca 0: no Redis, timeout 0 bloqueia para sempre.
  async function blockTimeoutSec() {
    const [, score] = await redis.zrange(RETRY, 0, 0, 'WITHSCORES');
    if (score === undefined) return config.dispatchBlockTimeoutSec;
    const untilDue = (Number(score) - now()) / 1000;
    return Math.max(0.01, Math.min(config.dispatchBlockTimeoutSec, untilDue));
  }

  async function reschedule(raw, record, attempt, httpStatus) {
    const delay = Math.min(config.dispatchBackoffBaseMs * 2 ** (attempt - 1), config.dispatchBackoffMaxMs);
    const nextAttemptAt = now() + delay;
    await execMulti(redis.multi().zadd(RETRY, nextAttemptAt, raw).lrem(PROCESSING, -1, raw));
    state.lastErrorAt = now();
    state.inFlightJobId = null;
    await refreshCounts();
    log('warn', 'dispatch_retry', { jobId: record.jobId, attempt, delay, nextAttemptAt, httpStatus });
  }

  async function processOnce() {
    await promoteDueRetries();
    const raw = await redis.blmove(QUEUE, PROCESSING, 'LEFT', 'RIGHT', await blockTimeoutSec());
    state.lastPollAt = now();
    // null = fila vazia (timeout do BLMOVE). Uma string vazia E um item: precisa sair de
    // processing (senao vira zumbi recuperado para sempre no boot — F8 / NEU-82).
    if (raw === null || raw === undefined) { await refreshCounts(); return false; }

    let record = null;
    try { record = JSON.parse(raw); } catch { record = null; }
    if (!isValidRecord(record)) {
      await deadLetter(raw, deadLetterEntry({ raw, reason: 'malformed_record', now }));
      log('error', 'dispatch_dead_letter', { reason: 'malformed_record' });
      return true;
    }
    state.inFlightJobId = record.jobId;

    let body;
    try {
      body = toCanonicalBody(record);
    } catch (err) {
      await deadLetter(raw, deadLetterEntry({ raw, record, reason: 'mapping_failed', error: err?.message ?? String(err), now }), record);
      log('error', 'dispatch_dead_letter', { jobId: record.jobId, reason: 'mapping_failed' });
      return true;
    }

    // Uma tentativa por vez; o contador sobrevive aos reagendamentos (e a restart).
    const attempt = await redis.hincrby(ATTEMPTS, record.jobId, 1);
    let res = null;
    let threw = false;
    try {
      res = await postRace(fetchFn, config, body);
    } catch {
      threw = true;
    }

    if (!threw) {
      const cls = classifyStatus(res.status);
      if (cls === 'success') {
        const result = await safeJson(res);
        await redis.lrem(PROCESSING, -1, raw);
        await redis.hdel(ATTEMPTS, record.jobId);
        state.lastSuccessAt = now();
        state.inFlightJobId = null;
        await pushHistory(historyEntry(record, {
          status: 'sent', result: result?.status ?? null, httpStatus: res.status, attempts: attempt,
        }));
        await refreshCounts();
        log('info', 'dispatch_success', {
          jobId: record.jobId, playerId: record.playerId,
          httpStatus: res.status, result: result?.status ?? null, attempt,
        });
        return true;
      }
      if (cls === 'permanent') {
        const errBody = await safeJson(res);
        await deadLetter(raw, deadLetterEntry({
          raw, record, reason: 'permanent', httpStatus: res.status,
          errorCode: errBody?.error ?? null, attempts: attempt, now,
        }), record);
        log('error', res.status === 401 ? 'dispatch_auth_failed' : 'dispatch_dead_letter', {
          jobId: record.jobId, httpStatus: res.status, errorCode: errBody?.error ?? null,
        });
        return true;
      }
    }

    // transitorio (429/5xx/rede/timeout)
    const httpStatus = threw ? null : res.status;
    if (attempt >= config.dispatchMaxAttempts) {
      await deadLetter(raw, deadLetterEntry({
        raw, record, reason: 'exhausted', httpStatus, attempts: attempt, now,
      }), record);
      log('error', 'dispatch_dead_letter', { jobId: record.jobId, reason: 'exhausted', attempts: attempt });
      return true;
    }
    await reschedule(raw, record, attempt, httpStatus);
    return true;
  }

  async function start() {
    await recoverProcessing();
    running = true;
    while (running) {
      try {
        await processOnce();
      } catch (err) {
        log('error', 'dispatcher_loop_error', { message: err?.message ?? String(err) });
        await sleepFn(config.dispatchBackoffMaxMs);
      }
    }
  }

  function stop() { running = false; }

  // Snapshot imutavel do estado (copia) para o /health.
  function getState() {
    return { ...state, counts: { ...state.counts } };
  }

  return { start, stop, processOnce, recoverProcessing, getState };
}

module.exports = { createDispatcher, classifyStatus, maskEmail, HISTORY, HISTORY_MAX };
