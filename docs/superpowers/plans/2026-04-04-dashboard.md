# Dashboard NeuroRace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar uma Dashboard HTML servida pelo `data_broker` que permita registrar jogadores antes da corrida e monitorar dados EEG e status de dispatch ao vivo.

**Architecture:** HTML único (`dashboard.html`) sem build step, servido via `GET /` no `http_server.js`. O `api_dispatcher.js` recebe um `emitFn` para emitir eventos `dispatchStatus` via Socket.IO. O `session_manager.js` expõe `getCurrentSession()` para detectar sessão ativa ao carregar a página.

**Tech Stack:** Node.js `node:test` (testes), Chart.js 4.x e socket.io-client 4.x via CDN, CSS Dark Pro inline.

---

## Arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `data_broker/session_manager.js` | Modificar | Adicionar `getCurrentSession()` |
| `data_broker/api_dispatcher.js` | Modificar | Adicionar parâmetro `emitFn` (6º); emitir `dispatchStatus` |
| `data_broker/http_server.js` | Modificar | Rotas `GET /` e `GET /api/session/current` |
| `data_broker/index.js` | Modificar | Injetar `emitFn` no dispatcher |
| `data_broker/dashboard.html` | Criar | UI completa (HTML + CSS + JS inline) |
| `data_broker/tests/test_session_manager.test.js` | Modificar | Testes para `getCurrentSession` |
| `data_broker/tests/test_api_dispatcher.test.js` | Modificar | Testes para `emitFn` |
| `data_broker/tests/test_http_server.test.js` | Modificar | Testes para novas rotas |

---

## Task 1: getCurrentSession no session_manager

**Files:**
- Modify: `data_broker/session_manager.js`
- Test: `data_broker/tests/test_session_manager.test.js`

- [ ] **Step 1: Adicionar testes ao final de `test_session_manager.test.js`**

```js
test('getCurrentSession retorna status:none quando não há session:current', async () => {
  const redis = createRedisFake();
  const sm = createSessionManager(redis, config, noopLog);

  const result = await sm.getCurrentSession();

  assert.deepEqual(result, { status: 'none' });
});

test('getCurrentSession retorna status e emails quando sessão existe', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = {
    id: 'sess-1',
    status: 'active',
    player1Email: 'p1@x.com',
    player2Email: 'p2@x.com',
  };
  const sm = createSessionManager(redis, config, noopLog);

  const result = await sm.getCurrentSession();

  assert.deepEqual(result, {
    status: 'active',
    player1Email: 'p1@x.com',
    player2Email: 'p2@x.com',
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar falha**

```bash
cd data_broker && node --test tests/test_session_manager.test.js
```

Esperado: FAIL — `sm.getCurrentSession is not a function`

- [ ] **Step 3: Implementar `getCurrentSession` em `session_manager.js`**

Adicionar a função dentro de `createSessionManager`, antes do `return`:

```js
async function getCurrentSession() {
  const s = await redis.hgetall('session:current');
  if (!s || !s.id) return { status: 'none' };
  return { status: s.status, player1Email: s.player1Email, player2Email: s.player2Email };
}
```

Atualizar o `return` final:

```js
return { registerPlayers, onRaceStarted, onEsense, onHasFinished, getCurrentSession };
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

```bash
node --test tests/test_session_manager.test.js
```

Esperado: todos os testes PASS (incluindo os 10 existentes + 2 novos = 12)

- [ ] **Step 5: Commit**

```bash
git add data_broker/session_manager.js data_broker/tests/test_session_manager.test.js
git commit -m "feat: add getCurrentSession to session_manager"
```

---

## Task 2: emitFn no api_dispatcher

**Files:**
- Modify: `data_broker/api_dispatcher.js`
- Test: `data_broker/tests/test_api_dispatcher.test.js`

- [ ] **Step 1: Adicionar testes ao final de `test_api_dispatcher.test.js`**

