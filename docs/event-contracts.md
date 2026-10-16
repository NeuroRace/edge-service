# Event Contracts

Este documento registra os contratos observados atualmente na codebase. O objetivo desta fase e preservar o comportamento externo atual enquanto explicita os payloads, os produtores conhecidos e os contratos agora validados no broker.

## Broker

- Runtime: Node.js + Socket.IO
- Entry point: `data_broker/index.js`
- Modulos internos: `config.js`, `logger.js`, `http_server.js`, `socket_handlers.js`, `event_contracts.js`
- Porta padrao: `3000`
- Health check HTTP: `GET /health`
- Tela de operacao: `GET /` (+ `/ops.js`, `/ops_state.js`, `/ops.css`; allowlist, CSP `default-src 'self'`) — NEU-68
- Health payload atual: `status`, `service`, `uptimeSeconds`, `connections`, `validatedEvents`, `rejectedEvents`, `discardedRaces`, `lastDiscardedAt`, `dispatcher` (`{enabled:false, reason}` ou `{enabled, target, lastPollAt, lastSuccessAt, lastErrorAt, inFlightJobId, counts:{queue,processing,retrying,deadletter}}`). `status` e sempre `ok` (D11/NEU-69: o estado do dispatcher informa, nunca derruba o broker)
- Historico do dispatcher: `GET /api/dispatch/history` -> ultimas 20 corridas (`jobId`, `playerId`, `email` mascarado, `status` `sent|deadletter`, `result`, `httpStatus`, `reason`, `attempts`, `at`), mais recente primeiro (`dispatch:history` no Redis)
- Fila de envio (NEU-143): `GET /api/dispatch/overview` -> `counts` (`waiting`, `retrying`, `sending`, `failed`), `lastSentAt`, `failed[]` (`jobId`, `sessionId`, `playerId`, `email` mascarado, `failedAt`, `reason`, `httpStatus`, `errorCode`, `attempts`, `error`, `retryable`), mais recente primeiro; `POST /api/dispatch/requeue` `{jobId}` -> `200 {ok,jobId}` · `404 not_found` · `409 not_retryable` · `415` sem JSON
- Eventos repassados sem alteracao: `blink`, `eSense`, `handGesture`, `raceStarted`, `hasFinished`, `gameEvent`; NEU-158: + `countdownStarted`, `raceStopped`, `gameHello` (avisos do jogo)
- Comandos do painel para o jogo (NEU-158): `startRace`, `stopRace`. Repassados **so** quando quem envia se apresentou com `auth.role = 'panel'`; de qualquer outro papel sao recusados com `warn command_rejected_not_panel` e contados em `rejectedEvents`
- Eventos validados no broker nesta fase: `eSense`, `handGesture`
- Registro (NEU-154): `POST /api/players` `{ player1Email, player2Email }` exige `Content-Type: application/json` (`415` sem ele, CSRF) e corpo que seja **objeto** JSON (`null`, numero, texto ou lista -> `400 invalid_json`); corpo acima de 4096 -> `413`; erro inesperado -> `500`, nunca queda do broker. O mesmo vale para o corpo do requeue.
- Ultimos jogadores (NEU-141): `GET /api/players/recent` -> `[{ contact, lastAt }]` (contato completo; so cadastrados entram, no registro); `POST /api/players/recent/clear` -> `200 {ok:true}` · `415` sem JSON
- Presenca das pecas (NEU-139): `GET /api/status` -> `now` (relogio do broker), `pieces` (`acquisition-p1`, `gesture-p1`, `acquisition-p2`, `gesture-p2`, cada uma com `connected`, `lastEventAt`, `attention`, `poorSignalLevel`, `source`, `handSeen`), `game` (`connections`, `lastGameEvent`), `redis.status`; NEU-142: + `connections` (sockets abertos por papel), `game.recentEvents` (ultimos 5), `pieces[].meta` e `broker` (`version`, `uptimeSeconds`)

## Identificacao das pecas (NEU-139)

Cada cliente nosso se apresenta no connect do Socket.IO com `auth`. O broker usa isso para a faixa de status do painel.

| Cliente | `auth` |
| -- | -- |
| `eeg_acquisition` | `{ role: 'acquisition', player: 1\|2, version, source, eegHost, acqPort }` |
| `gesture_detector` | `{ role: 'gesture', player: 1\|2, version, commit, branch, camera }` |
| painel (`public/ops.js`) | `{ role: 'panel' }` |
| `test_client` | `{ role: 'test-client' }` |
| jogo (Unreal), `e2e/jogo-falso.js` | nenhum hoje; `{ role: 'game', version }` quando o dev do jogo ligar (NEU-146/158) |

- NEU-142: `version` = hash curto (7 hex) do codigo da peca (SHA-256 dos arquivos ordenados, CRLF->LF; `code_version.js`/`code_version.py`). O broker so guarda os metadados `version`, `source`, `eegHost`, `acqPort`, `commit`, `branch`, `camera` (string cortada em 64, numero so se finito). Versoes diferentes entre `acquisition-p1`/`-p2` ou `gesture-p1`/`-p2` viram aviso no painel.
- `auth` ausente ou invalido nao derruba a conexao: o socket vira "nao identificado", e **conexao nao identificada conta como o jogo** (fallback ate a NEU-146).
- NEU-158: `role: 'game'` passou a ser reconhecido, e **as duas formas contam como o jogo** — a sem `auth` (hoje) e a com `role: 'game'` (quando o jogo trocar). Assim a troca pode acontecer sem quebrar o indicador do painel.
- Evento `gameHello` (jogo, ao conectar): `{ "version": "2026-10-20a", "engine": "5.4" }`. Repassado, entra nos eventos recentes do Diagnostico e a `version` fica guardada na conexao do jogo.
- Evento `gestureStatus` (`gesture_detector`, a cada 2 s): `{ "player": 1, "handSeen": true, "timeStamp": 1760000000000 }`. Validado no broker (`handSeen` booleano) e **nunca repassado**: so atualiza a presenca.

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
