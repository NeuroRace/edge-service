# EEG Persistence & Dispatch — Design Spec

**Data:** 2026-04-03
**Escopo:** `edge-service / data_broker` — backend puro (Redis + session_manager + api_dispatcher)
**Fora de escopo:** UI de controle (cadastro de e-mails, gráficos em tempo real) — sub-projeto separado

---

## 1. Contexto

O broker atual (`data_broker/`) recebe eventos Socket.IO dos acquisition services Python e os retransmite ao jogo via broadcast. Não há persistência. O objetivo desta evolução é:

1. Acumular os pacotes EEG de cada corrida no Redis.
2. Ao final da corrida, construir um payload consolidado por player humano e enviá-lo para uma **Supabase Edge Function**.
3. Garantir entrega mesmo offline (retry com backoff exponencial).
4. Não bloquear o jogo em nenhuma hipótese — o sucesso da corrida é independente da internet.

---

## 2. Arquitetura

### 2.1 Novos módulos

```
data_broker/
├── index.js              ← wiring: inicializa Redis, session_manager, dispatcher
├── config.js             ← + REDIS_URL, API_URL, SUPABASE_URL, SUPABASE_ANON_KEY, tunables
├── http_server.js        ← + POST /api/players
├── socket_handlers.js    ← sem mudança estrutural; session_manager injetado como efeito colateral
│
├── redis_client.js       ← [NOVO] singleton ioredis com reconexão automática
├── session_manager.js    ← [NOVO] ciclo de vida da corrida
└── api_dispatcher.js     ← [NOVO] worker BLPOP com retry/backoff
```

### 2.2 Fluxo de alto nível

```
Operador  → POST /api/players          → http_server → session_manager.registerPlayers()
                                                          ↓ valida emails no Supabase
                                                          ↓ armazena pending:players no Redis

Jogo      → raceStarted                → session_manager.onRaceStarted()
                                          ↓ MULTI/EXEC: move pending:players → session:current
                                          ↓ DEL pending:players

Headsets  → eSense (1Hz, por player)   → session_manager.onEsense()
                                          ↓ se source == "bot": ignora
                                          ↓ senão: RPUSH session:{id}:player:{p}:packets

Jogo      → hasFinished { playerId }   → session_manager.onHasFinished()
                                          ↓ se player é bot: ignora
                                          ↓ lê packets do player
                                          ↓ monta job com payload + expiresAt
                                          ↓ RPUSH dispatch:queue

Background → BLPOP dispatch:queue     → api_dispatcher
                                          ↓ verifica expiresAt
                                          ↓ POST → Supabase Edge Function
                                          ↓ falha: backoff exponencial + re-enfileira
```

### 2.3 Mudança no wiring (`index.js`)

```js
const redis      = createRedisClient(config);
const session    = createSessionManager(redis, config, log);
const dispatcher = createDispatcher(redis, config, log);
const server     = createHttpServer(session, config);
const io         = createSocketServer(server, config.allowedOrigins);

registerSocketHandlers(io, log, session);  // session injetado
dispatcher.start();                        // inicia loop BLPOP
```

---

## 3. Modelo de Dados no Redis

### `pending:players` — Hash

Armazena os emails registrados antes do `raceStarted`.

| Campo | Tipo | Descrição |
|---|---|---|
| `player1Email` | string | Pode ser vazio (player bot) |
| `player1Uuid` | string \| null | UUID retornado pelo Supabase; null se não validado |
| `player2Email` | string | Pode ser vazio (player bot) |
| `player2Uuid` | string \| null | UUID retornado pelo Supabase; null se não validado |

`EXPIRE`: 1h — descartado automaticamente se a corrida não iniciar.

### `session:current` — Hash

Criado atomicamente no `raceStarted` a partir de `pending:players`.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | string (UUID) | Identificador único da sessão |
| `startedAt` | number | Unix timestamp ms |
| `status` | `"active"` | Status da corrida |
| `player1Email` | string | |
| `player1Uuid` | string \| null | |
| `player1IsBot` | `"true"` \| `"false"` | `"true"` se email estava vazio |
| `player2Email` | string | |
| `player2Uuid` | string \| null | |
| `player2IsBot` | `"true"` \| `"false"` | |
| `player1Dispatched` | `"true"` \| ausente | Setado após RPUSH do job do player 1 em `dispatch:queue` |
| `player2Dispatched` | `"true"` \| ausente | Setado após RPUSH do job do player 2 em `dispatch:queue` |

**Regra bot:** `playerIsBot = email === ""`. Qualquer e-mail presente (mesmo sem UUID válido) → `isBot = false`.

**Transição atômica:** `session_manager.onRaceStarted()` lê `pending:players` e executa `MULTI / HMSET session:current / DEL pending:players / EXEC`. Se `pending:players` não existir (operador não registrou emails), a sessão inicia com ambos os players como bot.

### `session:{id}:player:{playerId}:packets` — List

RPUSH a cada evento `eSense` com `source !== "bot"` para o player correspondente. Listas separadas por player evitam filtro no momento do despacho.

