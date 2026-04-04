# EEG Persistence & Dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar persistência Redis e despacho pós-corrida para Supabase ao `data_broker`, garantindo entrega offline-first sem bloquear o jogo.

**Architecture:** Três novos módulos independentes (`redis_client`, `session_manager`, `api_dispatcher`) são injetados no wiring de `index.js`. O `session_manager` é passado como efeito colateral ao `socket_handlers` para reagir a eventos Socket.IO sem alterar a estrutura de broadcast existente. O `api_dispatcher` roda um loop BLPOP em background, com retry por backoff exponencial.

**Tech Stack:** Node.js 18+, ioredis 5.x, node:test + node:assert/strict, Docker Compose (Redis 7-alpine).

---

## Mapa de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `data_broker/package.json` | Modificar | Adicionar dependência `ioredis` |
| `data_broker/config.js` | Modificar | Carregar REDIS_URL, API_URL, SUPABASE_URL, SUPABASE_ANON_KEY, DISPATCH_TTL_MS, DISPATCH_BACKOFF_BASE_MS, DISPATCH_BACKOFF_MAX_MS |
| `data_broker/redis_client.js` | Criar | Singleton ioredis configurado com `config.redisUrl` |
| `data_broker/session_manager.js` | Criar | Ciclo de vida da corrida: registerPlayers, onRaceStarted, onEsense, onHasFinished |
| `data_broker/api_dispatcher.js` | Criar | Loop BLPOP + retry/backoff + processJob exportado para testes |
| `data_broker/http_server.js` | Modificar | Aceitar `session` como parâmetro; adicionar `POST /api/players` |
| `data_broker/socket_handlers.js` | Modificar | `createForwardEventHandler` e `registerSocketHandlers` aceitam `session` opcional |
| `data_broker/index.js` | Modificar | Wiring completo: redis → session → dispatcher → server → io |
| `data_broker/tests/test_session_manager.test.js` | Criar | 9 casos de teste com Redis fake |
| `data_broker/tests/test_api_dispatcher.test.js` | Criar | 6 casos de teste com fetch mockado |
| `data_broker/.env.example` | Criar | Template das variáveis de ambiente novas |
| `docker-compose.yml` | Modificar | Adicionar serviço `redis:7-alpine`; broker ganha `depends_on: [redis]` |

---

## Task 1: Instalar ioredis e estender config.js

**Files:**
- Modify: `data_broker/package.json`
- Modify: `data_broker/config.js`

- [ ] **Step 1: Instalar ioredis**

```bash
cd data_broker && npm install ioredis
```

Saída esperada: linha `"ioredis": "^5.x.x"` adicionada em `package.json`.

- [ ] **Step 2: Verificar instalação**

```bash
node -e "require('ioredis'); console.log('ok')"
```

Saída esperada: `ok`

- [ ] **Step 3: Estender config.js com as novas variáveis**

Substitua o conteúdo completo de `data_broker/config.js`:

```js
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://localhost:8000',
];

function loadBrokerConfig(env = process.env) {
  const allowedOrigins = (env.BROKER_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

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
  };
}

module.exports = {
  loadBrokerConfig,
};
```

- [ ] **Step 4: Verificar que config carrega os defaults corretamente**

```bash
node -e "
const { loadBrokerConfig } = require('./config');
const c = loadBrokerConfig({});
console.assert(c.redisUrl === 'redis://redis:6379', 'redisUrl');
console.assert(c.apiUrl === null, 'apiUrl');
console.assert(c.dispatchTtlMs === 86400000, 'dispatchTtlMs');
console.assert(c.backoffBaseMs === 1000, 'backoffBaseMs');
console.assert(c.backoffMaxMs === 60000, 'backoffMaxMs');
console.log('config ok');
"
```

Saída esperada: `config ok`

- [ ] **Step 5: Verificar que config respeita variáveis de ambiente**

```bash
node -e "
const { loadBrokerConfig } = require('./config');
const c = loadBrokerConfig({ REDIS_URL: 'redis://localhost:6379', API_URL: 'https://api.example.com', DISPATCH_TTL_MS: '3600000' });
console.assert(c.redisUrl === 'redis://localhost:6379', 'redisUrl');
console.assert(c.apiUrl === 'https://api.example.com', 'apiUrl');
console.assert(c.dispatchTtlMs === 3600000, 'dispatchTtlMs');
console.log('config env ok');
"
```

