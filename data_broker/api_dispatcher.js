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
  emitFn = () => {},
) {
  return {
    async start() {
      while (true) {
        try {
          const result = await redis.blpop('dispatch:queue', 0);
          if (!result) continue;
          const [, raw] = result;
          const job = JSON.parse(raw);
          await processJob(job, redis, config, log, fetchFn, sleepFn, emitFn);
        } catch (err) {
          log('error', 'dispatcher_loop_error', { message: err.message });
        }
      }
    },
    processJob: (job) => processJob(job, redis, config, log, fetchFn, sleepFn, emitFn),
  };
}

module.exports = { createDispatcher };
