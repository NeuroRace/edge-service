// data_broker/api_dispatcher.js
// Consome dispatch:queue e entrega cada resultado de corrida a Edge Function
// ingest-race (Supabase). Fila confiavel via BLMOVE -> dispatch:processing com
// recuperacao no boot; dead-letter para falhas permanentes/esgotadas/malformadas;
// retry in-line com backoff e timeout HTTP. Ver spec §5.
const { toCanonicalBody } = require('./dispatch_mapping');

const QUEUE = 'dispatch:queue';
const PROCESSING = 'dispatch:processing';
const DEADLETTER = 'dispatch:deadletter';
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
    counts: { queue: null, processing: null, deadletter: null },
  };

  async function refreshCounts() {
    try {
      state.counts = {
        queue: await redis.llen(QUEUE),
        processing: await redis.llen(PROCESSING),
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
    state.lastErrorAt = now();
    state.inFlightJobId = null;
    await pushHistory(historyEntry(record, {
      status: 'deadletter', reason: entry.reason, httpStatus: entry.httpStatus, attempts: entry.attempts,
    }));
    await refreshCounts();
  }

  async function processOnce() {
    const raw = await redis.blmove(QUEUE, PROCESSING, 'LEFT', 'RIGHT', config.dispatchBlockTimeoutSec);
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

    let attempt = 0;
    while (true) {
      attempt += 1;
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
      if (attempt >= config.dispatchMaxAttempts) {
        await deadLetter(raw, deadLetterEntry({
          raw, record, reason: 'exhausted', httpStatus: threw ? null : res.status,
          attempts: attempt, now,
        }), record);
        log('error', 'dispatch_dead_letter', { jobId: record.jobId, reason: 'exhausted', attempts: attempt });
        return true;
      }
      const delay = Math.min(config.dispatchBackoffBaseMs * 2 ** (attempt - 1), config.dispatchBackoffMaxMs);
      log('warn', 'dispatch_retry', { jobId: record.jobId, attempt, delay, httpStatus: threw ? null : res.status });
      await sleepFn(delay);
    }
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