Saída esperada: `config env ok`

- [ ] **Step 6: Commit**

```bash
cd ..
git add data_broker/package.json data_broker/package-lock.json data_broker/config.js
git commit -m "feat: add ioredis dependency and extend broker config"
```

---

## Task 2: Criar redis_client.js

**Files:**
- Create: `data_broker/redis_client.js`

- [ ] **Step 1: Criar o arquivo**

```js
// data_broker/redis_client.js
const Redis = require('ioredis');

function createRedisClient(config) {
  return new Redis(config.redisUrl);
}

module.exports = { createRedisClient };
```

- [ ] **Step 2: Verificar que importa sem erros**

```bash
cd data_broker
node -e "const { createRedisClient } = require('./redis_client'); console.log('ok');"
```

Saída esperada: `ok`

- [ ] **Step 3: Commit**

```bash
cd ..
git add data_broker/redis_client.js
git commit -m "feat: add redis_client singleton wrapper"
```

---

## Task 3: session_manager.js — registerPlayers e onRaceStarted (TDD)

**Files:**
- Create: `data_broker/session_manager.js`
- Create: `data_broker/tests/test_session_manager.test.js`

- [ ] **Step 1: Criar o arquivo de teste com o Redis fake e os 4 primeiros casos**

```js
// data_broker/tests/test_session_manager.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionManager } = require('../session_manager');

function createRedisFake() {
  const hashes = {};
  const lists = {};
  return {
    hashes,
    lists,
    async hset(key, ...args) {
      if (!hashes[key]) hashes[key] = {};
      for (let i = 0; i < args.length; i += 2) {
        hashes[key][args[i]] = args[i + 1];
      }
    },
    async hgetall(key) {
      return hashes[key] || null;
    },
    async del(key) {
      delete hashes[key];
    },
    async expire() {},
    async rpush(key, value) {
      if (!lists[key]) lists[key] = [];
      lists[key].push(value);
    },
    async lrange(key, start, end) {
      const list = lists[key] || [];
      return end === -1 ? list.slice(start) : list.slice(start, end + 1);
    },
    multi() {
      const self = this;
      const ops = [];
      const chain = {
        hset(key, ...args) {
          ops.push({ cmd: 'hset', key, args });
          return chain;
        },
        del(key) {
          ops.push({ cmd: 'del', key });
          return chain;
        },
        async exec() {
          for (const op of ops) {
            if (op.cmd === 'hset') {
              if (!self.hashes[op.key]) self.hashes[op.key] = {};
              for (let i = 0; i < op.args.length; i += 2) {
                self.hashes[op.key][op.args[i]] = op.args[i + 1];
              }
            } else if (op.cmd === 'del') {
              delete self.hashes[op.key];
            }
          }
        },
      };
      return chain;
    },
  };
}

const noopLog = () => {};
const config = {
  supabaseUrl: null,
  supabaseAnonKey: null,
  dispatchTtlMs: 86400000,
};

test('registerPlayers stores emails in pending:players', async () => {
  const redis = createRedisFake();
  const sm = createSessionManager(redis, config, noopLog);

  await sm.registerPlayers('p1@x.com', 'p2@x.com');

  const pending = redis.hashes['pending:players'];
  assert.equal(pending.player1Email, 'p1@x.com');
  assert.equal(pending.player2Email, 'p2@x.com');
});

test('registerPlayers returns validated:false when supabaseUrl not configured', async () => {
  const redis = createRedisFake();
  const sm = createSessionManager(redis, config, noopLog);

  const result = await sm.registerPlayers('p1@x.com', '');

  assert.equal(result.player1.uuid, null);
  assert.equal(result.player1.validated, false);
  assert.equal(result.player2.uuid, null);
  assert.equal(result.player2.validated, false);
});

test('onRaceStarted creates session:current and removes pending:players', async () => {
  const redis = createRedisFake();
  redis.hashes['pending:players'] = {
    player1Email: 'a@x.com',
    player1Uuid: 'uuid-1',
    player2Email: 'b@x.com',
    player2Uuid: '',
  };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onRaceStarted();

  const session = redis.hashes['session:current'];
  assert.ok(session, 'session:current deve existir');
  assert.ok(session.id, 'id deve ser gerado');
  assert.equal(session.status, 'active');
  assert.equal(session.player1Email, 'a@x.com');
  assert.equal(session.player1IsBot, 'false');
  assert.equal(session.player2Email, 'b@x.com');
  assert.equal(session.player2IsBot, 'false');
  assert.equal(redis.hashes['pending:players'], undefined, 'pending:players deve ser removido');
});

test('onRaceStarted marca player como bot quando email vazio', async () => {
  const redis = createRedisFake();
  redis.hashes['pending:players'] = {
    player1Email: 'a@x.com',
    player1Uuid: 'uuid-1',
    player2Email: '',
    player2Uuid: '',
  };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onRaceStarted();

  assert.equal(redis.hashes['session:current'].player1IsBot, 'false');
  assert.equal(redis.hashes['session:current'].player2IsBot, 'true');
});

test('onRaceStarted sem pending:players inicia com ambos os players como bot', async () => {
  const redis = createRedisFake();
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onRaceStarted();

  assert.equal(redis.hashes['session:current'].player1IsBot, 'true');
  assert.equal(redis.hashes['session:current'].player2IsBot, 'true');
});
```