```js
test('emitFn é chamado com status:sent em dispatch bem-sucedido', async () => {
  const redis = createRedisFake();
  const emitted = [];
  const mockFetch = async () => ({ ok: true });
  const dispatcher = createDispatcher(
    redis,
    config,
    noopLog,
    mockFetch,
    async () => {},
    (event, payload) => emitted.push({ event, payload }),
  );

  await dispatcher.processJob(makeJob());

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'dispatchStatus');
  assert.equal(emitted[0].payload.status, 'sent');
  assert.equal(emitted[0].payload.jobId, 'job-1');
  assert.equal(emitted[0].payload.playerId, 1);
  assert.equal(emitted[0].payload.playerEmail, 'p@x.com');
  assert.equal(emitted[0].payload.attempts, 0);
  assert.ok(typeof emitted[0].payload.timestamp === 'number');
});

test('emitFn é chamado com status:retry em falha de POST', async () => {
  const redis = createRedisFake();
  const emitted = [];
  const mockFetch = async () => { throw new Error('network error'); };
  const dispatcher = createDispatcher(
    redis,
    config,
    noopLog,
    mockFetch,
    async () => {},
    (event, payload) => emitted.push({ event, payload }),
  );

  await dispatcher.processJob(makeJob());

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'retry');
  assert.equal(emitted[0].payload.attempts, 1);
  assert.equal(emitted[0].payload.playerEmail, 'p@x.com');
});

test('emitFn é chamado com status:expired em job expirado', async () => {
  const redis = createRedisFake();
  const emitted = [];
  const dispatcher = createDispatcher(
    redis,
    config,
    noopLog,
    async () => {},
    async () => {},
    (event, payload) => emitted.push({ event, payload }),
  );

  await dispatcher.processJob(makeJob({ expiresAt: Date.now() - 1000 }));

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'expired');
  assert.equal(emitted[0].payload.jobId, 'job-1');
  assert.equal(emitted[0].payload.playerEmail, 'p@x.com');
});
```

- [ ] **Step 2: Rodar os testes e confirmar falha**

```bash
node --test tests/test_api_dispatcher.test.js
```

Esperado: FAIL nos 3 novos testes — `emitted.length` é 0

- [ ] **Step 3: Atualizar assinatura de `processJob` e `createDispatcher` em `api_dispatcher.js`**

Substituir a assinatura de `processJob`:

```js
async function processJob(job, redis, config, log, fetchFn, sleepFn, emitFn) {
```

Adicionar `emitFn('dispatchStatus', ...)` no bloco do job expirado (logo após o `log`):

```js
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
```

Adicionar `emitFn('dispatchStatus', ...)` logo após o `log('info', 'dispatch_success', ...)`:

```js
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
```

Adicionar `emitFn('dispatchStatus', ...)` no bloco `catch`, após o `rpush` e antes do `log`:

```js
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
```

Atualizar a assinatura de `createDispatcher` para incluir `emitFn` como 6º parâmetro:

```js
function createDispatcher(
  redis,
  config,
  log,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  emitFn = () => {},
) {
```

Atualizar as duas chamadas internas a `processJob` para passar `emitFn`:

```js
// dentro do loop start():
await processJob(job, redis, config, log, fetchFn, sleepFn, emitFn);

// no objeto retornado:
processJob: (job) => processJob(job, redis, config, log, fetchFn, sleepFn, emitFn),
```

- [ ] **Step 4: Rodar todos os testes do dispatcher**

```bash
node --test tests/test_api_dispatcher.test.js
```

Esperado: todos os 9 testes PASS (6 existentes + 3 novos)

- [ ] **Step 5: Commit**

```bash
git add data_broker/api_dispatcher.js data_broker/tests/test_api_dispatcher.test.js
git commit -m "feat: add emitFn to api_dispatcher for dispatchStatus events"
```

---

## Task 3: Novas rotas no http_server

**Files:**
- Modify: `data_broker/http_server.js`
- Modify: `data_broker/tests/test_http_server.test.js`
- Create: `data_broker/dashboard.html` (placeholder mínimo)

- [ ] **Step 1: Criar placeholder `data_broker/dashboard.html`**

```html
<html><body>dashboard</body></html>
```

Esse arquivo será sobrescrito na Task 5 com a implementação completa. Existe apenas para que o teste de `GET /` passe agora.

- [ ] **Step 2: Adicionar testes ao final de `test_http_server.test.js`**

