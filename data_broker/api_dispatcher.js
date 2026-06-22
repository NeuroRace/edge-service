// data_broker/api_dispatcher.js
// Consome dispatch:queue e entrega cada resultado de corrida a Edge Function
// ingest-race (Supabase). Fila confiavel via BLMOVE -> dispatch:processing com
// recuperacao no boot; dead-letter para falhas permanentes/esgotadas/malformadas;
// retry in-line com backoff e timeout HTTP. Ver spec §5.
const { toCanonicalBody } = require('./dispatch_mapping');

const QUEUE = 'dispatch:queue';
const PROCESSING = 'dispatch:processing';
const DEADLETTER = 'dispatch:deadletter';

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
function deadLetterEntry({ raw = null, record = null, reason, httpStatus = null, errorCode = null, attempts = 1, error = null }) {
  return { reason, jobId: record?.jobId ?? null, httpStatus, errorCode, attempts, error, raw, failedAt: Date.now() };
}

function createDispatcher(
  redis,
  config,
  log,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let running = false;

  async function recoverProcessing() {
    let count = 0;
    // LMOVE e atomico por elemento: sem janela de duplicacao entre processing e queue.
    // LEFT->RIGHT preserva a ordem FIFO. Loop ate processing esvaziar.
    while ((await redis.lmove(PROCESSING, QUEUE, 'LEFT', 'RIGHT')) !== null) {
      count += 1;
    }
    if (count) log('warn', 'dispatch_recovered_orphans', { count });
  }

  async function deadLetter(raw, entry) {
    await redis.rpush(DEADLETTER, JSON.stringify(entry));
    await redis.lrem(PROCESSING, -1, raw);
  }

  async function processOnce() {
    const raw = await redis.blmove(QUEUE, PROCESSING, 'LEFT', 'RIGHT', config.dispatchBlockTimeoutSec);
    if (!raw) return false;

    let record = null;
    try { record = JSON.parse(raw); } catch { record = null; }
    if (!isValidRecord(record)) {
      await deadLetter(raw, deadLetterEntry({ raw, reason: 'malformed_record' }));
      log('error', 'dispatch_dead_letter', { reason: 'malformed_record' });
      return true;
    }

    let body;
    try {
      body = toCanonicalBody(record);
    } catch (err) {
      await deadLetter(raw, deadLetterEntry({ record, reason: 'mapping_failed', error: err?.message ?? String(err) }));
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
          log('info', 'dispatch_success', {
            jobId: record.jobId, playerId: record.playerId,
            httpStatus: res.status, result: result?.status ?? null, attempt,
          });
          return true;
        }
        if (cls === 'permanent') {
          const errBody = await safeJson(res);
          await deadLetter(raw, deadLetterEntry({
            record, reason: 'permanent', httpStatus: res.status,
            errorCode: errBody?.error ?? null, attempts: attempt,
          }));
          log('error', res.status === 401 ? 'dispatch_auth_failed' : 'dispatch_dead_letter', {
            jobId: record.jobId, httpStatus: res.status, errorCode: errBody?.error ?? null,
          });
          return true;
        }
      }

      // transitorio (429/5xx/rede/timeout)
      if (attempt >= config.dispatchMaxAttempts) {
        await deadLetter(raw, deadLetterEntry({
          record, reason: 'exhausted', httpStatus: threw ? null : res.status,
          attempts: attempt,
        }));
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

  return { start, stop, processOnce, recoverProcessing };
}

module.exports = { createDispatcher, classifyStatus };
