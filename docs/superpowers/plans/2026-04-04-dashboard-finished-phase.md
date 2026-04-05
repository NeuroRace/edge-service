# Dashboard — Fase FINISHED Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar a fase FINISHED ao dashboard: congelar card do player que terminou, exibir overlay de vencedor, detectar fim de corrida (ambos humanos ou único humano vs bot), e mostrar botão "Nova Corrida".

**Architecture:** Mudança puramente frontend em `dashboard.html`. Nenhuma alteração no backend. Dois flags `playerFinished` e `playerIsBot` controlam o estado local. `init()` já chama `/api/session/current` (retorna `player1Email`, `player2Email`) — usado para detectar bots. O Socket.IO já existe; basta adicionar o listener `hasFinished`.

**Tech Stack:** HTML + CSS + JS inline (sem build step), Socket.IO client 4.8.1 (CDN já incluído)

---

## File Map

| Ação | Arquivo | Responsabilidade |
|------|---------|-----------------|
| Modificar | `data_broker/dashboard.html` | HTML (overlays, botão), JS (estado + handlers), CSS (estilos visuais) |
| Modificar | `data_broker/tests/test_http_server.test.js` | 1 novo teste de presença de elementos no HTML servido |

---

### Task 1: Estado, lógica JS e estrutura HTML

**Files:**
- Modify: `data_broker/tests/test_http_server.test.js`
- Modify: `data_broker/dashboard.html`

- [ ] **Step 1: Escrever o teste (RED)**

Adicionar ao **final** de `data_broker/tests/test_http_server.test.js`:

```js
test('GET / — HTML contém elementos da fase FINISHED', async () => {
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
          r.on('end', () => resolve({ body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.ok(res.body.includes('new-race-btn'),      'deve conter botão nova corrida');
    assert.ok(res.body.includes('winner-overlay'),    'deve conter overlay de vencedor');
    assert.ok(res.body.includes('handleHasFinished'), 'deve conter handler hasFinished');
    assert.ok(res.body.includes('playerFinished'),    'deve conter estado playerFinished');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 2: Rodar para confirmar FAIL**

```bash
cd data_broker && node --test tests/test_http_server.test.js
```

Esperado: 1 falha — os 4 elementos ainda não existem no HTML.

- [ ] **Step 3: Atualizar o header em `dashboard.html`**

Localizar (linha ~265):
```html
<header class="header">
  <span class="logo">NeuroRace</span>
  <span id="phase-badge" class="phase-badge phase-setup">● SETUP</span>
</header>
```

Substituir por:
```html
<header class="header">
  <span class="logo">NeuroRace</span>
  <div style="display:flex;gap:12px;align-items:center">
    <button id="new-race-btn" class="new-race-btn" style="display:none" onclick="location.reload()">↺ Nova Corrida</button>
    <span id="phase-badge" class="phase-badge phase-setup">● SETUP</span>
  </div>
</header>
```

- [ ] **Step 4: Adicionar `id` e overlay ao card Player 1**

Localizar (linha ~281):
```html
    <div class="player-card">
      <div class="card-header">
```

Substituir por:
```html
    <div class="player-card" id="card-p1">
      <div class="winner-overlay" id="winner-p1" style="display:none">
        <span class="winner-trophy">🏆</span>
        <span class="winner-text">FINALIZADO</span>
      </div>
      <div class="card-header">
```

- [ ] **Step 5: Adicionar `id` e overlay ao card Player 2**

Localizar (linha ~309):
```html
    <div class="player-card">
      <div class="card-header">
        <span class="player-label">Player 2</span>
```

Substituir por:
```html
    <div class="player-card" id="card-p2">
      <div class="winner-overlay" id="winner-p2" style="display:none">
        <span class="winner-trophy">🏆</span>
        <span class="winner-text">FINALIZADO</span>
      </div>
      <div class="card-header">
        <span class="player-label">Player 2</span>
```

- [ ] **Step 6: Adicionar estado no bloco `<script>`**

Localizar (linha ~443, após `const jobsMap = new Map();`):
```js
  const jobsMap = new Map();
```

Substituir por:
```js
  const jobsMap = new Map();

  // ─── Finished state ──────────────────────────────────────────────────────────

  const playerFinished = { 1: false, 2: false };
  const playerIsBot    = { 1: false, 2: false };
