# edge-service

Monorepo orientado a eventos em tempo real para captura, retransmissao e persistencia de sinais EEG e gestos.

## Estrutura principal

- `data_broker/`: broker Socket.IO com persistencia Redis, despacho pos-corrida para Supabase e validacao de contratos de eventos
- `eeg_acquisition/`: acquisition EEG, simulador TCP e modulos de config/clientes/pipeline/runner
- `gesture_detector/`: detector de gesto por webcam executado fora do Compose principal
- `test_client/`: cliente simples para inspecao manual dos eventos
- `docs/event-contracts.md`: contratos dos eventos e regras aplicadas no broker
- `docs/superpowers/specs/`: design specs das features implementadas

## Arquitetura do broker

O `data_broker` e composto pelos seguintes modulos:

| Modulo | Responsabilidade |
|---|---|
| `index.js` | Wiring: inicializa Redis, session_manager, dispatcher, http_server, socket_handlers |
| `config.js` | Carrega variaveis de ambiente com defaults |
| `redis_client.js` | Singleton ioredis com reconexao automatica |
| `session_manager.js` | Ciclo de vida da corrida: registerPlayers, onRaceStarted, onEsense, onHasFinished |
| `api_dispatcher.js` | Worker BLPOP com retry por backoff exponencial |
| `http_server.js` | GET /health + POST /api/players |
| `socket_handlers.js` | Broadcast de eventos + hooks de persistencia injetados como efeito colateral |
| `event_contracts.js` | Validacao de payloads eSense e handGesture |
| `logger.js` | Logger JSON estruturado |

## Fluxo de persistencia

```
POST /api/players        → session_manager.registerPlayers()  → pending:players (Redis, TTL 1h)
raceStarted (Socket.IO)  → session_manager.onRaceStarted()    → session:current (Redis, MULTI/EXEC)
eSense 1Hz (Socket.IO)   → session_manager.onEsense()         → session:{id}:player:{n}:packets (Redis List)
hasFinished (Socket.IO)  → session_manager.onHasFinished()    → dispatch:queue (Redis List)
BLPOP dispatch:queue     → api_dispatcher                     → POST Supabase Edge Function (retry + backoff)
```

Players com e-mail vazio sao tratados como bots: packets nao acumulados e sem despacho pos-corrida.

## Bootstrap local

```powershell
docker compose up broker redis acquisition-a acquisition-b simulator-b test-client
```

Perfis disponiveis em `docker-compose.yml`:
- `sim-local`
- `sim-dual`
- `hybrid-local`
- `live`

## Variaveis de ambiente do broker

Copie `data_broker/.env.example` para `data_broker/.env` e preencha:

| Variavel | Padrao | Descricao |
|---|---|---|
| `BROKER_PORT` | `3000` | Porta HTTP/Socket.IO |
| `BROKER_ALLOWED_ORIGINS` | localhost:8080, 5173, 8000 | Origins CORS permitidas |
| `REDIS_URL` | `redis://redis:6379` | URL do Redis |
| `API_URL` | _(ausente)_ | URL da Supabase Edge Function. Se ausente, dispatcher descarta jobs e loga |
| `SUPABASE_URL` | _(ausente)_ | URL base do Supabase. Se ausente, validacao de e-mail e pulada |
| `SUPABASE_ANON_KEY` | _(ausente)_ | Chave publica Supabase |
| `DISPATCH_TTL_MS` | `86400000` | TTL dos jobs de despacho (24h) |
| `DISPATCH_BACKOFF_BASE_MS` | `1000` | Base do backoff exponencial (ms) |
| `DISPATCH_BACKOFF_MAX_MS` | `60000` | Teto do backoff exponencial (ms) |

## Variaveis operacionais do acquisition

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

## Testes

Node:

```powershell
cd data_broker
npm test
```

Python:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

## Observacoes

- O `gesture_detector` continua fora do Docker Compose por decisao deliberada nesta fase.
- A validacao de e-mails via Supabase e um stub enquanto a Edge Function nao for implementada — uuid retorna `null`, corrida nao e bloqueada.
- O sucesso da corrida e independente da internet: falhas no despacho sao retentadas em background ate o TTL expirar.