- [ ] **Step 2: Rodar os testes para confirmar que falham**

```bash
cd data_broker
node --test tests/test_session_manager.test.js
```

Saída esperada: `FAIL` com `Cannot find module '../session_manager'`

- [ ] **Step 3: Criar session_manager.js com registerPlayers e onRaceStarted**

```js
// data_broker/session_manager.js
const { randomUUID } = require('node:crypto');

function createSessionManager(redis, config, log) {
  async function validateEmail(email) {
    if (!email) return { email, uuid: null, validated: false };
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      log('warn', 'email_validation_skipped', { email });
      return { email, uuid: null, validated: false };
    }
    // Endpoint definido quando a Supabase Edge Function for implementada
    return { email, uuid: null, validated: false };
  }

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

    return { player1, player2 };
  }

  async function onRaceStarted() {
    const pending = await redis.hgetall('pending:players');

    const player1Email = pending?.player1Email || '';
    const player1Uuid = pending?.player1Uuid || '';
    const player2Email = pending?.player2Email || '';
    const player2Uuid = pending?.player2Uuid || '';

    const id = randomUUID();
    const startedAt = Date.now();

    await redis.multi()
      .hset(
        'session:current',
        'id', id,
        'startedAt', String(startedAt),
        'status', 'active',
        'player1Email', player1Email,
        'player1Uuid', player1Uuid,
        'player1IsBot', player1Email === '' ? 'true' : 'false',
        'player2Email', player2Email,
        'player2Uuid', player2Uuid,
        'player2IsBot', player2Email === '' ? 'true' : 'false',
      )
      .del('pending:players')
      .exec();

    log('info', 'race_started', {
      sessionId: id,
      player1IsBot: player1Email === '',
      player2IsBot: player2Email === '',
    });
  }

  async function onEsense() {}
  async function onHasFinished() {}

  return { registerPlayers, onRaceStarted, onEsense, onHasFinished };
}

module.exports = { createSessionManager };
```

- [ ] **Step 4: Rodar os testes para confirmar que passam**

```bash
node --test tests/test_session_manager.test.js
```

Saída esperada: `5 tests passed`

- [ ] **Step 5: Commit**

```bash
cd ..
git add data_broker/session_manager.js data_broker/tests/test_session_manager.test.js
git commit -m "feat: session_manager registerPlayers and onRaceStarted"
```

---

## Task 4: session_manager.js — onEsense e onHasFinished (TDD)

**Files:**
- Modify: `data_broker/session_manager.js`
- Modify: `data_broker/tests/test_session_manager.test.js`

- [ ] **Step 1: Adicionar os 4 casos restantes no arquivo de teste**

Adicione ao final de `data_broker/tests/test_session_manager.test.js`:

