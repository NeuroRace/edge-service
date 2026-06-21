# Event Contracts

Este documento registra os contratos observados atualmente na codebase. O objetivo desta fase e preservar o comportamento externo atual enquanto explicita os payloads, os produtores conhecidos e os contratos agora validados no broker.

## Broker

- Runtime: Node.js + Socket.IO
- Entry point: `data_broker/index.js`
- Modulos internos: `config.js`, `logger.js`, `http_server.js`, `socket_handlers.js`, `event_contracts.js`
- Porta padrao: `3000`
- Health check HTTP: `GET /health`
- Health payload atual: `status`, `service`, `uptimeSeconds`, `connections`, `validatedEvents`, `rejectedEvents`
- Eventos repassados sem alteracao: `blink`, `eSense`, `handGesture`, `raceStarted`, `hasFinished`, `gameEvent`
- Eventos validados no broker nesta fase: `eSense`, `handGesture`

## Event: `eSense`

- Produtor confirmado: `eeg_acquisition/acquisition_service.py`
- Consumidor confirmado na codebase: `test_client/test-client.js`
- Payload atual:

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

Regras validadas no broker:
- `player`, `attention`, `meditation` e `timeStamp` devem ser numericos
- `eegPower` deve ser objeto
- `source` deve ser string nao vazia
- `status` deve ser um de `ok`, `poor`, `no-signal`, `unknown`
- `poorSignalLevel` pode ser numero, `null` ou ausente

## Event: `handGesture`

- Produtor confirmado: `gesture_detector/hand_fist_detector.py`
- Consumidor confirmado na codebase: `test_client/test-client.js`
- Payload atual:

```json
{
  "player": 1,
  "timeStamp": 1735689600000
}
```

Regras validadas no broker:
- `player` e `timeStamp` devem ser numericos

## Event: `blink`

- Produtor confirmado: nenhum nesta fase
- Consumidor confirmado na codebase: `test_client/test-client.js`
- Contrato inferido a partir de codigo comentado em `eeg_acquisition/acquisition_service.py`:

```json
{
  "player": 1,
  "blink": 120,
  "timeStamp": 1735689600000
}
```

## Events: `raceStarted`, `hasFinished`, `gameEvent`

- O broker aceita e retransmite estes eventos em `data_broker/index.js`
- Nao foi possivel confirmar pela codebase um produtor ou consumidor versionado
- Nesta fase, o broker continua repassando os payloads exatamente como recebe

## Acquisition resilience

- O acquisition agora tenta reconectar a fonte EEG e o broker em falhas recuperaveis
- O entry point `eeg_acquisition/acquisition_service.py` agora apenas compoe `acquisition_config`, `acquisition_runner`, `acquisition_clients`, `acquisition_pipeline` e `acquisition_core`
- Logs do acquisition agora seguem formato JSON com `timestamp`, `level`, `service`, `message` e metadados do evento
- Timeouts e backoff sao configuraveis por ambiente:
  - `EEG_CONNECT_TIMEOUT_SECONDS`
  - `EEG_READ_TIMEOUT_SECONDS`
  - `BROKER_CONNECT_TIMEOUT_SECONDS`
  - `ACQ_RETRY_BASE_DELAY_SECONDS`
  - `ACQ_RETRY_MAX_DELAY_SECONDS`
  - `ACQ_MAX_RECONNECT_ATTEMPTS` (`0` = ilimitado)
