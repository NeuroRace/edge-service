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
- Comandos do painel para o jogo (NEU-158): `startRace`, `stopRace`. Repassados **so** quando quem envia se apresentou com `auth.role = 'panel'`; de qualquer outro papel sao recusados com `warn command_rejected_not_panel` e contados em `rejectedEvents`. Payload que o painel manda (NEU-140, formato do jogo combinado com o Thiago em 20/10): `startRace` `{ startRace: true, gameMode: 'player' | 'bot' }` (`bot` = P1 humano contra o bot no P2; dois Bot vao como `player`) e `stopRace` `{}`. O painel nao espera `gameHello`: o Largar so confere se ha jogo conectado (`game.connections > 0` no `/api/status`)
- Eventos validados no broker nesta fase: `eSense`, `handGesture`
- Contato (NEU-160): os campos `player1Email`/`player2Email` (e o `email` do vincular) aceitam **e-mail ou celular**. Tem `@` = e-mail; só números (com espaço, ponto, traço, parênteses ou `+`) = celular brasileiro com DDD, guardado como `+55DDD9XXXXXXXX` no mesmo campo do Redis (`player{N}Email`, sem chave nova). Celular inválido -> `400 { error: 'invalid_phone', field }`; fora isso, igual ao e-mail. Regra única em `public/ops_state.js` (`parseContact`). No histórico e em "Não subiram" o celular sai mascarado: `(11) *****-4321`
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
  - NEU-86: o `gestureStatus` pode levar tambem `camera` (indice em uso, numero) e `cameraError` (texto da ultima troca que falhou, ou `null`). Os dois sao opcionais: detector antigo nao manda.

## Comandos do broker para as pecas (NEU-86)

O broker manda, so para a peca daquele jogador:

| Evento | Para | Corpo | Quando |
| -- | -- | -- | -- |
| `setSource` | `acquisition-pN` | `{ "source": "neurosky" \| "bot" }` | na conexao (sempre) e quando o operador troca |
| `setCamera` | `gesture-pN` | `{ "camera": 0 \| 1 \| 2 }` | na conexao (so se houver escolha guardada) e quando o operador troca |

- `neurosky` = o leitor configurado (`EEG_HOST:ACQ_PORT`, rotulo `SOURCE`). `bot` = gerador dentro da acquisition (rotulo `bot`). A acquisition troca sem cair do broker.
- Se a camera nova nao abrir, o detector volta para a anterior e manda o erro no `cameraError`.
- Valor desconhecido e ignorado (log `set_source_ignored` na acquisition). Peca antiga sem o handler ignora em silencio.
- A escolha fica no hash Redis `players:setup` (`p1Source`, `p2Source`, `p1Camera`, `p2Camera`) e aparece em `GET /api/status` como `setup: { "1": { "source", "camera" }, "2": { ... } }` (`camera` = `null` sem escolha).
- Rotas (exigem `Content-Type: application/json`, corpo ate 4096 bytes):
  - `POST /api/players/source` com `{ "player": 1|2, "source": "neurosky"|"bot" }`;
  - `POST /api/players/camera` com `{ "player": 1|2, "camera": 0|1|2 }`;
  - respostas: `200 { ok, setup }`, `400` (`invalid_player`, `invalid_source`, `invalid_camera`, `invalid_json`), `409 race_in_progress` (alguem humano correndo, ate 10 min da largada), `413`, `415`.
- **Bot nunca sobe (spec B2):** na largada, o lado com `pNSource = bot` vira bot na sessao (e-mail vazio), seja qual for o `source` dos pacotes. No registro, o e-mail de um lado em Bot e ignorado.

## Sessao da corrida: sem cadastro, vincular e parar (NEU-140, plano B)

- `POST /api/players` aceita `player1NoSignup`/`player2NoSignup` (so `true` booleano vale). Lado NeuroSky com e-mail vazio **sem** `NoSignup` -> `400 missing_contact` com `field`. Lado em Bot ignora os dois.
- `session:current` ganha `playerNKind`: `contact` (vai para a nuvem), `nosignup` (marcado de proposito), `bot` (escolha do painel), `missing` (o jogo largou sem registro). `playerNIsBot` continua = "nao vai para a nuvem" (`false` so para `contact`).
- `status`: `active`, `cancelled` (Parar) ou `expired` (10 min da largada, `RACE_LOCK_MS`; aplicado na primeira leitura). Em sessao fechada, `eSense` e `hasFinished` sao ignorados com log (`esense_ignored_closed_session`, uma vez por sessao; `has_finished_ignored_closed_session`).
- Fechar (Parar/expirar) e vincular sao scripts Lua atomicos (`session_scripts.js`) que conferem o `id` da sessao: um Parar que leu a sessao A nao fecha a B se o jogo largou no meio.
- O `hasFinished` reivindica o lado (`HSETNX playerNDispatched`) **antes** de ler a sessao; depois disso nenhum vinculo grava.
- So `missing` conta como descarte (`/health`, `no_email_registered`). `bot` e `nosignup` logam `has_finished_not_saved`.
- Rotas (JSON obrigatorio, corpo ate 4096 bytes, `413`, `415`):
  - `POST /api/session/link` `{ "player": 1|2, "email", "sessionId"? }` -> `200 { ok, session }` · `400 invalid_player|invalid_email|invalid_json` · `409 no_active_session|not_missing|already_finished|session_changed`. So para lado `missing` antes do `hasFinished` dele;
  - `POST /api/session/stop` `{ "sessionId"? }` -> `200 { ok, sessionId, saved? }` · `409 no_active_session|session_changed`. O que ainda nao chegou nao e gravado; a proxima dupla registrada fica. Lado que ja chegou e ja estava na fila continua la: `saved` (so aparece quando nao e vazio) lista esses lados, e `GET /api/session/current` traz `player1Saved`/`player2Saved` (revisao do #36).
  - `sessionId` (opcional, texto) = a corrida que o painel via. Se o jogo largou outra no meio, a resposta e `409 session_changed` e nada muda (o painel sempre manda).
- `GET /api/session/current` ganha `player1Kind`/`player2Kind` (e `pending.playerNKind`).
- **Limitacao:** o jogo nao manda id de corrida. Um `hasFinished` atrasado que chega **depois da largada seguinte** cai na corrida nova. A solucao (id no `raceStarted`/`hasFinished`) esta na NEU-146.

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