```js
test('onEsense com source:bot não faz RPUSH', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = { id: 'sess-1', status: 'active' };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onEsense({
    player: 1,
    source: 'bot',
    attention: 80,
    meditation: 55,
    eegPower: {},
    poorSignalLevel: 0,
    status: 'ok',
    timeStamp: 1000,
  });

  assert.equal(redis.lists['session:sess-1:player:1:packets'], undefined);
});

test('onEsense com source:real faz RPUSH na lista correta do player', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = { id: 'sess-1', status: 'active' };
  const sm = createSessionManager(redis, config, noopLog);

  const payload = {
    player: 1,
    source: 'real',
    attention: 80,
    meditation: 55,
    eegPower: { delta: 10 },
    poorSignalLevel: 0,
    status: 'ok',
    timeStamp: 1000,
  };
  await sm.onEsense(payload);

  const list = redis.lists['session:sess-1:player:1:packets'];
  assert.equal(list.length, 1);
  assert.deepEqual(JSON.parse(list[0]), payload);
});

test('onHasFinished para player bot não enfileira job', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = {
    id: 'sess-1',
    player1IsBot: 'false',
    player2IsBot: 'true',
  };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onHasFinished({ playerId: 2 });

  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('onHasFinished para player humano enfileira job com payload correto', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = {
    id: 'sess-1',
    startedAt: '1000000000',
    player1IsBot: 'false',
    player1Email: 'p1@x.com',
    player1Uuid: 'uuid-p1',
  };
  const packet = {
    player: 1,
    source: 'real',
    attention: 80,
    meditation: 55,
    eegPower: {},
    poorSignalLevel: 0,
    status: 'ok',
    timeStamp: 1000,
  };
  redis.lists['session:sess-1:player:1:packets'] = [JSON.stringify(packet)];
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onHasFinished({ playerId: 1 });

  const jobs = redis.lists['dispatch:queue'];
  assert.equal(jobs.length, 1);
  const job = JSON.parse(jobs[0]);
  assert.equal(job.playerId, 1);
  assert.equal(job.sessionId, 'sess-1');
  assert.ok(job.expiresAt > Date.now());
  assert.equal(job.attempts, 0);
  assert.ok(job.jobId, 'jobId deve ser um UUID');
  assert.equal(job.payload.email, 'p1@x.com');
  assert.equal(job.payload.playerUuid, 'uuid-p1');
  assert.equal(job.payload.startedAt, 1000000000);
  assert.equal(job.payload.packets.length, 1);
  assert.deepEqual(job.payload.packets[0], packet);
});

test('onHasFinished duplicado é ignorado', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = {
    id: 'sess-1',
    startedAt: '1000000000',
    player1IsBot: 'false',
    player1Email: 'p1@x.com',
    player1Uuid: '',
    player1Dispatched: 'true',
  };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onHasFinished({ playerId: 1 });

  assert.equal(redis.lists['dispatch:queue'], undefined);
});
```

- [ ] **Step 2: Rodar os testes para confirmar que os 4 novos falham**

```bash
cd data_broker
node --test tests/test_session_manager.test.js
```

Saída esperada: 5 `passed`, 4 `failed` (os novos casos de onEsense/onHasFinished).

- [ ] **Step 3: Implementar onEsense e onHasFinished em session_manager.js**

Substitua as funções stub `onEsense` e `onHasFinished` em `data_broker/session_manager.js`:

```js
  async function onEsense(payload) {
    if (payload.source === 'bot') return;

    const session = await redis.hgetall('session:current');
    if (!session) {
      log('warn', 'esense_no_active_session', { player: payload.player });
      return;
    }

    await redis.rpush(
      `session:${session.id}:player:${payload.player}:packets`,
      JSON.stringify(payload),
    );
  }

  async function onHasFinished(payload) {
    const { playerId } = payload;
    const session = await redis.hgetall('session:current');
    if (!session) {
      log('warn', 'has_finished_no_active_session', { playerId });
      return;
    }

    const isBotKey = `player${playerId}IsBot`;
    const dispatchedKey = `player${playerId}Dispatched`;

    if (session[isBotKey] === 'true') return;

    if (session[dispatchedKey] === 'true') {
      log('warn', 'has_finished_duplicate', { playerId, sessionId: session.id });
      return;
    }

    const rawPackets = await redis.lrange(
      `session:${session.id}:player:${playerId}:packets`,
      0,
      -1,
    );
    const packets = rawPackets.map((p) => JSON.parse(p));

    const job = {
      jobId: randomUUID(),
      playerId,
      sessionId: session.id,
      expiresAt: Date.now() + config.dispatchTtlMs,
      attempts: 0,
      payload: {
        email: session[`player${playerId}Email`],
        playerUuid: session[`player${playerId}Uuid`] || null,
        startedAt: Number(session.startedAt),
        finishedAt: Date.now(),
        packets,
      },
    };

    await redis.rpush('dispatch:queue', JSON.stringify(job));
    await redis.hset('session:current', dispatchedKey, 'true');
    log('info', 'job_enqueued', { jobId: job.jobId, playerId, sessionId: session.id });
  }
```