Cada elemento é o objeto `eSense` serializado em JSON (campos: `player`, `attention`, `meditation`, `eegPower`, `poorSignalLevel`, `status`, `source`, `timeStamp`).

### `dispatch:queue` — List

Fila de jobs de envio. RPUSH ao receber `hasFinished` para player humano. Consumida via `BLPOP` pelo dispatcher.

**Estrutura de um job:**

```json
{
  "jobId": "<uuid-v4>",
  "playerId": 1,
  "sessionId": "<uuid-v4>",
  "expiresAt": 1234654350000,
  "attempts": 0,
  "payload": {
    "email": "player1@example.com",
    "playerUuid": "<uuid-supabase-ou-null>",
    "startedAt": 1234567890000,
    "finishedAt": 1234567950000,
    "packets": [
      {
        "player": 1,
        "attention": 80,
        "meditation": 55,
        "eegPower": { "delta": 123, "theta": 456 },
        "poorSignalLevel": 0,
        "status": "ok",
        "source": "real",
        "timeStamp": 1234567891000
      }
    ]
  }
}
```

**TTL:** gerenciado pelo campo `expiresAt` dentro do JSON (`enqueuedAt + DISPATCH_TTL_MS`). O dispatcher verifica antes de processar; se `Date.now() > expiresAt`, descarta e loga. Redis não suporta TTL por item em Lists.

---

## 4. Contratos de Módulos

### 4.1 `redis_client.js`

```js
createRedisClient(config) → ioredis instance
```

- Conecta em `config.redisUrl`
- Reconexão automática habilitada (padrão ioredis)
- Exportado como singleton — compartilhado entre `session_manager` e `api_dispatcher`

### 4.2 `session_manager.js`

```js
createSessionManager(redis, config, log) → {
  registerPlayers(player1Email, player2Email) → Promise<{ player1, player2 }>
  onRaceStarted(payload)   → Promise<void>
  onEsense(payload)        → Promise<void>
  onHasFinished(payload)   → Promise<void>
}
```

**`registerPlayers`:**
1. Para cada e-mail não vazio, consulta Supabase (`GET /rest/v1/...` ou endpoint próprio) para obter o UUID do usuário.
2. Armazena em `pending:players` com `EXPIRE 3600`.
3. Retorna resultado da validação para o `http_server` responder ao cliente.

**`onRaceStarted`:**
1. Lê `pending:players` (HGETALL).
2. Determina `isBot` por player (email vazio → bot).
3. Executa `MULTI / HMSET session:current {...} / DEL pending:players / EXEC`.

**`onEsense`:**
1. Se `payload.source === "bot"`: retorna sem persistir.
2. Lê `session:current` para obter `id`.
3. Se nenhuma sessão ativa: descarta e loga.
4. `RPUSH session:{id}:player:{payload.player}:packets JSON.stringify(payload)`.

**`onHasFinished`:**
1. Lê `session:current`.
2. Se `player{N}IsBot === "true"`: retorna sem despachar.
3. Se `player{N}Dispatched === "true"`: evento duplicado — retorna sem despachar, loga.
4. Lê todos os packets: `LRANGE session:{id}:player:{playerId}:packets 0 -1`.
5. Monta job com `expiresAt = Date.now() + config.dispatchTtlMs`.
6. `RPUSH dispatch:queue JSON.stringify(job)`.
7. `HSET session:current player{N}Dispatched "true"`.
8. Loga job enfileirado.

### 4.3 `api_dispatcher.js`

```js
createDispatcher(redis, config, log) → { start() }
```

**Loop (`start`):**

```
loop:
  [_, raw] ← BLPOP "dispatch:queue" 0   // bloqueante sem timeout
  job ← JSON.parse(raw)

  se Date.now() > job.expiresAt:
    log warn "job_expired" { jobId }
    continua

  se !config.apiUrl:
    log warn "api_url_not_configured" { jobId }
    continua

  tenta:
    POST config.apiUrl
      headers: { "Content-Type": "application/json",
                 "apikey": config.supabaseAnonKey,
                 "Authorization": "Bearer " + config.supabaseAnonKey }
      body: JSON.stringify(job.payload)
    
    se resposta OK:
      log info "dispatch_success" { jobId, playerId, attempts: job.attempts }
      continua

  em caso de falha:
    job.attempts++
    delay = min(config.backoffBaseMs * 2^job.attempts, config.backoffMaxMs)
    aguarda delay ms
    RPUSH "dispatch:queue" JSON.stringify(job)
    log warn "dispatch_retry" { jobId, attempts: job.attempts, delay }
    continua
```

### 4.4 `http_server.js` — novo endpoint

```
POST /api/players
Content-Type: application/json
Body: { "player1Email": string, "player2Email": string }
```

1. Chama `session.registerPlayers(player1Email, player2Email)`.
2. Retorna `200` sempre (falha de validação é warning, não erro):

```json
{
  "player1": { "email": "a@x.com", "uuid": "<uuid-ou-null>", "validated": true },
  "player2": { "email": "",        "uuid": null,             "validated": false }
}
```

