# Redis Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar logging estruturado para eventos de conexão Redis, dequeue do dispatcher, transições de estado da sessão, e health monitor periódico da fila.

**Architecture:** Quatro pontos de observabilidade independentes: (1) `redis_client.js` recebe `log` e registra eventos do ioredis via `EventEmitter`; (2) `api_dispatcher.js` extrai `processDequeue` como método testável e adiciona `startHealthMonitor`; (3) `session_manager.js` loga `session_transition` nos três pontos de mudança de estado; (4) `index.js` e `config.js` fazem o wiring. Nenhum comportamento existente é alterado.

**Tech Stack:** Node.js `node:test`, ioredis 5, `node:events` (EventEmitter para injeção em testes)

---

## File Map

| Ação | Arquivo | Responsabilidade |
|------|---------|-----------------|
| Criar | `data_broker/tests/test_redis_client.test.js` | Testes dos event listeners de conexão |
| Modificar | `data_broker/redis_client.js` | Aceita `log` e `RedisClient` como parâmetros opcionais |
| Modificar | `data_broker/tests/test_session_manager.test.js` | 3 novos testes de transição de estado |
| Modificar | `data_broker/session_manager.js` | `log('info', 'session_transition', ...)` em 3 pontos |
| Modificar | `data_broker/tests/test_api_dispatcher.test.js` | 2 novos testes: `processDequeue` e `startHealthMonitor` |
| Modificar | `data_broker/api_dispatcher.js` | Extrai `processDequeue`, adiciona `startHealthMonitor` |
| Modificar | `data_broker/config.js` | Adiciona `queueHealthIntervalMs` |
| Modificar | `data_broker/index.js` | Passa `log` para `createRedisClient`, remove handler duplicado, chama `startHealthMonitor` |

---

### Task 1: Redis connection logging

**Files:**
- Create: `data_broker/tests/test_redis_client.test.js`
- Modify: `data_broker/redis_client.js`

- [ ] **Step 1: Escrever os testes (RED)**

Criar `data_broker/tests/test_redis_client.test.js`:

```js
// data_broker/tests/test_redis_client.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRedisClient } = require('../redis_client');

class FakeRedis extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
  }
}

test('evento connect loga redis_connected no nível info', () => {
  const logs = [];
  const client = createRedisClient(
    { redisUrl: 'redis://fake:6379' },
    (level, message, meta) => logs.push({ level, message, meta }),
    FakeRedis,
  );

  client.emit('connect');

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'info');
  assert.equal(logs[0].message, 'redis_connected');
});

test('evento error loga redis_error com message no nível error', () => {
  const logs = [];
  const client = createRedisClient(
    { redisUrl: 'redis://fake:6379' },
    (level, message, meta) => logs.push({ level, message, meta }),
    FakeRedis,
  );

  client.emit('error', new Error('connection refused'));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'error');
  assert.equal(logs[0].message, 'redis_error');
  assert.equal(logs[0].meta.message, 'connection refused');
});

test('evento close loga redis_closed no nível warn', () => {
  const logs = [];
  const client = createRedisClient(
    { redisUrl: 'redis://fake:6379' },
    (level, message, meta) => logs.push({ level, message, meta }),
    FakeRedis,
  );

  client.emit('close');

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].message, 'redis_closed');
});
```

- [ ] **Step 2: Rodar para confirmar FAIL**

```bash
cd data_broker && node --test tests/test_redis_client.test.js
```

Esperado: 3 falhas — `createRedisClient` não aceita o 3º parâmetro ainda.

- [ ] **Step 3: Implementar `redis_client.js`**

Substituir o conteúdo de `data_broker/redis_client.js` por:

```js
// data_broker/redis_client.js
const Redis = require('ioredis');

function createRedisClient(config, log = () => {}, RedisClient = Redis) {
  const client = new RedisClient(config.redisUrl);
  client.on('connect', () => log('info', 'redis_connected', {}));
  client.on('error', (err) => log('error', 'redis_error', { message: err.message }));
  client.on('close', () => log('warn', 'redis_closed', {}));
  return client;
}

module.exports = { createRedisClient };
```

- [ ] **Step 4: Rodar para confirmar PASS**

```bash
cd data_broker && node --test tests/test_redis_client.test.js
```

Esperado: `▶ 3 tests passed`.

- [ ] **Step 5: Rodar suite completa para confirmar sem regressões**

```bash
cd data_broker && npm test
```

Esperado: todos os testes anteriores passam + 3 novos.

