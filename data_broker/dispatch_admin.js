// data_broker/dispatch_admin.js
// Painel de operacao (NEU-143): resumo da fila de envio a nuvem e reenvio das corridas
// da dead-letter. Le o Redis direto, entao funciona com o dispatcher desligado.
// Sem apagar e sem limpar fila: uma corrida que falhou fica guardada ate ser reenviada.
const { maskEmail } = require('./api_dispatcher');
const { execMulti } = require('./session_manager');

const QUEUE = 'dispatch:queue';
const PROCESSING = 'dispatch:processing';
const DEADLETTER = 'dispatch:deadletter';
const HISTORY = 'dispatch:history';
// So existem com a NEU-92 (reagendamento fora da fila). Ausentes: contam 0 / HDEL sem efeito.
const RETRY = 'dispatch:retry';
const ATTEMPTS = 'dispatch:attempts';

const FAILED_LIST_MAX = 50;

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// `raw` e o registro original da fila; sem ele (ou corrompido) a corrida nao volta.
function isRetryable(entry) {
  if (!entry || typeof entry.raw !== 'string' || entry.reason === 'malformed_record') return false;
  const rec = parseJson(entry.raw);
  return !!(rec && typeof rec.jobId === 'string');
}

// Resumo para a tela: nunca o e-mail completo nem o registro bruto (pacotes de EEG).
function summarize(text) {
  const entry = parseJson(text);
  if (!entry || typeof entry !== 'object') {
    return { jobId: null, sessionId: null, playerId: null, email: null, failedAt: null, reason: 'malformed_entry', httpStatus: null, errorCode: null, attempts: null, error: null, retryable: false };
  }
  const rec = typeof entry.raw === 'string' ? parseJson(entry.raw) : null;
  return {
    jobId: entry.jobId ?? rec?.jobId ?? null,
    sessionId: rec?.sessionId ?? null,
    playerId: rec?.playerId ?? null,
    email: maskEmail(rec?.payload?.email),
    failedAt: entry.failedAt ?? null,
    reason: entry.reason ?? null,
    httpStatus: entry.httpStatus ?? null,
    errorCode: entry.errorCode ?? null,
    attempts: entry.attempts ?? null,
    error: entry.error ?? null,
    retryable: isRetryable(entry),
  };
}

function createDispatchAdmin(redis, log) {
  // Reenvios em serie: o segundo clique so roda depois do primeiro e ja nao acha a entrada.
  let chain = Promise.resolve();

  async function overview() {
    const [queue, processing, deadletter, retrying, history, failedTail] = await Promise.all([
      redis.llen(QUEUE),
      redis.llen(PROCESSING),
      redis.llen(DEADLETTER),
      typeof redis.zcard === 'function' ? redis.zcard(RETRY) : 0,
      redis.lrange(HISTORY, 0, -1),
      redis.lrange(DEADLETTER, -FAILED_LIST_MAX, -1),
    ]);
    const lastSent = history.map(parseJson).find((h) => h && h.status === 'sent');
    return {
      counts: { waiting: queue + retrying, retrying, sending: processing, failed: deadletter },
      lastSentAt: lastSent ? lastSent.at ?? null : null,
      failed: failedTail.map(summarize).reverse(),
    };
  }

  async function doRequeue(jobId) {
    const items = await redis.lrange(DEADLETTER, 0, -1);
    const text = items.find((t) => parseJson(t)?.jobId === jobId);
    if (text === undefined) return { ok: false, error: 'not_found' };
    const entry = parseJson(text);
    if (!isRetryable(entry)) return { ok: false, error: 'not_retryable' };
    await execMulti(redis.multi().lrem(DEADLETTER, 1, text).rpush(QUEUE, entry.raw).hdel(ATTEMPTS, jobId));
    log('info', 'dispatch_requeued', { jobId, reason: entry.reason, attempts: entry.attempts ?? null });
    return { ok: true, jobId };
  }

  function requeue(jobId) {
    const run = chain.then(() => doRequeue(jobId));
    chain = run.catch(() => {});
    return run;
  }

  return { overview, requeue };
}

module.exports = { createDispatchAdmin };