```js
test('GET / serve dashboard.html com Content-Type text/html e CSP', async () => {
  const session = { getCurrentSession: async () => ({ status: 'none' }) };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: addr.port, path: '/', method: 'GET' },
        (r) => {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.headers['content-security-policy'], 'CSP header deve estar presente');
    assert.ok(res.body.includes('dashboard'), 'body deve conter conteúdo do arquivo');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/session/current retorna status:none quando sem sessão ativa', async () => {
  const session = { getCurrentSession: async () => ({ status: 'none' }) };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'GET', '/api/session/current');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'none' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/session/current retorna sessão ativa com emails', async () => {
  const session = {
    getCurrentSession: async () => ({
      status: 'active',
      player1Email: 'p1@x.com',
      player2Email: 'p2@x.com',
    }),
  };
  const server = createHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'GET', '/api/session/current');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.player1Email, 'p1@x.com');
    assert.equal(res.body.player2Email, 'p2@x.com');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/session/current retorna 503 quando session não configurado', async () => {
  const server = createHttpServer(null);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeRequest(server, 'GET', '/api/session/current');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'session_not_configured');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 3: Rodar os testes e confirmar falha**

```bash
node --test tests/test_http_server.test.js
```

Esperado: FAIL nos 4 novos testes — `404` ou erro de parsing JSON em vez de HTML

- [ ] **Step 4: Implementar rotas em `http_server.js`**

Adicionar `require` de `fs` e `path` no topo do arquivo:

```js
const http = require('http');
const fs = require('fs');
const path = require('path');
```

Adicionar os dois novos blocos de rota **antes** do bloco `POST /api/players` existente (após o bloco `GET /health`):

```js
if (req.method === 'GET' && req.url === '/') {
  const dashboardPath = path.join(__dirname, 'dashboard.html');
  fs.readFile(dashboardPath, 'utf-8', (err, html) => {
    if (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'dashboard_not_found' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdn.socket.io 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    });
    res.end(html);
  });
  return;
}