- [ ] **Step 6: Commit**

```bash
cd data_broker && git add tests/test_redis_client.test.js redis_client.js
git commit -m "feat: log redis connect/error/close events with injectable constructor"
```

---

### Task 2: Session state transitions

**Files:**
- Modify: `data_broker/tests/test_session_manager.test.js`
- Modify: `data_broker/session_manager.js`

- [ ] **Step 1: Escrever os testes (RED)**

Adicionar os três testes a seguir ao final de `data_broker/tests/test_session_manager.test.js`, **antes** do último `});` de fechamento se houver, ou simplesmente ao final do arquivo:

```js
test('registerPlayers loga session_transition com to:setup e emails', async () => {
  const redis = createRedisFake();
  const logs = [];
  const sm = createSessionManager(redis, config, (l, m, d) => logs.push({ l, m, d }));

  await sm.registerPlayers('p1@x.com', 'p2@x.com');

  const t = logs.find((entry) => entry.m === 'session_transition');
  assert.ok(t, 'deve existir log session_transition');
  assert.equal(t.d.from, 'none');
  assert.equal(t.d.to, 'setup');
  assert.equal(t.d.player1Email, 'p1@x.com');
  assert.equal(t.d.player2Email, 'p2@x.com');
});

test('onRaceStarted loga session_transition com from:setup to:active e sessionId', async () => {
  const redis = createRedisFake();
  const logs = [];
  redis.hashes['pending:players'] = {
    player1Email: 'a@x.com',
    player1Uuid: '',
    player2Email: 'b@x.com',
    player2Uuid: '',
  };
  const sm = createSessionManager(redis, config, (l, m, d) => logs.push({ l, m, d }));

  await sm.onRaceStarted();

  const t = logs.find((entry) => entry.m === 'session_transition');
  assert.ok(t, 'deve existir log session_transition');
  assert.equal(t.d.from, 'setup');
  assert.equal(t.d.to, 'active');
  assert.ok(t.d.sessionId, 'sessionId deve ser preenchido');
});

test('onHasFinished para último player loga session_transition com to:finished', async () => {
  const redis = createRedisFake();
  const logs = [];
  redis.hashes['session:current'] = {
    id: 'sess-1',
    startedAt: '1000000000',
    player1IsBot: 'false',
    player1Email: 'p1@x.com',
    player1Uuid: '',
    player2IsBot: 'true', // player 2 é bot → player 1 é o último
  };
  const sm = createSessionManager(redis, config, (l, m, d) => logs.push({ l, m, d }));

  await sm.onHasFinished({ playerId: 1 });

  const t = logs.find((entry) => entry.m === 'session_transition');
  assert.ok(t, 'deve existir log session_transition');
  assert.equal(t.d.from, 'active');
  assert.equal(t.d.to, 'finished');
  assert.equal(t.d.sessionId, 'sess-1');
});
```

- [ ] **Step 2: Rodar para confirmar FAIL**

```bash
cd data_broker && node --test tests/test_session_manager.test.js
```

Esperado: 3 falhas (testes novos não encontram `session_transition` nos logs).

- [ ] **Step 3: Implementar as transições em `session_manager.js`**

**3a.** No final de `registerPlayers`, após `await redis.expire('pending:players', 3600);`, adicionar:

```js
    log('info', 'session_transition', {
      from: 'none',
      to: 'setup',
      player1Email,
      player2Email,
    });
```

O trecho completo da função após a mudança:

```js
  async function registerPlayers(player1Email, player2Email) {
    const player1 = await validateEmail(player1Email);
    const player2 = await validateEmail(player2Email);

    await redis.hset(
      'pending:players',
      'player1Email', player1Email,
      'player1Uuid', player1.uuid || '',
      'player2Email', player2Email,
      'player2Uuid', player2.uuid || '',
    );
    await redis.expire('pending:players', 3600);
    log('info', 'session_transition', {
      from: 'none',
      to: 'setup',
      player1Email,
      player2Email,
    });

    return { player1, player2 };
  }
```

**3b.** Em `onRaceStarted`, após o `log('info', 'race_started', ...)` existente, adicionar:

```js
    log('info', 'session_transition', { from: 'setup', to: 'active', sessionId: id });
```

O trecho completo após a mudança:

```js
    log('info', 'race_started', {
      sessionId: id,
      player1IsBot: player1Email === '',
      player2IsBot: player2Email === '',
    });
    log('info', 'session_transition', { from: 'setup', to: 'active', sessionId: id });
  }
```