- [ ] **Step 4: Rodar todos os testes para confirmar que passam**

```bash
node --test tests/test_session_manager.test.js
```

Saída esperada: `9 tests passed`

- [ ] **Step 5: Commit**

```bash
cd ..
git add data_broker/session_manager.js data_broker/tests/test_session_manager.test.js
git commit -m "feat: session_manager onEsense and onHasFinished"
```

---

## Task 5: api_dispatcher.js (TDD)

**Files:**
- Create: `data_broker/api_dispatcher.js`
- Create: `data_broker/tests/test_api_dispatcher.test.js`

- [ ] **Step 1: Criar o arquivo de testes**

```js
// data_broker/tests/test_api_dispatcher.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../api_dispatcher');

function createRedisFake() {
  const lists = {};
  return {
    lists,
    async rpush(key, value) {
      if (!lists[key]) lists[key] = [];
      lists[key].push(value);
    },
  };
}

const config = {
  apiUrl: 'https://example.com/api',
  supabaseAnonKey: 'test-key',
  backoffBaseMs: 0,
  backoffMaxMs: 0,
};

const noopLog = () => {};

function makeJob(overrides = {}) {
  return {
    jobId: 'job-1',
    playerId: 1,
    sessionId: 'sess-1',
    expiresAt: Date.now() + 60000,
    attempts: 0,
    payload: {
      email: 'p@x.com',
      playerUuid: null,
      startedAt: 1000,
      finishedAt: 2000,
      packets: [],
    },
    ...overrides,
  };
}

test('job válido executa POST e loga dispatch_success', async () => {
  const redis = createRedisFake();
  const logs = [];
  const mockFetch = async () => ({ ok: true });
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    mockFetch,
  );

  await dispatcher.processJob(makeJob());

  assert.equal(logs[0].m, 'dispatch_success');
  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('job com expiresAt no passado é descartado sem POST', async () => {
  const redis = createRedisFake();
  const logs = [];
  const mockFetch = async () => {
    throw new Error('não deve ser chamado');
  };
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    mockFetch,
  );

  await dispatcher.processJob(makeJob({ expiresAt: Date.now() - 1000 }));

  assert.equal(logs[0].m, 'job_expired');
  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('API_URL ausente descarta job com log e sem erro fatal', async () => {
  const redis = createRedisFake();
  const logs = [];
  const cfgNoUrl = { ...config, apiUrl: null };
  const dispatcher = createDispatcher(
    redis,
    cfgNoUrl,
    (l, m, d) => logs.push({ l, m, d }),
  );

  await dispatcher.processJob(makeJob());

  assert.equal(logs[0].m, 'api_url_not_configured');
  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('falha no POST re-enfileira job com attempts incrementado', async () => {
  const redis = createRedisFake();
  const logs = [];
  const mockFetch = async () => {
    throw new Error('network error');
  };
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    mockFetch,
  );

  await dispatcher.processJob(makeJob());

  assert.equal(logs[0].m, 'dispatch_retry');
  assert.equal(redis.lists['dispatch:queue'].length, 1);
  const requeued = JSON.parse(redis.lists['dispatch:queue'][0]);
  assert.equal(requeued.attempts, 1);
});

test('resposta HTTP não-2xx aciona retry', async () => {
  const redis = createRedisFake();
  const logs = [];
  const mockFetch = async () => ({ ok: false, status: 500 });
  const dispatcher = createDispatcher(
    redis,
    config,
    (l, m, d) => logs.push({ l, m, d }),
    mockFetch,
  );

  await dispatcher.processJob(makeJob());

  assert.equal(logs[0].m, 'dispatch_retry');
  const requeued = JSON.parse(redis.lists['dispatch:queue'][0]);
  assert.equal(requeued.attempts, 1);
});

test('backoff é limitado pelo backoffMaxMs', async () => {
  const redis = createRedisFake();
  const cfgCapped = { ...config, backoffBaseMs: 10, backoffMaxMs: 30 };
  const delays = [];
  const mockFetch = async () => {
    throw new Error('network error');
  };
  // Injeta sleep para capturar o delay calculado
  const dispatcher = createDispatcher(
    redis,
    cfgCapped,
    noopLog,
    mockFetch,
    async (ms) => delays.push(ms),
  );

  // attempts=5 → delay = min(10 * 2^6, 30) = min(640, 30) = 30
  await dispatcher.processJob(makeJob({ attempts: 5 }));

  assert.equal(delays[0], 30);
  const requeued = JSON.parse(redis.lists['dispatch:queue'][0]);
  assert.equal(requeued.attempts, 6);
});
```

