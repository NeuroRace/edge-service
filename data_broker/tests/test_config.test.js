const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrokerConfig } = require('../config');

test('defaults do dispatcher quando env vazio', () => {
  const c = loadBrokerConfig({});
  assert.equal(c.apiUrl, null);
  assert.equal(c.edgeIngestToken, '');
  assert.equal(c.dispatchBackoffBaseMs, 500);
  assert.equal(c.dispatchBackoffMaxMs, 10000);
  assert.equal(c.dispatchMaxAttempts, 8);
  assert.equal(c.dispatchBlockTimeoutSec, 5);
  assert.equal(c.dispatchHttpTimeoutMs, 15000);
});

test('le config do dispatcher do env', () => {
  const c = loadBrokerConfig({
    API_URL: 'https://x/functions/v1/ingest-race',
    EDGE_INGEST_TOKEN: 'tok',
    DISPATCH_MAX_ATTEMPTS: '3',
    DISPATCH_HTTP_TIMEOUT_MS: '2000',
  });
  assert.equal(c.apiUrl, 'https://x/functions/v1/ingest-race');
  assert.equal(c.edgeIngestToken, 'tok');
  assert.equal(c.dispatchMaxAttempts, 3);
  assert.equal(c.dispatchHttpTimeoutMs, 2000);
});
