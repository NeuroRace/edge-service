# Dispatcher de resultados de corrida (NEU-7) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consumir a fila Redis `dispatch:queue` (já produzida pelo `session_manager`) e entregar cada resultado de corrida à Edge Function `ingest-race` do Supabase, de forma confiável, idempotente e sem regressões.

**Architecture:** Módulos novos e **aditivos** — um mapeador puro (`dispatch_mapping.js`), o dispatcher (`api_dispatcher.js`) com fila confiável (`BLMOVE` para `dispatch:processing` + recuperação no boot), dead-letter e retry in-line com timeout HTTP. Wiring opt-in em `index.js`: o dispatcher só roda se `API_URL` estiver setado; caso contrário os jobs acumulam na fila durável (comportamento atual preservado).

**Tech Stack:** Node.js 22 (CommonJS), `ioredis`, `fetch` global + `AbortController`, `node:test`, Redis 7, Docker Compose.

Spec: `docs/superpowers/specs/2026-06-22-edge-dispatcher-design.md`.

## Global Constraints

- **Branch:** todo o trabalho em `feature/neu-7-dispatcher` (já criada, contém o spec).
- **Aditivo / não-regressão:** NÃO modificar `session_manager.js`, `socket_handlers.js`, `http_server.js`, `runtime_state.js`, `event_contracts.js`. Mudanças só em `config.js`, `redis_client.js`, `index.js`, `.env.example`, `docker-compose.yml`, `.gitignore` + arquivos novos.
- **Auth:** header `x-edge-ingest-token: <EDGE_INGEST_TOKEN>` APENAS. NUNCA enviar `apikey` nem `Authorization` (a função roda `verify_jwt=false`).
- **Body canônico:** snake_case exatamente como spec §3 (`schema_version:"1.0"`, `idempotency_key`, `race_id`, `player_slot`, `player_email`, `player_uuid`, `source:"real"`, `started_at`, `finished_at`, `telemetry_points[]{t,attention,meditation,poor_signal_level,signal_status,eeg_power}`).
- **Classificação de status:** `2xx`=sucesso; `429`/`5xx`/timeout/rede=transitório (retry); demais `4xx`=permanente (dead-letter). Spec §5.2.
- **Chaves Redis:** `dispatch:queue` (existe), `dispatch:processing` (nova), `dispatch:deadletter` (nova).
- **Módulos:** CommonJS (`require`/`module.exports`). Testes descobertos por `node --test` (arquivos `*.test.js`).
- **TDD + commits frequentes.** Toda mensagem de commit termina com o trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Rodar tudo de dentro de `data_broker/`** (`cd data_broker` antes de `npm`/`node --test`).

---

### Task 1: Config — chaves do dispatcher

**Files:**
- Modify: `data_broker/config.js`
- Test: `data_broker/tests/test_config.test.js` (novo)

**Interfaces:**
- Consumes: `loadBrokerConfig(env)` existente.
- Produces: `loadBrokerConfig(env)` passa a retornar `apiUrl` (string|null), `edgeIngestToken` (string), `dispatchBackoffBaseMs` (number), `dispatchBackoffMaxMs` (number), `dispatchMaxAttempts` (number), `dispatchBlockTimeoutSec` (number), `dispatchHttpTimeoutMs` (number).

- [ ] **Step 1: Escrever o teste que falha**

Criar `data_broker/tests/test_config.test.js`:

```js
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
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd data_broker && node --test tests/test_config.test.js`
Expected: FAIL (`apiUrl` undefined ≠ null).

- [ ] **Step 3: Implementar**

Em `data_broker/config.js`, dentro do objeto retornado por `loadBrokerConfig`, após `redisUrl`:

```js
    redisUrl: env.REDIS_URL || 'redis://redis:6379',
    apiUrl: env.API_URL || null,
    edgeIngestToken: env.EDGE_INGEST_TOKEN || '',
    dispatchBackoffBaseMs: Number(env.DISPATCH_BACKOFF_BASE_MS || 500),
    dispatchBackoffMaxMs: Number(env.DISPATCH_BACKOFF_MAX_MS || 10000),
    dispatchMaxAttempts: Number(env.DISPATCH_MAX_ATTEMPTS || 8),
    dispatchBlockTimeoutSec: Number(env.DISPATCH_BLOCK_TIMEOUT_SEC || 5),
    dispatchHttpTimeoutMs: Number(env.DISPATCH_HTTP_TIMEOUT_MS || 15000),
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd data_broker && node --test tests/test_config.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add data_broker/config.js data_broker/tests/test_config.test.js
git commit -m "feat(neu-7): config do dispatcher (API_URL, token, retry, timeout)"
```

