// data_broker/api_dispatcher.js
// Consome dispatch:queue e entrega cada resultado de corrida a Edge Function
// ingest-race (Supabase). Fila confiavel via BLMOVE -> dispatch:processing com
// recuperacao no boot; dead-letter para falhas permanentes/esgotadas; retry
// in-line com backoff e timeout HTTP. Ver spec §5.
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

function createDispatcher(
  redis,
  config,
  log,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let running = false;

  async function recoverProcessing() {
    const orphans = await redis.lrange(PROCESSING, 0, -1);
    for (const raw of orphans) {
      await redis.rpush(QUEUE, raw);
      await redis.lrem(PROCESSING, -1, raw);
    }
    if (orphans.length) log('warn', 'dispatch_recovered_orphans', { count: orphans.length });
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
      await deadLetter(raw, { raw, reason: 'malformed_record', failedAt: Date.now() });
      log('error', 'dispatch_dead_letter', { reason: 'malformed_record' });
      return true;
    }

    const body = toCanonicalBody(record);
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
          await deadLetter(raw, {
            record, reason: 'permanent', httpStatus: res.status,
            errorCode: errBody?.error ?? null, attempts: attempt, failedAt: Date.now(),
          });
          log('error', res.status === 401 ? 'dispatch_auth_failed' : 'dispatch_dead_letter', {
            jobId: record.jobId, httpStatus: res.status, errorCode: errBody?.error ?? null,
          });
          return true;
        }
      }

      // transitorio (429/5xx/rede/timeout)
      if (attempt >= config.dispatchMaxAttempts) {
        await deadLetter(raw, {
          record, reason: 'exhausted', httpStatus: threw ? null : res.status,
          attempts: attempt, failedAt: Date.now(),
        });
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
      }
    }
  }

  function stop() { running = false; }

  return { start, stop, processOnce, recoverProcessing };
}

module.exports = { createDispatcher, classifyStatus };
