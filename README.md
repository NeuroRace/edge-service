# edge-service

Monorepo pequeno orientado a eventos em tempo real para captura e retransmissao de sinais EEG e gestos, com persistencia local do resultado da corrida e sincronizacao com a API na nuvem (Supabase).

## Estrutura principal

- `data_broker/`: broker Socket.IO, health check HTTP, validacao de contratos, persistencia local da corrida no Redis (`session_manager.js`) e dispatcher que sincroniza os resultados com a API na nuvem (`api_dispatcher.js`)
- `eeg_acquisition/`: acquisition EEG, simulador TCP e modulos de config/clientes/pipeline/runner
- `gesture_detector/`: detector de gesto por webcam executado fora do Compose principal
- `test_client/`: cliente simples para inspecao manual dos eventos
- `docs/event-contracts.md`: contratos atuais dos eventos e regras aplicadas no broker
- `docs/cloud-sync-contract.md`: contrato de sincronizacao Edge -> Cloud (payload da funcao `ingest-race`)

## Bootstrap local

Stack principal com Docker Compose:

```powershell
docker compose up broker acquisition-a acquisition-b simulator-b test-client
```

Perfis disponiveis em `docker-compose.yml`:
- `sim-local`
- `sim-dual`
- `hybrid-local`
- `live`

O broker depende do servico `redis` (persistencia da corrida) e o Compose o sobe automaticamente via `depends_on`. O envio para a nuvem (dispatcher) e opt-in: so roda quando `API_URL` e `EDGE_INGEST_TOKEN` estao definidos; sem eles o resultado da corrida e persistido em `dispatch:queue` mas nao enviado. Use `data_broker/.env.example` como base para a config local (`data_broker/.env`, gitignored).

## Variaveis operacionais do acquisition

- `PLAYER_ID`
- `ACQ_PORT`
- `EEG_HOST`
- `BROKER_URL`
- `SOURCE`
- `POOR_SIGNAL_LEVEL_THRESHOLD`
- `EEG_CONNECT_TIMEOUT_SECONDS`
- `EEG_READ_TIMEOUT_SECONDS`
- `BROKER_CONNECT_TIMEOUT_SECONDS`
- `ACQ_RETRY_BASE_DELAY_SECONDS`
- `ACQ_RETRY_MAX_DELAY_SECONDS`
- `ACQ_MAX_RECONNECT_ATTEMPTS`

## Variaveis do broker

Base: `data_broker/.env.example` (ver tambem `data_broker/config.js`).

- `BROKER_PORT`
- `BROKER_ALLOWED_ORIGINS`
- `REDIS_URL`

Dispatcher (sincronizacao com a nuvem; `API_URL` setado habilita o dispatcher):

- `API_URL`
- `EDGE_INGEST_TOKEN`
- `DISPATCH_MAX_ATTEMPTS`
- `DISPATCH_BACKOFF_BASE_MS`
- `DISPATCH_BACKOFF_MAX_MS`
- `DISPATCH_BLOCK_TIMEOUT_SEC`
- `DISPATCH_HTTP_TIMEOUT_MS`

## Testes

Node:

```powershell
cd data_broker
npm run validate
```

Os testes de integracao do broker (persistencia e dispatcher) sao pulados quando `REDIS_URL` nao esta definido. Para roda-los, aponte para um Redis real, por exemplo:

```powershell
$env:REDIS_URL = "redis://127.0.0.1:6379"
npm run validate
```

Python:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

Scripts de validacao do repositorio:

```powershell
.\scripts\validate-broker.ps1
.\scripts\validate-acquisition.ps1
.\scripts\validate-all.ps1
```

CI:
- `.github/workflows/ci.yml` valida broker, acquisition e sintaxe do Compose em `push` e `pull_request`

## Observacoes

- O `gesture_detector` continua fora do Docker Compose por decisao deliberada nesta fase.
- Eventos `gameEvent`, `raceStarted` e `hasFinished` continuam em passthrough no broker; `raceStarted`, `hasFinished` e `eSense` tambem alimentam a persistencia local da corrida (hooks fire-and-forget apos o broadcast).