---

### Task 2: Mapping — `toCanonicalBody` (função pura)

**Files:**
- Create: `data_broker/dispatch_mapping.js`
- Test: `data_broker/tests/test_dispatch_mapping.test.js`

**Interfaces:**
- Consumes: nada (puro).
- Produces: `toCanonicalBody(record)` → objeto body canônico (spec §3). Constantes `schema_version:"1.0"`, `source:"real"`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `data_broker/tests/test_dispatch_mapping.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { toCanonicalBody } = require('../dispatch_mapping');

function record() {
  return {
    jobId: '11111111-1111-1111-1111-111111111111',
    playerId: 1,
    sessionId: '22222222-2222-2222-2222-222222222222',
    persistedAt: 1000,
    payload: {
      email: 'human@x.com',
      playerUuid: null,
      startedAt: 1000,
      finishedAt: 2000,
      packets: [
        { player: 1, attention: 70, meditation: 50, eegPower: { delta: 1 },
          poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1500 },
        { player: 1, attention: 80, meditation: 55, eegPower: { theta: 2 },
          poorSignalLevel: null, status: 'poor', source: 'real', timeStamp: 1600 },
      ],
    },
  };
}

test('mapeia envelope camelCase -> snake_case canonico', () => {
  const b = toCanonicalBody(record());
  assert.equal(b.schema_version, '1.0');
  assert.equal(b.idempotency_key, '11111111-1111-1111-1111-111111111111');
  assert.equal(b.race_id, '22222222-2222-2222-2222-222222222222');
  assert.equal(b.player_slot, 1);
  assert.equal(b.player_email, 'human@x.com');
  assert.equal(b.player_uuid, null);
  assert.equal(b.source, 'real');
  assert.equal(b.started_at, 1000);
  assert.equal(b.finished_at, 2000);
  assert.equal(b.telemetry_points.length, 2);
});

test('mapeia cada ponto e descarta player/source do pacote', () => {
  const b = toCanonicalBody(record());
  const p0 = b.telemetry_points[0];
  assert.deepEqual(p0, {
    t: 1500, attention: 70, meditation: 50,
    poor_signal_level: 0, signal_status: 'ok', eeg_power: { delta: 1 },
  });
  assert.equal('player' in p0, false);
  assert.equal('source' in p0, false);
  assert.equal(b.telemetry_points[1].poor_signal_level, null);
  assert.equal(b.telemetry_points[1].signal_status, 'poor');
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd data_broker && node --test tests/test_dispatch_mapping.test.js`
Expected: FAIL (`Cannot find module '../dispatch_mapping'`).

- [ ] **Step 3: Implementar**

Criar `data_broker/dispatch_mapping.js`:

```js
// data_broker/dispatch_mapping.js
// Funcao pura: traduz o registro interno (camelCase) produzido pelo
// session_manager para o body canonico (snake_case) da Edge Function ingest-race.
// Ver docs/cloud-sync-contract.md §6 e o spec do dispatcher §3.

const SCHEMA_VERSION = '1.0';

function toCanonicalBody(record) {
  const { payload } = record;
  return {
    schema_version: SCHEMA_VERSION,
    idempotency_key: record.jobId,
    race_id: record.sessionId,
    player_slot: record.playerId,
    player_email: payload.email,
    player_uuid: payload.playerUuid ?? null,
    source: 'real',
    started_at: payload.startedAt,
    finished_at: payload.finishedAt,
    telemetry_points: payload.packets.map((p) => ({
      t: p.timeStamp,
      attention: p.attention,
      meditation: p.meditation,
      poor_signal_level: p.poorSignalLevel ?? null,
      signal_status: p.status,
      eeg_power: p.eegPower,
    })),
  };
}

module.exports = { toCanonicalBody, SCHEMA_VERSION };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd data_broker && node --test tests/test_dispatch_mapping.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add data_broker/dispatch_mapping.js data_broker/tests/test_dispatch_mapping.test.js
git commit -m "feat(neu-7): mapping puro record->body canonico"
```

---

### Task 3: FakeRedis — operações de lista (`lmove`/`blmove`/`lrem`/`lpush`)

**Files:**
- Modify: `data_broker/tests/fake_redis.js`
- Test: `data_broker/tests/test_fake_redis.test.js` (novo)

