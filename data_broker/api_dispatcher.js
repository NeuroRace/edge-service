// data_broker/api_dispatcher.js

async function processJob(job, redis, config, log, fetchFn, sleepFn, emitFn) {
  if (Date.now() > job.expiresAt) {
    log('warn', 'job_expired', { jobId: job.jobId });
    emitFn('dispatchStatus', {
      jobId: job.jobId,
      playerId: job.playerId,
      playerEmail: job.payload.email,
      status: 'expired',
      attempts: job.attempts,
      timestamp: Date.now(),
    });
    return;
  }

  if (!config.apiUrl) {
    log('warn', 'api_url_not_configured', { jobId: job.jobId });
    return;
  }

  try {
    const res = await fetchFn(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
      },
      body: JSON.stringify(job.payload),
    });

    if (res.ok) {
      log('info', 'dispatch_success', {
        jobId: job.jobId,
        playerId: job.playerId,
        attempts: job.attempts,
      });
      emitFn('dispatchStatus', {
        jobId: job.jobId,
        playerId: job.playerId,
        playerEmail: job.payload.email,
        status: 'sent',
        attempts: job.attempts,
        timestamp: Date.now(),
      });
      return;
    }

    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const attempts = job.attempts + 1;
    const delay = Math.min(
      config.backoffBaseMs * Math.pow(2, attempts),
      config.backoffMaxMs,
    );
    await sleepFn(delay);
    await redis.rpush('dispatch:queue', JSON.stringify({ ...job, attempts }));
    emitFn('dispatchStatus', {
      jobId: job.jobId,
      playerId: job.playerId,
      playerEmail: job.payload.email,
      status: 'retry',
      attempts,
      timestamp: Date.now(),
    });
    log('warn', 'dispatch_retry', {
      jobId: job.jobId,
      attempts,
      delay,
    });
  }
}

function createDispatcher(
  redis,
  config,
  log,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // emitFn(event, payload) — must be synchronous (e.g. io.emit)
  emitFn = () => {},
) {
  async function processDequeue() {
    const result = await redis.blpop('dispatch:queue', 0);
    if (!result) return;
    const [, raw] = result;
    const job = JSON.parse(raw);
    const queueSize = await redis.llen('dispatch:queue');
    log('info', 'dispatcher_dequeued', { jobId: job.jobId, queue_size: queueSize });
    await processJob(job, redis, config, log, fetchFn, sleepFn, emitFn);
  }

  function startHealthMonitor(intervalMs) {
    if (!intervalMs || intervalMs <= 0) return () => {};
    const timer = setInterval(async () => {
      try {
        const size = await redis.llen('dispatch:queue');
        log('info', 'queue_health', { queue_size: size });
      } catch (err) {
        log('error', 'queue_health_error', { message: err.message });
      }
    }, intervalMs);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  return {
    async start() {
      while (true) {
        try {
          await processDequeue();
        } catch (err) {
          log('error', 'dispatcher_loop_error', { message: err.message });
        }
      }
    },
    processDequeue,
    startHealthMonitor,
    processJob: (job) => processJob(job, redis, config, log, fetchFn, sleepFn, emitFn),
  };
}

module.exports = { createDispatcher };
