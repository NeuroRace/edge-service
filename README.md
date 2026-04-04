# edge-service

Monorepo orientado a eventos em tempo real para captura, retransmissao e persistencia de sinais EEG e gestos da corrida NeuroRace.

---

## Indice

- [Visao geral](#visao-geral)
- [Estrutura do repositorio](#estrutura-do-repositorio)
- [Arquitetura do broker](#arquitetura-do-broker)
- [Fluxo completo de uma corrida](#fluxo-completo-de-uma-corrida)
- [Contratos de eventos Socket.IO](#contratos-de-eventos-socketio)
- [HTTP API](#http-api)
- [Payload enviado para a Supabase Edge Function](#payload-enviado-para-a-supabase-edge-function)
- [Modelo de dados no Redis](#modelo-de-dados-no-redis)
- [Regras de negocio](#regras-de-negocio)
- [Bootstrap local](#bootstrap-local)
- [Variaveis de ambiente](#variaveis-de-ambiente)
- [Testes](#testes)
- [Observacoes](#observacoes)

---

## Visao geral

O `edge-service` e o backend de tempo real da NeuroRace. Ele recebe sinais EEG dos headsets via acquisition services Python, retransmite os eventos ao jogo via Socket.IO e persiste os dados de cada corrida no Redis para envio posterior a uma Supabase Edge Function.

**Principios de design:**
- O sucesso da corrida e independente da internet — falhas de API nao afetam o jogo
- Offline-first: jobs de despacho sao enfileirados no Redis e retentados em background
- Bots sao transparentes: `source: "bot"` nao gera persistencia nem despacho

---

## Estrutura do repositorio

```
edge-service/
├── data_broker/          # Broker Node.js: Socket.IO + Redis + HTTP API
├── eeg_acquisition/      # Acquisition Python: leitura EEG, simulador TCP
├── gesture_detector/     # Detector de gesto por webcam (fora do Compose)
├── test_client/          # Cliente de inspecao manual de eventos
└── docs/
    ├── event-contracts.md
    └── superpowers/specs/  # Design specs das features
```

---

## Arquitetura do broker

```
data_broker/
├── index.js              # Wiring: monta todos os modulos e inicia o servidor
├── config.js             # Carrega variaveis de ambiente com defaults
├── logger.js             # Logger JSON estruturado
├── redis_client.js       # Singleton ioredis com reconexao automatica
├── session_manager.js    # Ciclo de vida da corrida
├── api_dispatcher.js     # Worker BLPOP: consome dispatch:queue, POST para Supabase
├── http_server.js        # GET /health + POST /api/players
├── socket_handlers.js    # Broadcast de eventos + hooks de persistencia
└── event_contracts.js    # Validacao de payloads
```

**Grafo de dependencias no wiring:**

```
config
  └── redis_client ──────────────────┐
        ├── session_manager ─────────┤──► http_server ──► socket_handlers
        └── api_dispatcher ──────────┘
```

---

## Fluxo completo de uma corrida

### 1. Registro de players (pre-largada)

O operador chama `POST /api/players` com os e-mails dos players. O broker tenta validar cada e-mail no Supabase para obter o UUID do usuario. O resultado e armazenado em `pending:players` no Redis com TTL de 1 hora.

Se `SUPABASE_URL` nao estiver configurado, a validacao e pulada — `uuid: null`, corrida nao bloqueada.

### 2. Inicio da corrida

O jogo emite o evento `raceStarted`. O broker executa uma transacao atomica (MULTI/EXEC):
- Move os dados de `pending:players` para `session:current`
- Remove `pending:players`
- Define `playerIsBot = true` para qualquer player com e-mail vazio

Se `pending:players` nao existir (operador nao registrou e-mails), ambos os players sao tratados como bots.

### 3. Acumulacao de pacotes EEG (durante a corrida)

Os acquisition services emitem `eSense` a 1Hz por player. O broker:
- Valida o payload (contrato obrigatorio)
- Retransmite via broadcast para todos os clientes Socket.IO
- Se `source !== "bot"` e ha sessao ativa: faz RPUSH em `session:{id}:player:{N}:packets`

Pacotes de bots nunca sao persistidos.

### 4. Fim da corrida

O jogo emite `hasFinished` com o `playerId`. Para cada player humano:
1. Le todos os packets acumulados (`LRANGE ... 0 -1`)
2. Monta um job com o payload consolidado e `expiresAt = now + DISPATCH_TTL_MS`
3. Enfileira em `dispatch:queue` via RPUSH
4. Marca `player{N}Dispatched = "true"` em `session:current` (previne duplicatas)

Eventos `hasFinished` duplicados para o mesmo player sao ignorados silenciosamente.

### 5. Despacho para Supabase (background)

O `api_dispatcher` roda um loop BLPOP permanente em background:
1. Consome um job de `dispatch:queue`
2. Verifica se `expiresAt` ainda e valido
3. Faz POST para `API_URL` com os headers Supabase
4. Em caso de falha (rede ou HTTP nao-2xx): incrementa `attempts`, calcula backoff exponencial, aguarda e re-enfileira
5. Se `API_URL` nao estiver configurado: descarta o job e loga `api_url_not_configured`

```
delay = min(DISPATCH_BACKOFF_BASE_MS * 2^attempts, DISPATCH_BACKOFF_MAX_MS)
```

---

## Contratos de eventos Socket.IO

O broker escuta e retransmite os seguintes eventos. Eventos marcados como **validados** tem o payload verificado antes do broadcast — payloads invalidos sao rejeitados e logados.

### `eSense` — validado

Emitido pelos acquisition services a 1Hz por player.

```json
{
  "player": 1,
  "attention": 80,
  "meditation": 55,
  "eegPower": {
    "delta": 123,
    "theta": 456
  },
  "poorSignalLevel": 0,
  "status": "ok",
  "source": "real",
  "timeStamp": 1735689600000
}
```

| Campo | Tipo | Regras |
|---|---|---|
| `player` | number | Obrigatorio, finito |
| `attention` | number | Obrigatorio, finito |
| `meditation` | number | Obrigatorio, finito |
| `eegPower` | object | Obrigatorio |
| `poorSignalLevel` | number \| null \| ausente | Se presente, deve ser finito |
| `status` | string | Um de: `ok`, `poor`, `no-signal`, `unknown` |
| `source` | string | Nao vazio. `"bot"` suprime persistencia |
| `timeStamp` | number | Obrigatorio, finito (Unix ms) |

### `handGesture` — validado

```json
{
  "player": 1,
  "timeStamp": 1735689600000
}
```

| Campo | Tipo | Regras |
|---|---|---|
| `player` | number | Obrigatorio, finito |
| `timeStamp` | number | Obrigatorio, finito (Unix ms) |

### `raceStarted`

Emitido pelo jogo. Aciona a transacao de inicio de sessao no broker. Payload em passthrough (nao validado).

### `hasFinished`

Emitido pelo jogo ao fim de cada player. Aciona o enfileiramento do job de despacho.

```json
{ "playerId": 1 }
```

### `blink`, `gameEvent`

Eventos em passthrough — retransmitidos sem validacao.

---

## HTTP API

### `GET /health`

Health check do broker.

**Resposta:**
```json
{ "status": "ok", "service": "broker" }
```

### `POST /api/players`

Registra os e-mails dos players antes da largada. Deve ser chamado antes de `raceStarted`.

**Request:**
```
Content-Type: application/json
```
```json
{
  "player1Email": "jogador1@exemplo.com",
  "player2Email": "jogador2@exemplo.com"
}
```

Campos ausentes ou nulos sao tratados como string vazia (player bot).

**Response `200`:**
```json
{
  "player1": { "email": "jogador1@exemplo.com", "uuid": "uuid-supabase-ou-null", "validated": true },
  "player2": { "email": "jogador2@exemplo.com", "uuid": null, "validated": false }
}
```

- `validated: true` — e-mail encontrado no Supabase, UUID preenchido
- `validated: false` — e-mail nao encontrado, Supabase offline, ou configuracao ausente. **Nao bloqueia a corrida.**

**Response `400`:** body nao e JSON valido.

**Response `503`:** broker ainda nao inicializado (nao deve ocorrer em condicoes normais).

---

## Payload enviado para a Supabase Edge Function

Um POST por player humano e enviado para `API_URL` ao receber `hasFinished`.

**Headers:**
```
Content-Type: application/json
apikey: <SUPABASE_ANON_KEY>
Authorization: Bearer <SUPABASE_ANON_KEY>
```

**Body:**
```json
{
  "email": "jogador1@exemplo.com",
  "playerUuid": "uuid-supabase-ou-null",
  "startedAt": 1735689600000,
  "finishedAt": 1735689660000,
  "packets": [
    {
      "player": 1,
      "attention": 80,
      "meditation": 55,
      "eegPower": { "delta": 123, "theta": 456 },
      "poorSignalLevel": 0,
      "status": "ok",
      "source": "real",
      "timeStamp": 1735689601000
    }
  ]
}
```

> O contrato exato dos campos esperados pela Edge Function sera definido durante a implementacao da Edge Function. O payload acima e a proposta do edge-service.

---

## Modelo de dados no Redis

### `pending:players` — Hash

Criado pelo `POST /api/players`. TTL de 1 hora.

| Campo | Descricao |
|---|---|
| `player1Email` | E-mail do player 1 (pode ser vazio) |
| `player1Uuid` | UUID Supabase ou string vazia |
| `player2Email` | E-mail do player 2 (pode ser vazio) |
| `player2Uuid` | UUID Supabase ou string vazia |

### `session:current` — Hash

Criado atomicamente no `raceStarted`. Sobrescrito na proxima corrida.

| Campo | Descricao |
|---|---|
| `id` | UUID unico da sessao |
| `startedAt` | Unix timestamp ms (string) |
| `status` | `"active"` |
| `player1Email` / `player2Email` | E-mails dos players |
| `player1Uuid` / `player2Uuid` | UUIDs Supabase ou string vazia |
| `player1IsBot` / `player2IsBot` | `"true"` se e-mail estava vazio |
| `player1Dispatched` / `player2Dispatched` | `"true"` apos job enfileirado |

### `session:{id}:player:{N}:packets` — List

Um elemento por evento `eSense` de player humano. Payload serializado em JSON.

### `dispatch:queue` — List

Fila de jobs de despacho. Cada elemento e um job JSON:

```json
{
  "jobId": "uuid-v4",
  "playerId": 1,
  "sessionId": "uuid-v4",
  "expiresAt": 1735776000000,
  "attempts": 0,
  "payload": { ... }
}
```

O TTL por job e gerenciado pelo campo `expiresAt` (Redis nao suporta TTL por item em List).

---

## Regras de negocio

| Situacao | Comportamento |
|---|---|
| E-mail vazio ao registrar | `playerIsBot = true`; packets nao acumulados; sem despacho |
| E-mail presente, UUID nao encontrado | `playerIsBot = false`; packets acumulados; despacho com `playerUuid: null` |
| `eSense` com `source: "bot"` | Nunca acumulado, independente de `playerIsBot` |
| `hasFinished` para player bot | Ignorado; sem job enfileirado |
| `hasFinished` duplicado para o mesmo player | Segundo evento ignorado (flag `player{N}Dispatched`) |
| API offline no momento do `hasFinished` | Job enfileirado normalmente; dispatcher retenta em background |
| `API_URL` ausente | Dispatcher descarta jobs e loga; sem erro fatal (modo dev) |
| Job com `expiresAt` expirado | Descartado pelo dispatcher com log `job_expired` |
| Redis indisponivel no startup | Broker inicia normalmente; ioredis reconecta em background |

---

## Bootstrap local

```powershell
docker compose up broker redis acquisition-a acquisition-b simulator-b test-client
```

Perfis disponiveis em `docker-compose.yml`:

| Perfil | Descricao |
|---|---|
| `sim-local` | Dois simuladores + dois acquisition + broker + Redis |
| `sim-dual` | Simulador A + dois acquisition + broker + Redis |
| `hybrid-local` | Simulador B + acquisition-B + broker + Redis (acquisition-A aponta para headset real) |
| `live` | Dois acquisition apontando para headsets reais + broker + Redis |

Para configurar o broker, copie o template e preencha as variaveis opcionais:

```powershell
cp data_broker/.env.example data_broker/.env
```

---

## Variaveis de ambiente

### Broker (`data_broker/.env`)

| Variavel | Padrao | Descricao |
|---|---|---|
| `BROKER_PORT` | `3000` | Porta HTTP/Socket.IO |
| `BROKER_ALLOWED_ORIGINS` | localhost:8080, 5173, 8000 | Origins CORS permitidas (comma-separated) |
| `REDIS_URL` | `redis://redis:6379` | URL de conexao ao Redis |
| `API_URL` | _(ausente)_ | URL da Supabase Edge Function. Ausente = descarta jobs e loga |
| `SUPABASE_URL` | _(ausente)_ | URL base do Supabase. Ausente = validacao de e-mail pulada |
| `SUPABASE_ANON_KEY` | _(ausente)_ | Chave publica Supabase (validacao + headers do POST) |
| `DISPATCH_TTL_MS` | `86400000` | TTL dos jobs de despacho em ms (24h) |
| `DISPATCH_BACKOFF_BASE_MS` | `1000` | Base do backoff exponencial em ms |
| `DISPATCH_BACKOFF_MAX_MS` | `60000` | Teto do backoff exponencial em ms |

### Acquisition

| Variavel | Descricao |
|---|---|
| `PLAYER_ID` | ID do player (1 ou 2) |
| `ACQ_PORT` | Porta TCP do headset EEG |
| `EEG_HOST` | Host do headset |
| `BROKER_URL` | URL do broker |
| `SOURCE` | `real` ou `bot` |
| `POOR_SIGNAL_LEVEL_THRESHOLD` | Threshold de sinal fraco |
| `EEG_CONNECT_TIMEOUT_SECONDS` | Timeout de conexao ao headset |
| `EEG_READ_TIMEOUT_SECONDS` | Timeout de leitura |
| `BROKER_CONNECT_TIMEOUT_SECONDS` | Timeout de conexao ao broker |
| `ACQ_RETRY_BASE_DELAY_SECONDS` | Base do backoff de reconexao |
| `ACQ_RETRY_MAX_DELAY_SECONDS` | Teto do backoff de reconexao |
| `ACQ_MAX_RECONNECT_ATTEMPTS` | Max tentativas (0 = ilimitado) |

---

## Testes

Node (34 testes):

```powershell
cd data_broker
npm test
```

Python:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

---

## Observacoes

- O `gesture_detector` continua fora do Docker Compose por decisao deliberada nesta fase.
- A validacao de e-mails via Supabase e um stub enquanto a Edge Function nao for implementada — o endpoint exato sera definido nessa etapa.
- O contrato do payload enviado para a Edge Function pode ser ajustado durante a implementacao dela.
- A UI de controle (cadastro de e-mails pre-corrida, graficos em tempo real, exibicao do payload enviado) e um sub-projeto separado ainda nao implementado.