**Interfaces:**
- Consumes: classe `FakeRedis` existente (tem `rpush`/`lrange`/`llen`/`del`).
- Produces: `FakeRedis` ganha `lmove(src,dst,srcDir,dstDir)`, `blmove(src,dst,srcDir,dstDir,timeoutSec)` (não-bloqueante no fake: retorna `null` se vazio), `lrem(key,count,value)`, `lpush(key,...values)`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `data_broker/tests/test_fake_redis.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');

test('lmove move da esquerda da origem para a direita do destino', async () => {
  const r = new FakeRedis();
  await r.rpush('q', 'a', 'b');
  const moved = await r.lmove('q', 'p', 'LEFT', 'RIGHT');
  assert.equal(moved, 'a');
  assert.deepEqual(await r.lrange('q', 0, -1), ['b']);
  assert.deepEqual(await r.lrange('p', 0, -1), ['a']);
});

test('blmove retorna null quando a origem esta vazia', async () => {
  const r = new FakeRedis();
  assert.equal(await r.blmove('q', 'p', 'LEFT', 'RIGHT', 1), null);
});

test('lrem com count negativo remove a partir da cauda', async () => {
  const r = new FakeRedis();
  await r.rpush('p', 'x', 'y', 'x');
  assert.equal(await r.lrem('p', -1, 'x'), 1);
  assert.deepEqual(await r.lrange('p', 0, -1), ['x', 'y']);
});

test('lpush insere no inicio', async () => {
  const r = new FakeRedis();
  await r.rpush('q', 'b');
  await r.lpush('q', 'a');
  assert.deepEqual(await r.lrange('q', 0, -1), ['a', 'b']);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd data_broker && node --test tests/test_fake_redis.test.js`
Expected: FAIL (`r.lmove is not a function`).

- [ ] **Step 3: Implementar**

Em `data_broker/tests/fake_redis.js`, adicionar estes métodos dentro da classe `FakeRedis` (ex.: logo após `llen`):

```js
  async lpush(key, ...values) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    const list = this.lists.get(key);
    for (const v of values) list.unshift(String(v));
    return list.length;
  }

  async lmove(source, dest, srcDir, destDir) {
    const src = this.lists.get(source) || [];
    if (src.length === 0) return null;
    const val = srcDir === 'LEFT' ? src.shift() : src.pop();
    if (!this.lists.has(dest)) this.lists.set(dest, []);
    const d = this.lists.get(dest);
    if (destDir === 'LEFT') d.unshift(val);
    else d.push(val);
    return val;
  }

  // Fake nao bloqueia: retorna imediatamente (null se vazio). Os testes
  // pre-populam a fila, entao o comportamento bloqueante real e irrelevante aqui.
  async blmove(source, dest, srcDir, destDir, _timeoutSec) {
    return this.lmove(source, dest, srcDir, destDir);
  }

  async lrem(key, count, value) {
    const list = this.lists.get(key);
    if (!list) return 0;
    const v = String(value);
    let removed = 0;
    if (count < 0) {
      for (let i = list.length - 1; i >= 0 && removed < -count; i -= 1) {
        if (list[i] === v) { list.splice(i, 1); removed += 1; }
      }
    } else {
      const limit = count === 0 ? Infinity : count;
      for (let i = 0; i < list.length && removed < limit;) {
        if (list[i] === v) { list.splice(i, 1); removed += 1; }
        else i += 1;
      }
    }
    return removed;
  }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd data_broker && node --test tests/test_fake_redis.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add data_broker/tests/fake_redis.js data_broker/tests/test_fake_redis.test.js
git commit -m "test(neu-7): FakeRedis ganha lmove/blmove/lrem/lpush"
```

---

### Task 4: Conexão Redis bloqueante dedicada

**Files:**
- Modify: `data_broker/redis_client.js`
- Test: `data_broker/tests/test_redis_client.test.js` (existente — adicionar casos)

**Interfaces:**
- Consumes: `createRedisClient(config, log, RedisClient)` existente.
- Produces: `createBlockingRedisClient(config, log, RedisClient=Redis)` → cliente com `maxRetriesPerRequest: null` (para comandos bloqueantes, spec §4.1).

- [ ] **Step 1: Escrever o teste que falha**

O arquivo `data_broker/tests/test_redis_client.test.js` **já existe** (requires no topo + `FakeRedisClient` que hoje captura só `url`). Fazer 3 edições cirúrgicas:

(a) Na linha 5, adicionar `createBlockingRedisClient` ao destructure existente:
```js
const { createRedisClient, createBlockingRedisClient } = require('../redis_client');
```

(b) No construtor de `FakeRedisClient`, capturar também `opts` (inofensivo ao teste existente, que só checa `url`):
```js
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
  }
```