if (req.method === 'GET' && req.url === '/api/session/current') {
  if (!session) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_not_configured' }));
    return;
  }
  session.getCurrentSession()
    .then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    })
    .catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  return;
}
```

- [ ] **Step 5: Rodar todos os testes do http_server**

```bash
node --test tests/test_http_server.test.js
```

Esperado: todos os 8 testes PASS (4 existentes + 4 novos)

- [ ] **Step 6: Rodar suite completa para garantir que nada quebrou**

```bash
node --test tests/
```

Esperado: todos os 40 testes PASS (34 existentes + 6 novos)

- [ ] **Step 7: Commit**

```bash
git add data_broker/http_server.js data_broker/tests/test_http_server.test.js data_broker/dashboard.html
git commit -m "feat: add GET / and GET /api/session/current routes to http_server"
```

---

## Task 4: Injetar emitFn no index.js

**Files:**
- Modify: `data_broker/index.js`

- [ ] **Step 1: Atualizar a instanciação do dispatcher em `index.js`**

Substituir a linha:

```js
const dispatcher = createDispatcher(redis, config, log);
```

Por:

```js
const emitFn = (event, payload) => io.emit(event, payload);
const dispatcher = createDispatcher(redis, config, log, fetch, undefined, emitFn);
```

> `undefined` preserva o `sleepFn` padrão. `emitFn` ocupa a 6ª posição.

- [ ] **Step 2: Rodar a suite completa**

```bash
node --test tests/
```

Esperado: todos os 40 testes PASS (index.js não tem testes unitários — verificamos regressão)

- [ ] **Step 3: Commit**

```bash
git add data_broker/index.js
git commit -m "feat: wire emitFn into dispatcher for Socket.IO dispatchStatus events"
```

---

## Task 5: dashboard.html — implementação completa

**Files:**
- Overwrite: `data_broker/dashboard.html`

Substituir o placeholder da Task 3 pelo arquivo completo abaixo.

- [ ] **Step 1: Escrever `data_broker/dashboard.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>NeuroRace — Dashboard</title>
  <script src="https://cdn.socket.io/4.8.1/socket.io.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #111827;
      color: #f9fafb;
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      background: #1f2937;
      border-bottom: 1px solid #374151;
      flex-shrink: 0;
    }
    .logo {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 3px;
      text-transform: uppercase;
    }
    .phase-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 99px;
      border: 1px solid;
      letter-spacing: 1px;
    }
    .phase-setup { background: #1a1f35; color: #818cf8; border-color: #6366f133; }
    .phase-race  { background: #05301a; color: #34d399;  border-color: #34d39933; }

    /* Setup form */
    .setup-section {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 14px 24px;
      background: #1f2937;
      border-bottom: 1px solid #374151;
      overflow: hidden;
      max-height: 72px;
      opacity: 1;
      transition: max-height 0.4s ease, opacity 0.3s ease, padding 0.4s ease;
      flex-shrink: 0;
    }
    .setup-section.hidden {
      max-height: 0;
      opacity: 0;
      padding-top: 0;
      padding-bottom: 0;
    }
    .setup-input {
      flex: 1;
      background: #111827;
      border: 1px solid #374151;
      border-radius: 6px;
      padding: 8px 12px;
      color: #f9fafb;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    .setup-input:focus { border-color: #6366f1; }
    .register-btn {
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 8px 20px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.2s;
    }
    .register-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .register-btn:not(:disabled):hover { opacity: 0.85; }
    .feedback { font-size: 12px; min-width: 160px; }
    .feedback.ok  { color: #34d399; }
    .feedback.err { color: #ef4444; }

    /* Main layout */
    .main {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 300px;
      overflow: hidden;
    }

    /* Players area */
    .players-area {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      padding: 20px;
      align-content: start;
      overflow-y: auto;
    }

    /* Player card */
    .player-card {
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 12px;
      padding: 20px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .player-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #9ca3af;
    }

    /* Signal badge */
    .signal-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 99px;
      border: 1px solid;
    }
    .signal-ok      { background: #05301a; color: #34d399; border-color: #34d39933; }
    .signal-check   { background: #2d1f0a; color: #f59e0b; border-color: #f59e0b33; }
    .signal-none    { background: #2d1010; color: #ef4444; border-color: #ef444433; }
    .signal-waiting { background: #1a2333; color: #6b7280; border-color: #37415133; }

    /* Metrics */
    .metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    .metric-value {
      font-size: 32px;
      font-weight: 800;
      line-height: 1;
      margin: 4px 0;
    }
    .metric-unit {
      font-size: 14px;
      color: #6b7280;
      font-weight: 400;
    }
    .metric-label {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #6b7280;
    }
    .progress-track {
      height: 4px;
      background: #374151;
      border-radius: 99px;
      margin-top: 6px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 99px;
      transition: width 0.3s ease;
    }
    .p1-attn-fill  { background: linear-gradient(90deg, #6366f1, #8b5cf6); }
    .p2-attn-fill  { background: linear-gradient(90deg, #f59e0b, #ef4444); }
    .medit-fill    { background: linear-gradient(90deg, #0ea5e9, #22d3ee); }

    /* Chart */
    .chart-label {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #6b7280;
      margin-bottom: 6px;
    }
    .chart-container {
      background: #111827;
      border-radius: 8px;
      padding: 8px;
      height: 80px;
      position: relative;
    }

    /* Dispatch sidebar */
    .dispatch-sidebar {
      background: #1f2937;
      border-left: 1px solid #374151;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sidebar-title {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #6b7280;
      padding: 16px 16px 10px;
      border-bottom: 1px solid #374151;
      flex-shrink: 0;
    }
    .dispatch-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .dispatch-item {
      background: #111827;
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dispatch-icon { width: 16px; text-align: center; flex-shrink: 0; font-size: 12px; }
    .dispatch-info { flex: 1; min-width: 0; }
    .dispatch-job   { color: #9ca3af; font-family: monospace; font-size: 10px; }
    .dispatch-email { color: #6b7280; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dispatch-badge {
      font-size: 10px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .item-sent    .dispatch-badge { color: #34d399; }
    .item-retry   .dispatch-badge { color: #f59e0b; }
    .item-expired .dispatch-badge { color: #ef4444; }

    .empty-queue {
      color: #4b5563;
      font-size: 12px;
      text-align: center;
      padding: 24px 16px;
    }

    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .spinning { display: inline-block; animation: spin 1s linear infinite; }
  </style>
</head>
<body>

<header class="header">
  <span class="logo">NeuroRace</span>
  <span id="phase-badge" class="phase-badge phase-setup">● SETUP</span>
</header>

<div id="setup-section" class="setup-section">
  <input id="p1-email" class="setup-input" type="email" placeholder="Player 1 Email">
  <input id="p2-email" class="setup-input" type="email" placeholder="Player 2 Email">
  <button id="register-btn" class="register-btn" disabled>Registrar Corrida</button>
  <span id="register-feedback" class="feedback"></span>
</div>

<div class="main">
  <div class="players-area">

    <!-- Player 1 -->
    <div class="player-card">
      <div class="card-header">
        <span class="player-label">Player 1</span>
        <span id="p1-signal" class="signal-badge signal-waiting">● AGUARDANDO</span>
      </div>
      <div class="metrics">
        <div>
          <div class="metric-label">Attention</div>
          <div class="metric-value" id="p1-attention">—</div>
          <div class="progress-track">
            <div class="progress-fill p1-attn-fill" id="p1-attention-bar" style="width:0%"></div>
          </div>
        </div>
        <div>
          <div class="metric-label">Meditation</div>
          <div class="metric-value" id="p1-meditation">—</div>
          <div class="progress-track">
            <div class="progress-fill medit-fill" id="p1-meditation-bar" style="width:0%"></div>
          </div>
        </div>
      </div>
      <div class="chart-label">Atenção — tempo real</div>
      <div class="chart-container">
        <canvas id="chart-p1"></canvas>
      </div>
    </div>

    <!-- Player 2 -->
    <div class="player-card">
      <div class="card-header">
        <span class="player-label">Player 2</span>
        <span id="p2-signal" class="signal-badge signal-waiting">● AGUARDANDO</span>
      </div>
      <div class="metrics">
        <div>
          <div class="metric-label">Attention</div>
          <div class="metric-value" id="p2-attention">—</div>
          <div class="progress-track">
            <div class="progress-fill p2-attn-fill" id="p2-attention-bar" style="width:0%"></div>
          </div>
        </div>
        <div>
          <div class="metric-label">Meditation</div>
          <div class="metric-value" id="p2-meditation">—</div>
          <div class="progress-track">
            <div class="progress-fill medit-fill" id="p2-meditation-bar" style="width:0%"></div>
          </div>
        </div>
      </div>
      <div class="chart-label">Atenção — tempo real</div>
      <div class="chart-container">
        <canvas id="chart-p2"></canvas>
      </div>
    </div>

  </div>

  <aside class="dispatch-sidebar">
    <div class="sidebar-title">Dispatch Queue</div>
    <div class="dispatch-list" id="dispatch-list">
      <div class="empty-queue">Nenhum job ainda</div>
    </div>
  </aside>
</div>

<script>
  // ─── Charts ────────────────────────────────────────────────────────────────

  function createChart(canvasId, borderColor) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: new Array(30).fill(''),
        datasets: [{
          data: new Array(30).fill(null),
          borderColor,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false, min: 0, max: 100 },
        },
      },
    });
  }

  const charts = {
    1: createChart('chart-p1', '#6366f1'),
    2: createChart('chart-p2', '#f59e0b'),
  };

  function pushToChart(chart, value) {
    chart.data.datasets[0].data.shift();
    chart.data.datasets[0].data.push(value);
    chart.data.labels.shift();
    chart.data.labels.push('');
    chart.update('none');
  }

  // ─── Signal badge ──────────────────────────────────────────────────────────

  function getSignalState(poorSignalLevel) {
    if (poorSignalLevel === null || poorSignalLevel === undefined) {
      return { text: '● AGUARDANDO', cls: 'signal-waiting' };
    }
    if (poorSignalLevel === 0)   return { text: '● SIGNAL OK',    cls: 'signal-ok' };
    if (poorSignalLevel >= 200)  return { text: '● SEM SINAL',    cls: 'signal-none' };
    return                              { text: '● CHECK HEADSET', cls: 'signal-check' };
  }

  // ─── Player update ─────────────────────────────────────────────────────────

  function updatePlayer(playerNum, payload) {
    const p = playerNum;
    document.getElementById(`p${p}-attention`).innerHTML =
      `${payload.attention}<span class="metric-unit">%</span>`;
    document.getElementById(`p${p}-meditation`).innerHTML =
      `${payload.meditation}<span class="metric-unit">%</span>`;
    document.getElementById(`p${p}-attention-bar`).style.width  = `${payload.attention}%`;
    document.getElementById(`p${p}-meditation-bar`).style.width = `${payload.meditation}%`;

    const signal = getSignalState(payload.poorSignalLevel);
    const badge  = document.getElementById(`p${p}-signal`);
    badge.textContent = signal.text;
    badge.className   = `signal-badge ${signal.cls}`;

    pushToChart(charts[p], payload.attention);
  }

  // ─── Phase transition ──────────────────────────────────────────────────────

  function enterRacePhase() {
    document.getElementById('setup-section').classList.add('hidden');
    const badge = document.getElementById('phase-badge');
    badge.textContent = '● RACE';
    badge.className   = 'phase-badge phase-race';
  }

  // ─── Dispatch queue ────────────────────────────────────────────────────────

  const jobsMap = new Map();

  function renderDispatch() {
    const list = document.getElementById('dispatch-list');
    const jobs = Array.from(jobsMap.values()).slice(-20).reverse();

    if (jobs.length === 0) {
      list.innerHTML = '<div class="empty-queue">Nenhum job ainda</div>';
      return;
    }

    list.innerHTML = jobs.map((job) => {
      let icon, badge, itemCls;
      if (job.status === 'sent') {
        icon = '✓'; itemCls = 'item-sent'; badge = 'enviado';
      } else if (job.status === 'retry') {
        icon = '<span class="spinning">⟳</span>';
        itemCls = 'item-retry';
        badge = `tentativa ${job.attempts}`;
      } else {
        icon = '✗'; itemCls = 'item-expired'; badge = 'expirado';
      }
      const shortId = job.jobId.slice(0, 8);
      return `
        <div class="dispatch-item ${itemCls}">
          <span class="dispatch-icon">${icon}</span>
          <div class="dispatch-info">
            <div class="dispatch-job">${shortId}…</div>
            <div class="dispatch-email">${job.playerEmail}</div>
          </div>
          <span class="dispatch-badge">${badge}</span>
        </div>`;
    }).join('');
  }

  function handleDispatchStatus(payload) {
    jobsMap.set(payload.jobId, payload);
    renderDispatch();
    if (payload.status === 'sent') {
      setTimeout(() => {
        jobsMap.delete(payload.jobId);
        renderDispatch();
      }, 10000);
    }
  }

  // ─── Registration form ─────────────────────────────────────────────────────

  const p1Input     = document.getElementById('p1-email');
  const p2Input     = document.getElementById('p2-email');
  const registerBtn = document.getElementById('register-btn');
  const feedback    = document.getElementById('register-feedback');

  function syncRegisterBtn() {
    registerBtn.disabled = !p1Input.value.trim() || !p2Input.value.trim();
  }
  p1Input.addEventListener('input', syncRegisterBtn);
  p2Input.addEventListener('input', syncRegisterBtn);

  registerBtn.addEventListener('click', async () => {
    registerBtn.disabled = true;
    feedback.textContent = '';
    try {
      const res = await fetch('/api/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player1Email: p1Input.value.trim(),
          player2Email: p2Input.value.trim(),
        }),
      });
      if (res.ok) {
        feedback.textContent = 'Jogadores registrados!';
        feedback.className   = 'feedback ok';
      } else {
        const data = await res.json();
        feedback.textContent = data.error || 'Erro ao registrar';
        feedback.className   = 'feedback err';
        registerBtn.disabled = false;
      }
    } catch {
      feedback.textContent = 'Erro de conexão';
      feedback.className   = 'feedback err';
      registerBtn.disabled = false;
    }
  });

  // ─── Socket.IO ─────────────────────────────────────────────────────────────

  const socket = io();
  socket.on('eSense',          (payload) => updatePlayer(payload.player, payload));
  socket.on('raceStarted',     ()        => enterRacePhase());
  socket.on('dispatchStatus',  (payload) => handleDispatchStatus(payload));

  // ─── Init: detectar sessão ativa ───────────────────────────────────────────

  async function init() {
    try {
      const res  = await fetch('/api/session/current');
      const data = await res.json();
      if (data.status === 'active') enterRacePhase();
    } catch {
      // sem sessão ativa — permanece na fase SETUP
    }
  }

  init();
</script>
</body>
</html>
```

- [ ] **Step 2: Rodar a suite completa**

```bash
cd data_broker && node --test tests/
```

Esperado: todos os 40 testes PASS (o teste de `GET /` verifica que o body contém a palavra "dashboard", que está no título e no arquivo)

- [ ] **Step 3: Commit**

```bash
git add data_broker/dashboard.html
git commit -m "feat: implement NeuroRace dashboard with real-time EEG monitoring and dispatch queue"
```

---

## Verificação Final

Após todas as tasks, rode o stack completo para verificar manualmente:

```bash
# Na raiz do projeto
docker compose up

# Abra no browser:
# http://localhost:3000
```

Checklist manual:
- [ ] Fase SETUP: formulário visível, botão desabilitado sem emails
- [ ] POST /api/players: feedback verde ao registrar
- [ ] Evento `raceStarted`: formulário some com transição, badge vira `● RACE`
- [ ] Evento `eSense`: métricas, barras e gráfico atualizam ao vivo
- [ ] `poorSignalLevel = 0`: badge verde `● SIGNAL OK`
- [ ] `poorSignalLevel = 50`: badge âmbar `● CHECK HEADSET`
- [ ] `poorSignalLevel = 200`: badge vermelho `● SEM SINAL`
- [ ] Evento `dispatchStatus` status `sent`: aparece na sidebar, some após 10s
- [ ] Evento `dispatchStatus` status `retry`: spinner âmbar, persiste
- [ ] Recarregar página durante corrida: salta direto para fase RACE