- [ ] **Step 2: Rodar os testes para confirmar que falham**

```bash
cd data_broker
node --test tests/test_api_dispatcher.test.js
```

Saída esperada: `FAIL` com `Cannot find module '../api_dispatcher'`

- [ ] **Step 3: Criar api_dispatcher.js**

```js
// data_broker/api_dispatcher.js

async function processJob(job, redis, config, log, fetchFn, sleepFn) {
  if (Date.now() > job.expiresAt) {
    log('warn', 'job_expired', { jobId: job.jobId });
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
      return;
    }

    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    job.attempts++;
    const delay = Math.min(
      config.backoffBaseMs * Math.pow(2, job.attempts),
      config.backoffMaxMs,
    );
    await sleepFn(delay);
    await redis.rpush('dispatch:queue', JSON.stringify(job));
    log('warn', 'dispatch_retry', {
      jobId: job.jobId,
      attempts: job.attempts,
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
) {
  return {
    async start() {
      while (true) {
        const [, raw] = await redis.blpop('dispatch:queue', 0);
        const job = JSON.parse(raw);
        await processJob(job, redis, config, log, fetchFn, sleepFn);
      }
    },
    processJob: (job) => processJob(job, redis, config, log, fetchFn, sleepFn),
  };
}

module.exports = { createDispatcher };
```

- [ ] **Step 4: Rodar os testes para confirmar que passam**

```bash
node --test tests/test_api_dispatcher.test.js
```

Saída esperada: `6 tests passed`

- [ ] **Step 5: Rodar todos os testes para garantir nenhuma regressão**

```bash
node --test tests/*.test.js
```

Saída esperada: todos os testes passam (broker_contracts + socket_handlers + session_manager + api_dispatcher).

- [ ] **Step 6: Commit**

```bash
cd ..
git add data_broker/api_dispatcher.js data_broker/tests/test_api_dispatcher.test.js
git commit -m "feat: api_dispatcher with BLPOP loop and exponential backoff"
```

---

## Task 6: http_server.js — POST /api/players

**Files:**
- Modify: `data_broker/http_server.js`

O `createHttpServer` passa a receber `session` como parâmetro. O endpoint `POST /api/players` chama `session.registerPlayers` e retorna `200` com o resultado da validação — nunca `4xx` por falha de validação de e-mail.

- [ ] **Step 1: Substituir o conteúdo de http_server.js**

```js
// data_broker/http_server.js
const http = require('http');

function createHttpServer(session) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'broker' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/players') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_json' }));
          return;
        }

        const player1Email = String(data.player1Email || '');
        const player2Email = String(data.player2Email || '');
        const result = await session.registerPlayers(player1Email, player2Email);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

module.exports = {
  createHttpServer,
};
```

- [ ] **Step 2: Verificar que os testes existentes ainda passam**

```bash
cd data_broker
node --test tests/*.test.js
```

Saída esperada: todos os testes passam (os testes de socket_handlers não instanciam http_server, portanto não são afetados).

- [ ] **Step 3: Commit**

```bash
cd ..
git add data_broker/http_server.js
git commit -m "feat: http_server POST /api/players endpoint"
```

---

## Task 7: socket_handlers.js — injetar session