(c) Adicionar este `test(...)` ao final do arquivo (NÃO repetir os `require`):
```js
test('createBlockingRedisClient usa maxRetriesPerRequest null', () => {
  const client = createBlockingRedisClient(
    { redisUrl: 'redis://example:6379' }, () => {}, FakeRedisClient,
  );
  assert.equal(client.url, 'redis://example:6379');
  assert.equal(client.opts.maxRetriesPerRequest, null);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd data_broker && node --test tests/test_redis_client.test.js`
Expected: FAIL (`createBlockingRedisClient is not a function`).

- [ ] **Step 3: Implementar**

Em `data_broker/redis_client.js`, adicionar a função e exportá-la:

```js
// Conexao DEDICADA para comandos bloqueantes (BLMOVE). maxRetriesPerRequest:null
// e a recomendacao do ioredis para comandos bloqueantes; e uma 2a conexao para
// nao serializar atras dos comandos do session_manager (spec §4.1).
function createBlockingRedisClient(config, log = () => {}, RedisClient = Redis) {
  const client = new RedisClient(config.redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
  });
  client.on('connect', () => log('info', 'redis_blocking_connected', {}));
  client.on('error', (err) => log('error', 'redis_blocking_error', { message: err.message }));
  client.on('close', () => log('warn', 'redis_blocking_closed', {}));
  return client;
}

module.exports = { createRedisClient, createBlockingRedisClient };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd data_broker && node --test tests/test_redis_client.test.js`
Expected: PASS (todos, incluindo o novo).

- [ ] **Step 5: Commit**

```bash
git add data_broker/redis_client.js data_broker/tests/test_redis_client.test.js
git commit -m "feat(neu-7): conexao Redis bloqueante dedicada (maxRetriesPerRequest null)"
```

---

### Task 5: Dispatcher — entrega confiável (módulo completo)

Unidade coesa: a máquina de estados de entrega (sucesso/permanente/transitório/esgotado/malformado) + recuperação de órfãos. Um único gate de review.

**Files:**
- Create: `data_broker/api_dispatcher.js`
- Test: `data_broker/tests/test_api_dispatcher.test.js`

**Interfaces:**
- Consumes: `toCanonicalBody` (Task 2); `redis` com `blmove/lrange/rpush/lrem` (Task 3 no fake, ioredis no real); `config` (Task 1); `log(level,msg,meta)`.
- Produces: `createDispatcher(redis, config, log, fetchFn=fetch, sleepFn=realSleep)` → `{ start, stop, processOnce, recoverProcessing }`. `processOnce()` processa **um** job (retorna `true` se processou, `false` se `blmove` deu timeout). `recoverProcessing()` move órfãos de `dispatch:processing` de volta para `dispatch:queue`. Também exporta `classifyStatus(status)` → `'success'|'transient'|'permanent'`.

- [ ] **Step 1: Escrever os testes que falham**

