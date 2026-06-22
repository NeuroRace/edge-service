const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDispatcher } = require('../api_dispatcher');

const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : 'REDIS_URL nao definido';
const KEYS = ['dispatch:queue', 'dispatch:processing', 'dispatch:deadletter'];
const noSleep = async () => {};

function record() {
  return {
    jobId: 'int-1', playerId: 1, sessionId: 'sess-1', persistedAt: 1,
    payload: { email: 'h@x.com', playerUuid: null, startedAt: 1, finishedAt: 2,
      packets: [{ player: 1, attention: 70, meditation: 50, eegPower: { delta: 1 },
        poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 }] },
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function freshClient() {
  const Redis = require('ioredis');
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await client.del(...KEYS);
  return client;
}

test('integracao: 200 -> remove da fila, processing e deadletter vazias', { skip }, async () => {
  const redis = await freshClient();
  const received = [];
  const rec = record();
  const server = await startServer((req, res, body) => {
    received.push({ token: req.headers['x-edge-ingest-token'], body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'created' }));
  });
  const { port } = server.address();
  const config = {
    apiUrl: `http://127.0.0.1:${port}/ingest-race`, edgeIngestToken: 'tok',
    dispatchBackoffBaseMs: 1, dispatchBackoffMaxMs: 1, dispatchMaxAttempts: 3,
    dispatchBlockTimeoutSec: 1, dispatchHttpTimeoutMs: 1000,
  };
  try {
    await redis.rpush('dispatch:queue', JSON.stringify(rec));
    const d = createDispatcher(redis, config, () => {}, fetch, noSleep);
    assert.equal(await d.processOnce(), true);

    assert.equal(await redis.llen('dispatch:queue'), 0);
    assert.equal(await redis.llen('dispatch:processing'), 0);
    assert.equal(await redis.llen('dispatch:deadletter'), 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].token, 'tok');
    assert.equal(received[0].body.schema_version, '1.0');
    assert.equal(received[0].body.player_slot, 1);
    assert.equal(received[0].body.idempotency_key, rec.jobId);
    assert.equal(received[0].body.race_id, rec.sessionId);
  } finally {
    server.close();
    await redis.del(...KEYS);
    await redis.quit();
  }
});

test('integracao: 422 -> dead-letter, processing vazia', { skip }, async () => {
  const redis = await freshClient();
  const received = [];
  const server = await startServer((req, res) => {
    received.push({ token: req.headers['x-edge-ingest-token'] });
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'race_id_must_be_uuid' }));
  });
  const { port } = server.address();
  const config = {
    apiUrl: `http://127.0.0.1:${port}/ingest-race`, edgeIngestToken: 'tok',
    dispatchBackoffBaseMs: 1, dispatchBackoffMaxMs: 1, dispatchMaxAttempts: 3,
    dispatchBlockTimeoutSec: 1, dispatchHttpTimeoutMs: 1000,
  };
  try {
    await redis.rpush('dispatch:queue', JSON.stringify(record()));
    const d = createDispatcher(redis, config, () => {}, fetch, noSleep);
    await d.processOnce();
    assert.equal(await redis.llen('dispatch:deadletter'), 1);
    assert.equal(await redis.llen('dispatch:processing'), 0);
    assert.equal(received[0].token, 'tok');
  } finally {
    server.close();
    await redis.del(...KEYS);
    await redis.quit();
  }
});
