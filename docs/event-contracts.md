# Event Contracts

Este documento registra os contratos observados atualmente na codebase. O objetivo desta fase e preservar o comportamento externo atual enquanto explicita os payloads e os produtores conhecidos.

## Broker

- Runtime: Node.js + Socket.IO
- Entry point: `data_broker/index.js`
- Porta padrao: `3000`
- Health check HTTP: `GET /health`
- Eventos repassados sem alteracao: `blink`, `eSense`, `handGesture`, `raceStarted`, `hasFinished`, `gameEvent`

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