Criar `data_broker/tests/test_api_dispatcher.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createDispatcher, classifyStatus } = require('../api_dispatcher');

const QUEUE = 'dispatch:queue';
const PROCESSING = 'dispatch:processing';
const DEADLETTER = 'dispatch:deadletter';

const CONFIG = {
  apiUrl: 'http://api.test/ingest-race',
  edgeIngestToken: 'tok',
  dispatchBackoffBaseMs: 1,
  dispatchBackoffMaxMs: 1,
  dispatchMaxAttempts: 3,
  dispatchBlockTimeoutSec: 1,
  dispatchHttpTimeoutMs: 1000,
};

const noSleep = async () => {};

function record(overrides = {}) {
  return {
    jobId: 'j-1', playerId: 1, sessionId: 's-1', persistedAt: 1,
    payload: {
      email: 'h@x.com', playerUuid: null, startedAt: 1, finishedAt: 2,
      packets: [{ player: 1, attention: 70, meditation: 50, eegPower: { delta: 1 },
        poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 }],
    },
    ...overrides,
  };
}

function fetchSeq(steps) {
  let i = 0;
  const calls = [];
  async function fn(url, opts) {
    calls.push({ url, opts });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step.throw) throw new Error('network');
    return { status: step.status, json: async () => step.body ?? {} };
  }
  fn.calls = calls;
  return fn;
}

async function seedQueue(redis, rec) {
  await redis.rpush(QUEUE, JSON.stringify(rec));
}

test('classifyStatus: 2xx sucesso, 429/5xx transitorio, 4xx permanente', () => {
  assert.equal(classifyStatus(200), 'success');
  assert.equal(classifyStatus(201), 'success');
  assert.equal(classifyStatus(429), 'transient');
  assert.equal(classifyStatus(500), 'transient');
  assert.equal(classifyStatus(503), 'transient');
  assert.equal(classifyStatus(422), 'permanent');
  assert.equal(classifyStatus(401), 'permanent');
});

test('200 created: remove de processing, fila/deadletter vazias, envia token', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 200, body: { status: 'created' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  assert.equal(await d.processOnce(), true);
  assert.equal(await redis.llen(QUEUE), 0);
  assert.equal(await redis.llen(PROCESSING), 0);
  assert.equal(await redis.llen(DEADLETTER), 0);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].opts.headers['x-edge-ingest-token'], 'tok');
  assert.equal(fetchFn.calls[0].opts.headers.apikey, undefined);
  assert.equal(fetchFn.calls[0].opts.headers.Authorization, undefined);
});

test('200 duplicate tratado como sucesso', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 200, body: { status: 'duplicate' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);
  assert.equal(await d.processOnce(), true);
  assert.equal(await redis.llen(DEADLETTER), 0);
});

test('422 permanente: dead-letter com errorCode, sem retry', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 422, body: { error: 'race_id_must_be_uuid' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  await d.processOnce();
  assert.equal(fetchFn.calls.length, 1); // nao retentou
  assert.equal(await redis.llen(PROCESSING), 0);
  const dl = JSON.parse((await redis.lrange(DEADLETTER, 0, -1))[0]);
  assert.equal(dl.reason, 'permanent');
  assert.equal(dl.httpStatus, 422);
  assert.equal(dl.errorCode, 'race_id_must_be_uuid');
});

test('401 permanente: dead-letter + log dispatch_auth_failed', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const logs = [];
  const log = (level, message, meta) => logs.push({ level, message, meta });
  const fetchFn = fetchSeq([{ status: 401, body: { error: 'unauthorized' } }]);
  const d = createDispatcher(redis, CONFIG, log, fetchFn, noSleep);

  await d.processOnce();
  assert.equal(await redis.llen(DEADLETTER), 1);
  assert.ok(logs.some((l) => l.message === 'dispatch_auth_failed'));
});

test('500 depois 200: retenta e sucede', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 500, body: {} }, { status: 200, body: { status: 'created' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  assert.equal(await d.processOnce(), true);
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(await redis.llen(DEADLETTER), 0);
  assert.equal(await redis.llen(PROCESSING), 0);
});

test('500 sempre: esgota maxAttempts -> dead-letter exhausted', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ status: 500, body: {} }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  await d.processOnce();
  assert.equal(fetchFn.calls.length, 3); // == dispatchMaxAttempts
  const dl = JSON.parse((await redis.lrange(DEADLETTER, 0, -1))[0]);
  assert.equal(dl.reason, 'exhausted');
  assert.equal(dl.attempts, 3);
  assert.equal(await redis.llen(PROCESSING), 0);
});

test('erro de rede depois 200: retenta e sucede', async () => {
  const redis = new FakeRedis();
  await seedQueue(redis, record());
  const fetchFn = fetchSeq([{ throw: true }, { status: 200, body: { status: 'created' } }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);
  assert.equal(await d.processOnce(), true);
  assert.equal(fetchFn.calls.length, 2);
});

test('registro malformado -> dead-letter malformed_record, sem POST', async () => {
  const redis = new FakeRedis();
  await redis.rpush(QUEUE, 'isto-nao-e-json');
  const fetchFn = fetchSeq([{ status: 200, body: {} }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);

  await d.processOnce();
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(await redis.llen(PROCESSING), 0);
  const dl = JSON.parse((await redis.lrange(DEADLETTER, 0, -1))[0]);
  assert.equal(dl.reason, 'malformed_record');
});

test('processOnce com fila vazia retorna false sem efeitos', async () => {
  const redis = new FakeRedis();
  const fetchFn = fetchSeq([{ status: 200, body: {} }]);
  const d = createDispatcher(redis, CONFIG, () => {}, fetchFn, noSleep);
  assert.equal(await d.processOnce(), false);
  assert.equal(fetchFn.calls.length, 0);
});

test('recoverProcessing move orfaos de processing de volta para a fila', async () => {
  const redis = new FakeRedis();
  await redis.rpush(PROCESSING, JSON.stringify(record()));
  const d = createDispatcher(redis, CONFIG, () => {}, fetchSeq([]), noSleep);

  await d.recoverProcessing();
  assert.equal(await redis.llen(PROCESSING), 0);
  assert.equal(await redis.llen(QUEUE), 1);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd data_broker && node --test tests/test_api_dispatcher.test.js`