**3c.** Em `onHasFinished`, após o `log('info', 'job_enqueued', ...)` existente, adicionar:

```js
    const otherPlayerId = playerId == 1 ? 2 : 1;
    const otherIsBot = session[`player${otherPlayerId}IsBot`] === 'true';
    const otherDispatched = session[`player${otherPlayerId}Dispatched`] === 'true';
    if (otherIsBot || otherDispatched) {
      log('info', 'session_transition', { from: 'active', to: 'finished', sessionId: session.id });
    }
```

O trecho completo após a mudança:

```js
    await redis.rpush('dispatch:queue', JSON.stringify(job));
    await redis.hset('session:current', dispatchedKey, 'true');
    log('info', 'job_enqueued', { jobId: job.jobId, playerId, sessionId: session.id });

    const otherPlayerId = playerId == 1 ? 2 : 1;
    const otherIsBot = session[`player${otherPlayerId}IsBot`] === 'true';
    const otherDispatched = session[`player${otherPlayerId}Dispatched`] === 'true';
    if (otherIsBot || otherDispatched) {
      log('info', 'session_transition', { from: 'active', to: 'finished', sessionId: session.id });
    }
  }
```

- [ ] **Step 4: Rodar para confirmar PASS**

```bash
cd data_broker && node --test tests/test_session_manager.test.js
```

Esperado: todos os testes do arquivo passam.

- [ ] **Step 5: Rodar suite completa**

```bash
cd data_broker && npm test
```

Esperado: sem regressões.

- [ ] **Step 6: Commit**

```bash
cd data_broker && git add tests/test_session_manager.test.js session_manager.js
git commit -m "feat: log session state transitions (none→setup→active→finished)"
```

---

### Task 3: Dispatcher — processDequeue, startHealthMonitor e config

**Files:**
- Modify: `data_broker/config.js`
- Modify: `data_broker/tests/test_api_dispatcher.test.js`
- Modify: `data_broker/api_dispatcher.js`

- [ ] **Step 1: Adicionar `queueHealthIntervalMs` ao config**

Em `data_broker/config.js`, adicionar dentro do objeto retornado por `loadBrokerConfig`, após `backoffMaxMs`:

```js
    queueHealthIntervalMs: Number(env.QUEUE_HEALTH_INTERVAL_MS || 30000),
```

O bloco `return` completo após a mudança:

```js
  return {
    port: Number(env.BROKER_PORT || 3000),
    allowedOrigins,
    redisUrl: env.REDIS_URL || 'redis://redis:6379',
    apiUrl: env.API_URL || null,
    supabaseUrl: env.SUPABASE_URL || null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || null,
    dispatchTtlMs: Number(env.DISPATCH_TTL_MS || 86400000),
    backoffBaseMs: Number(env.DISPATCH_BACKOFF_BASE_MS || 1000),
    backoffMaxMs: Number(env.DISPATCH_BACKOFF_MAX_MS || 60000),
    queueHealthIntervalMs: Number(env.QUEUE_HEALTH_INTERVAL_MS || 30000),
  };
```

- [ ] **Step 2: Escrever os testes (RED)**

Adicionar ao final de `data_broker/tests/test_api_dispatcher.test.js`:

```js
test('processDequeue loga dispatcher_dequeued com jobId e queue_size corretos', async () => {
  const logs = [];
  const job = makeJob();
  const redis = {
    async blpop() { return ['dispatch:queue', JSON.stringify(job)]; },
    async llen() { return 7; },
    async rpush() {},
  };
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    async () => ({ ok: true }),
  );

  await dispatcher.processDequeue();

  const dequeueLog = logs.find((entry) => entry.m === 'dispatcher_dequeued');
  assert.ok(dequeueLog, 'deve logar dispatcher_dequeued');
  assert.equal(dequeueLog.d.jobId, 'job-1');
  assert.equal(dequeueLog.d.queue_size, 7);
});

test('startHealthMonitor loga queue_health com queue_size e retorna função de stop', async () => {
  const logs = [];
  const redis = {
    async llen() { return 5; },
  };
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
  );

  const stop = dispatcher.startHealthMonitor(1); // 1ms para disparar rapidamente no teste
  await new Promise((r) => setTimeout(r, 20));
  stop();

  const healthLog = logs.find((entry) => entry.m === 'queue_health');
  assert.ok(healthLog, 'deve logar queue_health');
  assert.equal(healthLog.d.queue_size, 5);
});
```

- [ ] **Step 3: Rodar para confirmar FAIL**