### 4.5 `config.js` — novas variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379` | URL do Redis |
| `API_URL` | _(ausente)_ | URL da Supabase Edge Function. Se ausente, dispatcher descarta jobs e loga |
| `SUPABASE_URL` | _(ausente)_ | URL base do projeto Supabase. Se ausente, validação de e-mail é pulada (uuid = null) |
| `SUPABASE_ANON_KEY` | _(ausente)_ | Chave pública Supabase — usada na validação de e-mails e nos headers do POST |
| `DISPATCH_TTL_MS` | `86400000` | TTL dos jobs de despacho (24h em ms) |
| `DISPATCH_BACKOFF_BASE_MS` | `1000` | Base do backoff exponencial (ms) |
| `DISPATCH_BACKOFF_MAX_MS` | `60000` | Teto do backoff exponencial (ms) |

---

## 5. Integração com Supabase

### 5.1 Validação de e-mails (`registerPlayers`)

Consulta a Supabase para verificar se o e-mail existe e obter o UUID do usuário. O endpoint exato e a estratégia de autenticação serão definidos quando a Edge Function for implementada.

**Contrato esperado:** dado um e-mail, retornar `{ uuid: string } | null`.

Se `SUPABASE_URL` ou `SUPABASE_ANON_KEY` não estiverem configurados, a validação é pulada — `uuid = null`, `validated = false`. A corrida não é bloqueada.

### 5.2 Envio do payload pós-corrida (`api_dispatcher`)

POST para a Supabase Edge Function configurada em `API_URL`.

**Headers obrigatórios:**
```
Content-Type: application/json
apikey: <SUPABASE_ANON_KEY>
Authorization: Bearer <SUPABASE_ANON_KEY>
```

**Payload:** estrutura definida na seção 3 (`dispatch:queue` → campo `payload`).

**Contrato de resposta:** HTTP 2xx indica sucesso. Qualquer outro status ou erro de rede → retry com backoff.

> **Ponto de integração pendente:** o contrato exato do payload (campos esperados pela Edge Function) será definido durante a implementação da Edge Function. O `payload` desta spec é a proposta do edge-service — pode ser ajustado na implementação.

---

## 6. Regras de Negócio

| Situação | Comportamento |
|---|---|
| E-mail vazio ao registrar | `playerIsBot = true`; packets não acumulados; sem despacho |
| E-mail presente, UUID não encontrado | `playerIsBot = false`; packets acumulados; despacho com `playerUuid: null` |
| `eSense` com `source: "bot"` | Nunca acumulado, independente de `playerIsBot` |
| `hasFinished` para player bot | Ignorado; sem RPUSH em `dispatch:queue` |
| Dois `hasFinished` para o mesmo player | Segundo evento: session_manager verifica se job já foi enfileirado (via flag em `session:current`) e ignora duplicata |
| API offline no momento do `hasFinished` | Job enfileirado normalmente; dispatcher retenta em background |
| `API_URL` ausente | Dispatcher descarta jobs e loga `api_url_not_configured`; sem erro fatal |
| Job com `expiresAt` no passado | Descartado pelo dispatcher com log `job_expired` |

---

## 7. Estratégia de Testes

Padrão do projeto: `node:test` + `node:assert/strict`. Sem dependências externas de teste.

### `test_session_manager.test.js`

Redis fake (objeto com métodos mockados — sem `ioredis` real):

- `registerPlayers` armazena emails + uuids corretamente em `pending:players`
- `onRaceStarted` executa transação MULTI/EXEC: `session:current` criado, `pending:players` removido
- `onRaceStarted` com e-mail vazio: `playerIsBot = "true"` na sessão
- `onEsense` com `source: "bot"` → sem RPUSH
- `onEsense` com `source: "real"` → RPUSH na lista correta do player
- `onHasFinished` para player humano → job enfileirado com `expiresAt` no futuro e payload correto
- `onHasFinished` para player bot → sem RPUSH em `dispatch:queue`
- `onHasFinished` duplicado → segundo evento ignorado

### `test_api_dispatcher.test.js`

Redis fake + `fetch` mockado:

- Job válido → POST executado → loop continua
- Job com `expiresAt` no passado → descartado sem POST
- `API_URL` ausente → job descartado com log, sem erro fatal
- Falha no POST → job re-enfileirado com `attempts` incrementado
- Backoff calculado corretamente: `min(base * 2^attempts, max)`
- Após `backoffMax` atingido, delay não cresce além do teto

---

## 8. Infraestrutura

### `docker-compose.yml` — novo serviço

```yaml
redis:
  image: redis:7-alpine
  ports:
    - "6379:6379"
```

`broker` ganha `depends_on: [redis]`.

### `data_broker/.env.example` (novo)

```
REDIS_URL=redis://redis:6379
API_URL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
DISPATCH_TTL_MS=86400000
DISPATCH_BACKOFF_BASE_MS=1000
DISPATCH_BACKOFF_MAX_MS=60000
```

---

## 9. Fora de Escopo (próximo sub-projeto)

- UI de controle (HTML/JS servida pelo `http_server.js`): cadastro de e-mails, gráficos em tempo real de `attention` e `poorSignalLevel`, exibição do payload enviado
- Implementação da Supabase Edge Function
- Definição final do contrato de payload com a Edge Function