**Files:**
- Modify: `data_broker/socket_handlers.js`

`createForwardEventHandler` e `registerSocketHandlers` recebem `session` como parâmetro opcional. As chamadas ao session_manager ocorrem dentro do handler de broadcast — apenas para payloads válidos — sem alterar o comportamento de broadcast existente.

- [ ] **Step 1: Substituir o conteúdo de socket_handlers.js**

```js
// data_broker/socket_handlers.js
const { Server } = require('socket.io');
const { ENFORCED_EVENTS, validateEventPayload } = require('./event_contracts');

const BROKER_EVENTS = [
  'blink',
  'eSense',
  'handGesture',
  'raceStarted',
  'hasFinished',
  'gameEvent',
];

function createSocketServer(server, allowedOrigins) {
  return new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });
}

function createForwardEventHandler({ log, socket, event, session }) {
  return (payload) => {
    const validationError = validateEventPayload(event, payload);

    if (validationError !== null) {
      log('warn', 'event_rejected', {
        event,
        socketId: socket.id,
        validationError,
        payload,
      });
      return;
    }

    log('info', 'event_received', {
      event,
      socketId: socket.id,
      payload,
      enforced: ENFORCED_EVENTS.has(event),
    });
    socket.broadcast.emit(event, payload);

    if (session) {
      if (event === 'eSense') {
        session.onEsense(payload).catch((err) =>
          log('error', 'session_esense_error', { err: err.message }),
        );
      } else if (event === 'raceStarted') {
        session.onRaceStarted(payload).catch((err) =>
          log('error', 'session_race_started_error', { err: err.message }),
        );
      } else if (event === 'hasFinished') {
        session.onHasFinished(payload).catch((err) =>
          log('error', 'session_has_finished_error', { err: err.message }),
        );
      }
    }
  };
}

function registerSocketHandlers(io, log, session) {
  io.on('connection', (socket) => {
    log('info', 'client_connected', { socketId: socket.id });

    socket.on('disconnect', (reason) => {
      log('info', 'client_disconnected', { socketId: socket.id, reason });
    });

    for (const event of BROKER_EVENTS) {
      socket.on(event, createForwardEventHandler({ log, socket, event, session }));
    }
  });
}

module.exports = {
  BROKER_EVENTS,
  createForwardEventHandler,
  createSocketServer,
  registerSocketHandlers,
};
```

- [ ] **Step 2: Rodar todos os testes para garantir nenhuma regressão**

Os testes de socket_handlers usam `createForwardEventHandler` sem o campo `session` — isso deve continuar funcionando, pois `session` é opcional.

```bash
cd data_broker
node --test tests/*.test.js
```

Saída esperada: todos os testes passam.

- [ ] **Step 3: Commit**

```bash
cd ..
git add data_broker/socket_handlers.js
git commit -m "feat: socket_handlers inject session manager as side effect"
```

---

## Task 8: index.js — wiring completo

**Files:**
- Modify: `data_broker/index.js`

- [ ] **Step 1: Substituir o conteúdo de index.js**

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
const redis = createRedisClient(config);
const session = createSessionManager(redis, config, log);
const dispatcher = createDispatcher(redis, config, log);
const server = createHttpServer(session);
const io = createSocketServer(server, config.allowedOrigins);

registerSocketHandlers(io, log, session);
dispatcher.start();