```bash
cd data_broker && node --test tests/test_api_dispatcher.test.js
```

Esperado: 2 falhas — `processDequeue` e `startHealthMonitor` não existem ainda.

- [ ] **Step 4: Implementar `processDequeue` e `startHealthMonitor` em `api_dispatcher.js`**

Substituir o corpo de `createDispatcher` (mantendo `processJob` no topo do arquivo inalterado):

```js
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
```

- [ ] **Step 5: Rodar para confirmar PASS**

```bash
cd data_broker && node --test tests/test_api_dispatcher.test.js
```

Esperado: todos os 11 testes do arquivo passam.

- [ ] **Step 6: Rodar suite completa**

```bash
cd data_broker && npm test
```

Esperado: sem regressões.

- [ ] **Step 7: Commit**

```bash
cd data_broker && git add config.js tests/test_api_dispatcher.test.js api_dispatcher.js
git commit -m "feat: expose processDequeue with queue_size log and add startHealthMonitor"
```

---

### Task 4: Wire tudo em index.js

**Files:**
- Modify: `data_broker/index.js`

Não há testes unitários para `index.js` (é o entry point). A verificação é feita pela suite completa.

- [ ] **Step 1: Atualizar `index.js`**

Substituir o conteúdo completo de `data_broker/index.js` por:

```js
// data_broker/index.js
const { loadBrokerConfig } = require('./config');
const { createRedisClient } = require('./redis_client');
const { createSessionManager } = require('./session_manager');
const { createDispatcher } = require('./api_dispatcher');
const { createHttpServer } = require('./http_server');
const { createBrokerLogger } = require('./logger');
const { createSocketServer, registerSocketHandlers } = require('./socket_handlers');

const config = loadBrokerConfig();
const log = createBrokerLogger();
const redis = createRedisClient(config, log);
const session = createSessionManager(redis, config, log);
const server = createHttpServer(session);
const io = createSocketServer(server, config.allowedOrigins);
const emitFn = (event, payload) => io.emit(event, payload);
const dispatcher = createDispatcher(redis, config, log, fetch, undefined, emitFn);

registerSocketHandlers(io, log, session);
dispatcher.start().catch((err) =>
  log('error', 'dispatcher_fatal', { message: err?.message ?? String(err) }),
);
dispatcher.startHealthMonitor(config.queueHealthIntervalMs);

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
```

Mudanças em relação ao original:
- Linha 12: `createRedisClient(config, log)` — passa `log` como 2º argumento
- Linhas 13-15 removidas: o `redis.on('error', ...)` duplicado (agora coberto pelo listener em `redis_client.js`)
- Linha 24 nova: `dispatcher.startHealthMonitor(config.queueHealthIntervalMs)`

- [ ] **Step 2: Rodar suite completa**

```bash
cd data_broker && npm test
```

Esperado: 51 testes passando (43 anteriores + 8 novos).

- [ ] **Step 3: Commit**

```bash
cd data_broker && git add index.js
git commit -m "feat: wire redis log and health monitor in index.js"
```

---

## Self-Review

### Cobertura do spec

| Requisito | Tarefa |
|-----------|--------|
| Redis connect/error/close events | Task 1 |
| `dispatcher_dequeued` com `queue_size` após BLPOP | Task 3 (`processDequeue`) |
| `session_transition` none→setup | Task 2 (`registerPlayers`) |
| `session_transition` setup→active | Task 2 (`onRaceStarted`) |
| `session_transition` active→finished | Task 2 (`onHasFinished`) |
| Queue health periódico (N segundos) | Task 3 (`startHealthMonitor`) |
| Configuração `QUEUE_HEALTH_INTERVAL_MS` | Task 3 (`config.js`) |
| Wiring em `index.js` | Task 4 |

Cobertura: 100%.

### Placeholders

Nenhum "TODO", "TBD", ou "similar ao task N" no plano. Todo código está completo.

### Consistência de tipos e nomes

- `processDequeue` definido em Task 3, referenciado em Task 4 → consistente
- `startHealthMonitor(intervalMs)` definido em Task 3, chamado em Task 4 como `startHealthMonitor(config.queueHealthIntervalMs)` → consistente
- `log('info', 'session_transition', { from, to, ... })` — mesmo formato nos 3 pontos de Task 2
- `log('info', 'dispatcher_dequeued', { jobId, queue_size })` — usado no teste e na implementação de Task 3
- `FakeRedis extends EventEmitter` — usado apenas em Task 1, sem dependências cross-task
