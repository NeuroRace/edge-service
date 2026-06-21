# edge-service

Monorepo pequeno orientado a eventos em tempo real para captura e retransmissao de sinais EEG e gestos.

## Estrutura principal

- `data_broker/`: broker Socket.IO, health check HTTP e validacao de contratos dos eventos principais
- `eeg_acquisition/`: acquisition EEG, simulador TCP e modulos de config/clientes/pipeline/runner
- `gesture_detector/`: detector de gesto por webcam executado fora do Compose principal
- `test_client/`: cliente simples para inspecao manual dos eventos
- `docs/event-contracts.md`: contratos atuais dos eventos e regras aplicadas no broker

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

## Testes

Node:

```powershell
cd data_broker
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
- Eventos `gameEvent`, `raceStarted` e `hasFinished` continuam em passthrough no broker.