Expected: FAIL (`Cannot find module '../api_dispatcher'`).

- [ ] **Step 3: Implementar**

Criar `data_broker/api_dispatcher.js`:

```js
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
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd data_broker && node --test tests/test_api_dispatcher.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Rodar a suíte inteira (não-regressão)**

Run: `cd data_broker && npm run validate`
Expected: `node --check index.js` ok + todos os testes passam (os de sessão/socket/http intactos).

- [ ] **Step 6: Commit**

```bash
git add data_broker/api_dispatcher.js data_broker/tests/test_api_dispatcher.test.js
git commit -m "feat(neu-7): dispatcher confiavel (BLMOVE+processing, dead-letter, retry, timeout)"
```

---

### Task 6: Wiring — `index.js`, `.env.example`, `docker-compose`, `.gitignore`

**Files:**
- Modify: `data_broker/index.js`
- Modify: `data_broker/.env.example`
- Modify: `docker-compose.yml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `createBlockingRedisClient` (Task 4), `createDispatcher` (Task 5), `loadBrokerConfig` (Task 1). Mantém intactas as chamadas `createHttpServer(() => runtimeState.snapshot(), session, log)` e `registerSocketHandlers(io, log, runtimeState, session)`.
- Produces: o broker, se `config.apiUrl` setado, sobe o dispatcher numa 2ª conexão; senão loga `dispatcher_disabled` e os jobs acumulam.

- [ ] **Step 1: Modificar `index.js`**

Em `data_broker/index.js`: trocar o `require` do redis_client e adicionar os do dispatcher; inserir o wiring **após** `registerSocketHandlers(...)` e **antes** de `server.listen(...)`. Resultado final do arquivo:

```js
const { loadBrokerConfig } = require('./config');
const { createHttpServer } = require('./http_server');
const { createBrokerLogger } = require('./logger');
const { createRuntimeState } = require('./runtime_state');
const { createRedisClient, createBlockingRedisClient } = require('./redis_client');
const { createSessionManager } = require('./session_manager');
const { createSocketServer, registerSocketHandlers } = require('./socket_handlers');
const { createDispatcher } = require('./api_dispatcher');

const config = loadBrokerConfig();
const log = createBrokerLogger();
const runtimeState = createRuntimeState();
const redis = createRedisClient(config, log);
const session = createSessionManager(redis, config, log);
const server = createHttpServer(() => runtimeState.snapshot(), session, log);
const io = createSocketServer(server, config.allowedOrigins);

registerSocketHandlers(io, log, runtimeState, session);

// Dispatcher (Stage 3 / NEU-7): opt-in via API_URL. Sem API_URL, os jobs
// acumulam duravelmente em dispatch:queue (comportamento atual preservado).
if (config.apiUrl) {
  if (!config.edgeIngestToken) {
    log('error', 'dispatch_token_missing', { hint: 'EDGE_INGEST_TOKEN vazio com API_URL setado' });
  }
  const redisBlocking = createBlockingRedisClient(config, log);
  const dispatcher = createDispatcher(redisBlocking, config, log);
  dispatcher.start().catch((err) =>
    log('error', 'dispatcher_fatal', { message: err?.message ?? String(err) }),
  );
} else {
  log('warn', 'dispatcher_disabled', { reason: 'API_URL nao definido' });
}

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `cd data_broker && node --check index.js`
Expected: sem saída (ok).

- [ ] **Step 3: Smoke manual — dispatcher desabilitado sem API_URL**

Run (sem API_URL, só checa o log de boot e que não quebra):
```bash
cd data_broker && timeout 2 node -e "delete process.env.API_URL; require('./index.js')" 2>&1 | grep -m1 dispatcher_disabled || echo "FALHA: nao logou dispatcher_disabled"
```
Expected: uma linha JSON com `"message":"dispatcher_disabled"`. (O processo tentará conectar no Redis default e o `timeout` o encerra após 2s — ok; só queremos o log de boot, que é emitido antes do `listen`.)

- [ ] **Step 4: Atualizar `.env.example`**

Substituir o bloco final comentado de `data_broker/.env.example` (as linhas `# --- Dispatch ...` em diante) por:

```bash
# --- Dispatch para a Cloud (Stage 3 / NEU-7) ---
# Setar API_URL HABILITA o dispatcher. Vazio = dispatcher desligado (jobs
# acumulam em dispatch:queue). Ver docs/cloud-sync-contract.md.
# API_URL=https://wtaulbdkgrnrtbfezaxw.supabase.co/functions/v1/ingest-race
# EDGE_INGEST_TOKEN=<peca ao Pedro / cloud-backend/.secret.prod.env>
# DISPATCH_MAX_ATTEMPTS=8
# DISPATCH_BACKOFF_BASE_MS=500
# DISPATCH_BACKOFF_MAX_MS=10000
# DISPATCH_BLOCK_TIMEOUT_SEC=5
# DISPATCH_HTTP_TIMEOUT_MS=15000
```

- [ ] **Step 5: Atualizar `docker-compose.yml`**

No serviço `broker`, em `environment:`, adicionar (após `REDIS_URL`):

```yaml
      API_URL: ${API_URL:-}
      EDGE_INGEST_TOKEN: ${EDGE_INGEST_TOKEN:-}
```

- [ ] **Step 6: Fechar o gap de segurança do `.env` raiz**

Em `.gitignore` (raiz do edge-service), adicionar abaixo da seção de secrets locais:

```
# Secrets do compose na raiz (interpolacao ${API_URL}/${EDGE_INGEST_TOKEN})
/.env
```

- [ ] **Step 7: Validar compose + suíte**

Run:
```bash
cd /Users/pedrotavares/Projetos/NeuroRace/services/edge-service && docker compose config >/dev/null && echo "compose ok"
cd data_broker && npm run validate
```
Expected: `compose ok` + suíte verde.

- [ ] **Step 8: Commit**

```bash
git add data_broker/index.js data_broker/.env.example docker-compose.yml .gitignore
git commit -m "feat(neu-7): wire dispatcher opt-in (API_URL) + compose env + gitignore /.env"
```

---

### Task 7: Teste de integração (Redis real + servidor HTTP mock)

**Files:**
- Test: `data_broker/tests/test_dispatcher_integration.test.js` (novo, gated em `REDIS_URL`)

**Interfaces:**
- Consumes: `createDispatcher` (Task 5), ioredis real, `node:http`.
- Produces: prova o caminho completo (BLMOVE real + sucesso + dead-letter + recuperação) contra Redis real, no padrão dos testes de integração existentes.

- [ ] **Step 1: Escrever o teste**

Criar `data_broker/tests/test_dispatcher_integration.test.js`:

```js
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
    await redis.rpush('dispatch:queue', JSON.stringify(record()));
    const d = createDispatcher(redis, config, () => {}, fetch, noSleep);
    assert.equal(await d.processOnce(), true);

    assert.equal(await redis.llen('dispatch:queue'), 0);
    assert.equal(await redis.llen('dispatch:processing'), 0);
    assert.equal(await redis.llen('dispatch:deadletter'), 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].token, 'tok');
    assert.equal(received[0].body.schema_version, '1.0');
    assert.equal(received[0].body.player_slot, 1);
  } finally {
    server.close();
    await redis.del(...KEYS);
    await redis.quit();
  }
});

test('integracao: 422 -> dead-letter, processing vazia', { skip }, async () => {
  const redis = await freshClient();
  const server = await startServer((req, res) => {
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
  } finally {
    server.close();
    await redis.del(...KEYS);
    await redis.quit();
  }
});
```

- [ ] **Step 2: Rodar com Redis (efêmero) e confirmar verde**

Run:
```bash
docker run -d --rm -p 6399:6379 --name neu7-redis redis:7-alpine
cd data_broker && REDIS_URL=redis://127.0.0.1:6399 node --test tests/test_dispatcher_integration.test.js
docker stop neu7-redis
```
Expected: 2 tests PASS (não skipped).

- [ ] **Step 3: Confirmar que sem REDIS_URL os testes são pulados (não quebram)**

Run: `cd data_broker && node --test tests/test_dispatcher_integration.test.js`
Expected: 2 tests `# skipped` (não falham).

- [ ] **Step 4: Commit**

```bash
git add data_broker/tests/test_dispatcher_integration.test.js
git commit -m "test(neu-7): integracao do dispatcher (Redis real + HTTP mock)"
```

---

### Task 8: Validação ponta-a-ponta ao vivo (manual — requer token do Pedro)

> **Não é código.** É a prova final contra a função `ingest-race` deployada. Executar **com** o Pedro. Não declarar concluído sem os outputs abaixo.

**Pré-condição — acesso (pedir ao Pedro):**
- `EDGE_INGEST_TOKEN` de produção. Está em `cloud-backend/.secret.prod.env` (gitignored, nesta máquina). Fornecer criando `data_broker/.env` com `EDGE_INGEST_TOKEN=<valor>` (gitignored por `.gitignore:9`) **ou** autorizar a leitura do `.secret.prod.env`. Avisar o Pedro que o token será usado só como env efêmera, nunca commitado nem colado no chat.
- (Opcional, prova gold) Personal Access Token `sbp_` do Supabase para conferir a linha no Postgres.