server.listen(config.port, () => {
  log('info', 'broker_listening', {
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
});
```

- [ ] **Step 2: Verificar que o broker inicia sem erros (sem Redis real)**

```bash
cd data_broker
REDIS_URL=redis://localhost:9999 node index.js &
sleep 2
kill %1
```

Saída esperada: log `broker_listening` aparece; erros de conexão Redis são esperados (ioredis tenta reconectar automaticamente em background) — **sem crash do processo**.

- [ ] **Step 3: Rodar todos os testes para garantir nenhuma regressão**

```bash
node --test tests/*.test.js
```

Saída esperada: todos os testes passam.

- [ ] **Step 4: Commit**

```bash
cd ..
git add data_broker/index.js
git commit -m "feat: wire redis, session_manager, and api_dispatcher in index.js"
```

---

## Task 9: docker-compose.yml e .env.example

**Files:**
- Modify: `docker-compose.yml`
- Create: `data_broker/.env.example`

- [ ] **Step 1: Adicionar serviço Redis e depends_on ao broker em docker-compose.yml**

Substitua o conteúdo completo de `docker-compose.yml`:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  broker:
    build: ./data_broker
    environment:
      BROKER_PORT: 3000
      REDIS_URL: redis://redis:6379
    ports:
      - "3000:3000"
    depends_on:
      - redis

  simulator-a:
    build: ./eeg_acquisition
    environment:
      ACQ_PORT: 13854
      PACKET_INTERVAL: 1.0
    command: python simulator.py
    ports:
      - "13854:13854"
    profiles: ['sim-local', 'sim-dual']

  simulator-b:
    build: ./eeg_acquisition
    environment:
      ACQ_PORT: 13855
      PACKET_INTERVAL: 1.0
    command: python simulator.py
    ports:
      - "13855:13855"
    profiles: ['sim-local', 'hybrid-local', 'live']

  acquisition-a:
    build: ./eeg_acquisition
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      PLAYER_ID: 1
      ACQ_PORT: 13854
      BROKER_URL: http://broker:3000
      POOR_SIGNAL_LEVEL_THRESHOLD: 0
      SOURCE: real
      EEG_HOST: "host.docker.internal"
    command: python acquisition_service.py
    depends_on:
      - broker
    profiles: ['sim-local', 'sim-dual', 'hybrid-local', 'live']

  acquisition-b:
    build: ./eeg_acquisition
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      PLAYER_ID: 2
      ACQ_PORT: 13855
      BROKER_URL: http://broker:3000
      POOR_SIGNAL_LEVEL_THRESHOLD: 0
      EEG_HOST: simulator-b
      SOURCE: bot
    command: python acquisition_service.py
    depends_on:
      - broker
      - simulator-b
    profiles: ['sim-local', 'hybrid-local', 'live']

  test-client:
    build: ./test_client
    environment:
      BROKER_URL: "http://broker:3000"
    depends_on:
      - broker
```

- [ ] **Step 2: Criar data_broker/.env.example**

```
# data_broker/.env.example
BROKER_PORT=3000
REDIS_URL=redis://redis:6379
API_URL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
DISPATCH_TTL_MS=86400000
DISPATCH_BACKOFF_BASE_MS=1000
DISPATCH_BACKOFF_MAX_MS=60000
```

- [ ] **Step 3: Verificar que docker-compose valida sem erros**

```bash
docker compose config --quiet
```

Saída esperada: sem output (válido) ou listagem dos serviços sem erros.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml data_broker/.env.example
git commit -m "feat: add Redis service to docker-compose and .env.example"
```

---

## Self-Review

### Cobertura da spec

| Seção da spec | Task que implementa |
|---|---|
| 2.1 Novos módulos (redis_client, session_manager, api_dispatcher) | Tasks 2, 3+4, 5 |
| 2.2 Fluxo: POST /api/players → registerPlayers | Tasks 3, 6 |
| 2.2 Fluxo: raceStarted → MULTI/EXEC | Task 3 |
| 2.2 Fluxo: eSense → RPUSH packets | Task 4 |
| 2.2 Fluxo: hasFinished → job → dispatch:queue | Task 4 |
| 2.2 Fluxo: BLPOP → api_dispatcher | Task 5 |
| 2.3 Wiring index.js | Task 8 |
| 3. Modelo Redis (pending:players, session:current, packets, dispatch:queue) | Tasks 3, 4, 5 |
| 4.1 redis_client singleton | Task 2 |
| 4.2 session_manager contrato completo | Tasks 3+4 |
| 4.3 api_dispatcher contrato completo | Task 5 |
| 4.4 POST /api/players | Task 6 |
| 4.5 config novas variáveis | Task 1 |
| 5.1 Validação e-mails (stub, sem endpoint definitivo) | Task 3 |
| 5.2 Headers Supabase no POST | Task 5 |
| 6. Regras de negócio (bot, duplicado, TTL, API_URL ausente) | Tasks 4+5 (testados) |
| 7. Testes node:test (session_manager + api_dispatcher) | Tasks 3+4, 5 |
| 8. docker-compose redis:7-alpine + depends_on | Task 9 |
| 8. .env.example | Task 9 |