```

- [ ] **Step 7: Adicionar guard em `updatePlayer`**

Localizar:
```js
  function updatePlayer(playerNum, payload) {
    const p = playerNum;
```

Substituir por:
```js
  function updatePlayer(playerNum, payload) {
    if (playerFinished[playerNum]) return;
    const p = playerNum;
```

- [ ] **Step 8: Adicionar funções `freezeCard`, `checkFullyFinished`, `enterFinishedPhase` e `handleHasFinished`**

Localizar (logo após o fechamento de `enterRacePhase`):
```js
  // ─── Dispatch queue ────────────────────────────────────────────────────────
```

Inserir **antes** dessa linha:
```js
  // ─── Finished phase ───────────────────────────────────────────────────────

  function freezeCard(playerNum) {
    playerFinished[playerNum] = true;
    document.getElementById(`winner-p${playerNum}`).style.display = 'flex';
    document.getElementById(`card-p${playerNum}`).classList.add(`winner-p${playerNum}`);
  }

  function checkFullyFinished() {
    const p1Done = playerFinished[1] || playerIsBot[1];
    const p2Done = playerFinished[2] || playerIsBot[2];
    if (p1Done && p2Done) enterFinishedPhase();
  }

  function enterFinishedPhase() {
    const badge = document.getElementById('phase-badge');
    badge.textContent = '● FINALIZADO';
    badge.className   = 'phase-badge phase-finished';
    document.getElementById('new-race-btn').style.display = 'block';
  }

  function handleHasFinished({ playerId }) {
    freezeCard(playerId);
    checkFullyFinished();
  }

```

- [ ] **Step 9: Registrar listener `hasFinished` no Socket.IO**

Localizar:
```js
  socket.on('eSense',          (payload) => updatePlayer(payload.player, payload));
  socket.on('raceStarted',     ()        => enterRacePhase());
  socket.on('dispatchStatus',  (payload) => handleDispatchStatus(payload));
```

Substituir por:
```js
  socket.on('eSense',          (payload) => updatePlayer(payload.player, payload));
  socket.on('raceStarted',     ()        => enterRacePhase());
  socket.on('dispatchStatus',  (payload) => handleDispatchStatus(payload));
  socket.on('hasFinished',     (payload) => handleHasFinished(payload));
```

- [ ] **Step 10: Atualizar `init()` para popular `playerIsBot`**

Localizar:
```js
  async function init() {
    try {
      const res  = await fetch('/api/session/current');
      const data = await res.json();
      if (data.status === 'active') enterRacePhase();
    } catch {
      // sem sessão ativa — permanece na fase SETUP
    }
  }
```

Substituir por:
```js
  async function init() {
    try {
      const res  = await fetch('/api/session/current');
      const data = await res.json();
      if (data.player1Email !== undefined) {
        playerIsBot[1] = data.player1Email === '';
        playerIsBot[2] = data.player2Email === '';
      }
      if (data.status === 'active') enterRacePhase();
    } catch {
      // sem sessão ativa — permanece na fase SETUP
    }
  }
```

- [ ] **Step 11: Rodar para confirmar PASS**

```bash
cd data_broker && node --test tests/test_http_server.test.js
```

Esperado: todos os testes do arquivo passam (incluindo o novo).

- [ ] **Step 12: Rodar suite completa**

```bash
cd data_broker && npm test
```

Esperado: 53 testes passando (52 + 1 novo), zero regressões.

- [ ] **Step 13: Commit**

```bash
cd data_broker && git add dashboard.html tests/test_http_server.test.js
git commit -m "feat: add FINISHED phase state, freezeCard, handleHasFinished and HTML structure"
```

---

### Task 2: CSS — estilos visuais da fase FINISHED

**Files:**
- Modify: `data_broker/dashboard.html` (apenas bloco `<style>`)

Não há testes novos para CSS — verificação é a suite completa + smoke visual.

- [ ] **Step 1: Adicionar `position: relative` ao `.player-card`**

Localizar:
```css
    .player-card {
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 12px;
      padding: 20px;
    }
```

Substituir por:
```css
    .player-card {
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 12px;
      padding: 20px;
      position: relative;
    }
```

- [ ] **Step 2: Adicionar todos os estilos novos no final do bloco `<style>`, antes do `</style>`**

Localizar:
```css
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .spinning { display: inline-block; animation: spin 1s linear infinite; }
  </style>
```

Substituir por:
```css
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .spinning { display: inline-block; animation: spin 1s linear infinite; }

    /* Phase finished */
    .phase-finished { background: #2d1f0a; color: #f59e0b; border-color: #f59e0b33; }

    /* Nova Corrida button */
    .new-race-btn {
      background: transparent;
      color: #f59e0b;
      border: 1px solid #f59e0b55;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      letter-spacing: 0.5px;
      transition: background 0.2s, border-color 0.2s;
    }
    .new-race-btn:hover {
      background: rgba(245,158,11,0.1);
      border-color: #f59e0b;
    }

    /* Winner card glow */
    .winner-p1 {
      border-color: #6366f1;
      box-shadow: 0 0 24px rgba(99,102,241,0.35), 0 0 8px rgba(99,102,241,0.2);
    }
    .winner-p2 {
      border-color: #f59e0b;
      box-shadow: 0 0 24px rgba(245,158,11,0.35), 0 0 8px rgba(245,158,11,0.2);
    }

    /* Winner overlay */
    .winner-overlay {
      position: absolute;
      inset: 0;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.72);
      border-radius: 12px;
      z-index: 10;
      gap: 8px;
    }
    .winner-trophy {
      font-size: 52px;
      animation: pulse-trophy 1.6s ease-in-out infinite;
      line-height: 1;
    }
    .winner-text {
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 4px;
      color: #f9fafb;
      text-transform: uppercase;
    }

    @keyframes pulse-trophy {
      0%, 100% { transform: scale(1); }
      50%       { transform: scale(1.14); }
    }
  </style>
```

- [ ] **Step 3: Rodar suite completa para confirmar sem regressões**

```bash
cd data_broker && npm test
```

Esperado: 53 testes passando.

- [ ] **Step 4: Smoke test visual (manual, browser)**

Abrir `http://localhost:3000` e no console do browser executar:

```js
// Simular player 1 terminando (card P1 deve congelar com overlay)
handleHasFinished({ playerId: 1 });

// Simular player 2 terminando (fase FINISHED, botão Nova Corrida aparece)
handleHasFinished({ playerId: 2 });
```

Esperado:
- Card P1: overlay preto semitransparente com 🏆 pulsando + "FINALIZADO", borda indigo brilhante
- Card P2: mesmo overlay, borda âmbar brilhante
- Badge header: "● FINALIZADO" âmbar
- Botão "↺ Nova Corrida" visível no header

- [ ] **Step 5: Commit**

```bash
cd data_broker && git add dashboard.html
git commit -m "feat: add FINISHED phase CSS — winner glow, overlay, pulse animation"
```

---

## Self-Review

### Cobertura do spec

| Requisito | Task |
|-----------|------|
| Card congela ao receber `hasFinished` | Task 1 (`updatePlayer` guard + `freezeCard`) |
| Overlay de vencedor no card (🏆 FINALIZADO) | Task 1 (HTML) + Task 2 (CSS) |
| Borda brilhante no card vencedor | Task 2 (`.winner-p1`, `.winner-p2`) |
| Fase FINISHED só entra quando ambos finalizam (ou humano único) | Task 1 (`checkFullyFinished`) |
| Detecção de bot via `player1Email === ''` | Task 1 (`init()` atualizado) |
| Badge header "● FINALIZADO" âmbar | Task 1 (`enterFinishedPhase`) + Task 2 (`.phase-finished`) |
| Botão "Nova Corrida" → `location.reload()` | Task 1 (HTML `onclick`) |
| Sidebar dispatch continua funcionando | Não tocado — zero risco |
| Estilos Dark Pro preservados | Task 2 (paleta consistente com existente) |

Cobertura: 100%.

### Placeholder scan

Nenhum. Todo código está completo.

### Consistência de nomes

- `playerFinished` definido em Task 1 step 6, lido em `updatePlayer` (step 7), `freezeCard` (step 8), `checkFullyFinished` (step 8) → consistente
- `playerIsBot` definido em Task 1 step 6, populado em `init()` (step 10), lido em `checkFullyFinished` (step 8) → consistente
- `handleHasFinished({ playerId })` definido em step 8, registrado em step 9 → consistente
- `winner-p1` / `winner-p2`: classe adicionada por `freezeCard` em step 8, estilos definidos em Task 2 step 2 → consistente
- `winner-overlay` / `winner-trophy` / `winner-text`: IDs/classes usados em step 4/5, estilos em Task 2 step 2 → consistente
- `card-p1` / `card-p2`: IDs adicionados em steps 4/5, lidos por `document.getElementById` em step 8 → consistente
- `new-race-btn`: ID no HTML (step 3), lido por `document.getElementById` em step 8, estilos em Task 2 step 2 → consistente
- `phase-finished`: classe atribuída em `enterFinishedPhase` (step 8), estilo em Task 2 step 2 → consistente