- [ ] **Step 1: Subir o stack local apontando para a função real**

Com `EDGE_INGEST_TOKEN` e `API_URL` exportados (a `API_URL` é a URL real da §2 do spec):
```bash
cd /Users/pedrotavares/Projetos/NeuroRace/services/edge-service
export API_URL=https://wtaulbdkgrnrtbfezaxw.supabase.co/functions/v1/ingest-race
export EDGE_INGEST_TOKEN=<do Pedro>
docker compose up -d redis broker
```

- [ ] **Step 2: Estimular uma corrida (jogador humano)**

Usar um script socket.io focado a partir de `data_broker/` (isola o dispatcher; mais determinístico que depender de hardware): emitir `registerPlayers` (player1 com email, player2 vazio=bot) → `raceStarted` → alguns `eSense` de `player:1, source:'real'` → `hasFinished {playerId:1}`. (O conteúdo exato do script é trivial com `socket.io-client`, já presente em `package.json`.)

- [ ] **Step 3: Provar entrega + idempotência (sem ler o banco)**

```bash
docker compose logs broker | grep -E "dispatch_success|dispatch_dead_letter"
```
Expected: uma linha `dispatch_success ... "httpStatus":200,"result":"created"`.

Replay: re-enfileirar o **mesmo** record (mesmo `jobId`) em `dispatch:queue` (via `redis-cli RPUSH` do JSON capturado) e observar:
Expected: `dispatch_success ... "result":"duplicate"` (idempotência ponta-a-ponta confirmada). E `LLEN dispatch:deadletter` = 0.

- [ ] **Step 4: (Gold) Conferir a linha no Postgres hospedado**

Com `sbp_` do Pedro, contar as linhas inseridas (via `supabase` CLI ou query SQL). Expected: `race_players` += 1 para o `race_id` da corrida.

- [ ] **Step 5: Limpar dados de teste de produção**

Remover as linhas de teste inseridas (a função `ingest-race` escreve em prod, que estava zerado). Confirmar `count = 0` pós-limpeza. Registrar o output.

- [ ] **Step 6: Derrubar o stack**

```bash
COMPOSE_PROFILES=sim-local,sim-dual,hybrid-local,live docker compose down
unset EDGE_INGEST_TOKEN API_URL
```

- [ ] **Step 7: Abrir o PR**

```bash
git push -u origin feature/neu-7-dispatcher
gh pr create --title "feat(neu-7): dispatcher de resultados de corrida -> ingest-race" \
  --body "Implementa o NEU-7 conforme docs/superpowers/specs/2026-06-22-edge-dispatcher-design.md. Aditivo, sem regressao. E2E ao vivo: 200 created + replay duplicate (logs anexados)."
```

---

## Self-Review (cobertura do spec)

- **§3 contrato de saída** → Task 2 (mapping) + Task 5 (envio com header correto). ✓
- **§4 arquitetura aditiva** → Tasks 5/6; Global Constraints proíbem tocar módulos existentes. ✓
- **§4.1 conexão dedicada** → Task 4. ✓
- **§5.1 fila confiável + recuperação** → Task 5 (`blmove`+`processing`+`recoverProcessing`). ✓
- **§5.2 classificação + timeout HTTP** → Task 5 (`classifyStatus` + `postRace`/AbortController). ✓
- **§5.3 retry com teto** → Task 5 (loop + `dispatchMaxAttempts`). ✓
- **§5.4 desabilitado sem API_URL** → Task 6 (`if config.apiUrl`). ✓
- **§5.5 registro malformado** → Task 5. ✓
- **§5.6 formato dead-letter** → Task 5 (entradas com `reason/httpStatus/errorCode/attempts/failedAt`). ✓
- **§6 config + compose + gap .env** → Tasks 1 e 6. ✓
- **§8 testes (unit/integração/CI)** → Tasks 2-5 (unit) + Task 7 (integração, gated REDIS_URL ⇒ roda no CI que tem service redis). ✓
- **§11 E2E ao vivo** → Task 8. ✓

Tipos consistentes entre tasks: `createDispatcher(redis,config,log,fetchFn,sleepFn)`, `processOnce()→bool`, `recoverProcessing()`, `classifyStatus(status)→string`, `toCanonicalBody(record)→body`, `createBlockingRedisClient(config,log,Ctor)`. Sem placeholders.
