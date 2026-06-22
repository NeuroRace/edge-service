# Design — Dispatcher de resultados de corrida (NEU-7)

> Data: 2026-06-22 · Repo: `services/edge-service` · Baseline: `main` @ `e5b20aa` (árvore limpa).
>
> Convenção de evidência: **[ev]** = verificado nesta sessão (arquivo:linha, output, HTTP). **[hip]** = hipótese não verificada. **[dec]** = decisão de design (passível de veto).

## 1. Problema e objetivo

O edge-service persiste o resultado de cada corrida numa fila Redis durável (`dispatch:queue`), mas **ninguém consome essa fila** — o dado fica parado. **[ev — `data_broker/` não tem nenhum módulo dispatcher; `session_manager.js:186` faz `rpush('dispatch:queue', ...)` e nada faz pop.]**

Objetivo do NEU-7: um **dispatcher** que consome `dispatch:queue`, mapeia cada registro para o contrato canônico e o entrega à Edge Function `ingest-race` do Supabase, de forma **confiável** (não perde job em crash), **idempotente** (replay não duplica) e **sem regressão** no que já funciona (persistência + broadcast).

**Não-objetivo (fora de escopo, explícito):** dashboard, emits `dispatchStatus` por socket, endpoint de leitura, resolução de `player_uuid` (NEU-17), rate-limiting, batch upload, cap de tamanho de payload. Ver §9.

## 2. Estado verificado (a costura com a API)

- **API viva.** Probe ao vivo: `POST https://wtaulbdkgrnrtbfezaxw.supabase.co/functions/v1/ingest-race` com token inválido → `HTTP 401 {"error":"unauthorized","message":"invalid ingest token"}`. **[ev]**
- **Auth = só `x-edge-ingest-token`** (`verify_jwt=false`). Sem `apikey`/`Authorization`. **[ev — `ingest-race/index.ts:21-25`, `auth.ts`]**
- **Status que a função realmente retorna:** `200 {status:"created"|"duplicate"}`, `401`, `405`, `422 {error:<code>}`, `500 {error:"db_error"}`. **Nunca** emite `400/403/409/429`. Replay idempotente é **`200 {status:"duplicate"}`**, não `409`. **[ev — `index.ts:19,24,29,34,44,48,52,58`]**
- **Registro interno produzido hoje** (`session_manager.js:169-181`) **[ev]:**
  ```
  { jobId, playerId, sessionId, persistedAt,
    payload: { email, playerUuid, startedAt, finishedAt, packets:[<eSense cru>] } }
  ```
  onde cada pacote eSense é `{ player, attention, meditation, eegPower, poorSignalLevel, status, source, timeStamp }`.
- **`timeStamp` é inteiro** (`acquisition_pipeline.py:36` `now_ms = int(time.time()*1000)`) → satisfaz o `isInt` da cloud. **[ev]**
- **Risco de tipo conhecido:** o broker valida eSense com `isFiniteNumber` (`event_contracts.js:19-22,38`) — mais frouxo que o `isInt`+range da cloud (`contract.ts:31-39`). Um float teórico passaria no broker e tomaria `422` na cloud. Tratado como dado inválido → dead-letter (§5). **[ev]**

## 3. Contrato de saída (o que o dispatcher envia)

`POST` com headers `content-type: application/json` + `x-edge-ingest-token: <EDGE_INGEST_TOKEN>`. Body canônico snake_case (validado em `contract.ts`):

```jsonc
{
  "schema_version": "1.0",
  "idempotency_key": "<record.jobId>",        // uuid
  "race_id": "<record.sessionId>",            // uuid
  "player_slot": 1,                           // record.playerId (número 1|2)
  "player_email": "<record.payload.email>",
  "player_uuid": null,                        // record.payload.playerUuid (null hoje)
  "source": "real",                           // constante (só humanos são despachados)
  "started_at": 0,                            // record.payload.startedAt (epoch ms int)
  "finished_at": 0,                           // record.payload.finishedAt (epoch ms int)
  "telemetry_points": [
    { "t": 0, "attention": 0, "meditation": 0,
      "poor_signal_level": 0, "signal_status": "ok", "eeg_power": { } }
  ]
}
```

Mapping por ponto: `t←timeStamp`, `poor_signal_level←poorSignalLevel`, `signal_status←status`, `eeg_power←eegPower` (chaves do dispositivo preservadas); `attention`/`meditation` direto. Descartar `packet.player` e `packet.source` (redundantes). **[ev — tabela §6 do `docs/cloud-sync-contract.md`, conferida contra `contract.ts`]**

## 4. Arquitetura (aditiva — não toca o que existe)

Novos arquivos / mudanças, todas **aditivas**:

| Arquivo | Mudança | Toca código existente? |
|---|---|---|
| `data_broker/dispatch_mapping.js` | **novo** — função pura `toCanonicalBody(record)` | não |
| `data_broker/api_dispatcher.js` | **novo** — `createDispatcher(redis, config, log, fetchFn)` | não |
| `data_broker/redis_client.js` | +`createBlockingRedisClient` (ou opção p/ `maxRetriesPerRequest:null`) | aditivo |
| `data_broker/config.js` | +chaves de dispatcher (§6) | aditivo |
| `data_broker/index.js` | wiring: 2ª conexão + `dispatcher.start()` se `apiUrl` setado | aditivo |
| `data_broker/.env.example` | +`API_URL`, `EDGE_INGEST_TOKEN`, backoff/attempts | aditivo |
| `docker-compose.yml` | broker ganha `API_URL`/`EDGE_INGEST_TOKEN` via interpolação | aditivo |
| `data_broker/tests/*` | unit + integração do dispatcher; FakeRedis ganha `blmove/lrem` | aditivo |

**Garantia de não-regressão [dec]:** o dispatcher **não modifica** `session_manager.js`, `socket_handlers.js`, `http_server.js`, `runtime_state.js`, `event_contracts.js`. O wiring em `index.js` **preserva** as assinaturas atuais `createHttpServer(()=>runtimeState.snapshot(), session, log)` e `registerSocketHandlers(io, log, runtimeState, session)`. **[ev — assinaturas atuais em `index.js:14,17`]** (O `index.js` do PR#4 usava assinaturas antigas e regrediria runtime_state/health — por isso reescrevemos, não portamos.) **[ev — `git show origin/feature/eeg-persistence-dispatch:data_broker/index.js`]**

### 4.1 Conexão Redis dedicada [dec]

O consumo usa comando **bloqueante** (`BLMOVE` com timeout). Numa conexão, comandos são serializados; um `BLMOVE` segurando a conexão **atrasaria os `hset`/`rpush` do `session_manager` durante a corrida** → telemetria atrasada/perdida. **[ev — raciocínio de serialização; `redis_client.js:9` hoje usa 1 conexão `maxRetriesPerRequest:3`]** Logo, o dispatcher usa **2ª conexão dedicada** com `maxRetriesPerRequest:null` (recomendação do ioredis p/ comandos bloqueantes — modo de falha exato **[hip]**, mas o argumento de concorrência por si só já justifica). PR#4 já criava `redisBlocking` mas **não** setava `maxRetriesPerRequest:null`. **[ev]**

## 5. Fluxo e tratamento de falha

### 5.1 Fila confiável (reliable queue) [dec]

Producer faz `rpush` (cauda). Consumer:

1. `BLMOVE dispatch:queue dispatch:processing LEFT RIGHT <timeoutSec>` — move **atomicamente** o job mais antigo para a lista `dispatch:processing`. Se nada chega no timeout, repete (heartbeat). **[ev — producer é `rpush` em `session_manager.js:186` → FIFO pela esquerda]**
2. Processa (mapeia + POST, §5.2).
3. Sucesso/permanente/esgotado → remove o job de `processing` (`LREM dispatch:processing -1 <raw>`). Permanente/esgotado também faz `RPUSH dispatch:deadletter <entry>`.

**Recuperação de crash:** no boot, antes do loop, move tudo de `dispatch:processing` de volta para `dispatch:queue`. Como o consumidor é **único e serial**, `processing` tem no máximo 1 job em voo; um crash entre o POST-ok e o `LREM` causa reenvio — **seguro porque a cloud é idempotente** (`idempotency_key` → `200 duplicate`). Entrega = **at-least-once + cloud idempotente = correto**. **[ev — idempotência em `contract.ts`/`index.ts:48` + handoff §2]**

### 5.2 Classificação de resposta [dec] (aterrada no §2)

| Resultado | Ação |
|---|---|
| `200` (`created` ou `duplicate`) | **sucesso** → `LREM` de processing |
| `4xx` exceto `429` (`400/401/403/405/422`) | **permanente** → dead-letter + log `error` (captura `error`/`message` do corpo) |
| `429`, `5xx`, timeout, erro de rede | **transitório** → retry com backoff (§5.3) |

Classificação **por classe** (defensiva): a função real só emite `401/405/422` no 4xx **[ev §2]**, mas tratamos qualquer 4xx (menos `429`) como permanente caso a função/um proxy evolua. `429` é convencionalmente "retentar mais tarde" → transitório (a função **não** emite `429` hoje, sem rate-limit — handoff §7, mas classificamos certo por robustez). **[dec]**

**Timeout HTTP obrigatório [dec]:** `fetch` não tem timeout por default — um POST travado bloquearia o consumidor único **indefinidamente**. O POST usa `AbortController` com `dispatchHttpTimeoutMs` (§6); abort/timeout conta como falha **transitória** (entra no retry). Sem isto, "timeout → transitório" na tabela seria inalcançável. **[ev — `fetch` global do Node não tem timeout default]**

`401` é permanente-para-o-job mas é **erro de config** (token errado), não de payload. Mitigações: (a) no boot, se `apiUrl` setado e `edgeIngestToken` vazio → log `error` `dispatch_token_missing`; (b) cada `401` loga `error` `dispatch_auth_failed`. Reprocessar a dead-letter após corrigir o token é passo manual de ops (fora do MVP, §9). **[dec — honesto: um token errado dreno todas as corridas para dead-letter; o log alto + boot-check é a defesa pragmática para 1 kiosk]**

### 5.3 Retry [dec]

Backoff exponencial limitado, **in-line** no mesmo job, até `maxAttempts`. Esgotou → dead-letter (`reason: "exhausted"`). **Trade-off honesto:** o backoff in-line bloqueia o consumidor único durante a espera. É **aceitável neste volume** (1 kiosk; **1-2 jobs por corrida** — 1 POST por jogador humano; corridas não concorrem — a próxima não começa enquanto a anterior despacha). O argumento é sobre **número de jobs**, não sobre pacotes/job: cada job carrega ~300-360 pontos (~80-130 KB), mas isso é 1 POST de latência desprezível, não um backlog. **Quando revisitar:** se houver throughput real/backlog, trocar por delay-queue (sorted set por `nextRetryAt`). Não fazer agora = evitar over-engineering. **[ev — volume: corrida de 5-6 min @ 1 Hz ⇒ ~300-360 pacotes/jogador (premissa do dono); handoff §7]**

### 5.4 Dispatcher desabilitado sem `apiUrl` (não-regressão) [dec]

Se `API_URL` não está setado, o dispatcher **não consome** a fila: loga `warn` `dispatcher_disabled` e os jobs **acumulam duravelmente** em `dispatch:queue`. Isso preserva exatamente o comportamento atual (Stage 1) em dev/local sem config de API — **nenhuma regressão**, nenhum dado descartado. (Corrige o bug 5 do PR#4, que descartava o job quando `apiUrl` vazio.) **[ev — `git show ...:data_broker/api_dispatcher.js` linha `if (!config.apiUrl) return;` após o `blpop` destrutivo]**

### 5.5 Registro malformado

Se um item da fila não faz `JSON.parse` ou não tem `jobId`/`playerId`/`sessionId`/`payload` → dead-letter `reason:"malformed_record"`, sem POST. Guarda de robustez (não é re-validação de contrato). **[dec]**

### 5.6 Formato da entrada na dead-letter

`RPUSH dispatch:deadletter` de `{ record, reason, httpStatus?, errorCode?, attempts, failedAt }` — auto-descritivo para diagnóstico/reprocessamento manual. **[dec]**

## 6. Configuração (novas chaves, `config.js`)

| Chave | Env | Default | Nota |
|---|---|---|---|
| `apiUrl` | `API_URL` | `null` | null ⇒ dispatcher desabilitado (§5.4) |
| `edgeIngestToken` | `EDGE_INGEST_TOKEN` | `''` | header `x-edge-ingest-token` |
| `dispatchBackoffBaseMs` | `DISPATCH_BACKOFF_BASE_MS` | `500` | |
| `dispatchBackoffMaxMs` | `DISPATCH_BACKOFF_MAX_MS` | `10000` | |
| `dispatchMaxAttempts` | `DISPATCH_MAX_ATTEMPTS` | `8` | esgotou ⇒ dead-letter |
| `dispatchBlockTimeoutSec` | `DISPATCH_BLOCK_TIMEOUT_SEC` | `5` | timeout do `BLMOVE` |
| `dispatchHttpTimeoutMs` | `DISPATCH_HTTP_TIMEOUT_MS` | `15000` | timeout do POST via `AbortController` (§5.2) |

**Não** adicionar `supabaseUrl`/`supabaseAnonKey` — a auth é só shared-secret; a anon key **não** é usada (correção do PR#4). **[ev — `index.ts:21-25`; PR#4 mandava `apikey`+`Bearer anonKey` → 401 garantido]**

`docker-compose.yml`: broker recebe `API_URL: ${API_URL:-}` e `EDGE_INGEST_TOKEN: ${EDGE_INGEST_TOKEN:-}` (interpolação do host/.env; **segredo não vai para o arquivo commitado**). **[dec]**

> **Gap de segurança a fechar [ev]:** o compose lê `.env` do diretório do compose (raiz `edge-service/`). O `.gitignore` cobre `/data_broker/.env` (linha 9) mas **não** `/.env` na raiz (ver `.gitignore`). Se a interpolação usar um `.env` na raiz, ele **não está ignorado** → risco de commit do token. Mitigar: gitignorar `/.env` **ou** passar o token via variável de ambiente do host (sem arquivo). Decidir no plano.

## 7. Mapping `record` → corpo canônico (módulo puro)

`dispatch_mapping.js` exporta `toCanonicalBody(record)` — função pura, determinística, sem I/O. Constantes embutidas: `schema_version:"1.0"`, `source:"real"`. Renomeações conforme §3. Testável isoladamente. **[dec — separar o mapping do I/O facilita teste e leitura]**

## 8. Testes

**Unit — `dispatch_mapping`:** mapeia todos os campos; pontos aninhados; `player_uuid` null; constantes; descarta `player`/`source` do pacote.

**Unit — `api_dispatcher` (FakeRedis + mock `fetch`):**
- `200 created` → removido de processing, ausente de queue/deadletter.
- `200 duplicate` → tratado como sucesso.
- `422` → dead-letter com `errorCode`, sem retry.
- `401` → dead-letter + log `error`.
- `500`→`200` → retentou e sucedeu.
- `500` sempre → esgota `maxAttempts` → dead-letter `exhausted`.
- erro de rede (throw) → retry.
- boot com itens em `processing` → movidos p/ `queue` (recuperação).
- `apiUrl` ausente → não consome.
- registro malformado → dead-letter `malformed_record`.

FakeRedis ganha `blmove`/`lmove` e `lrem` (hoje tem `rpush/lrange/llen/del/...`). **[ev — `tests/fake_redis.js` lido na investigação]**

**Integração (gated `REDIS_URL`, como os atuais):** Redis real + servidor HTTP mock (node `http`) → caminho completo incl. dead-letter e recuperação. **[ev — padrão já existe em `tests/test_session_integration.test.js`, 2 skipped sem REDIS_URL]**

**CI:** o job broker já roda `npm run validate` com `services: redis` → os novos testes (incl. integração) rodam automaticamente. Sem mudança de CI. **[ev — `.github/workflows/ci.yml` tem redis service + REDIS_URL]**

## 9. Escopo: o que NÃO entra (anti-over-engineering)

- **Dashboard / `dispatchStatus` por socket** — outra issue; corta acoplamento. **[dec]**
- **Validação local de contrato antes do POST** — **revertido** da investigação §E.4: duplicar `contract.ts` viola DRY e arrisca drift; a cloud já retorna `422` com código preciso que capturamos no dead-letter. Reconsiderar só se 422s ficarem comuns. **[dec]**
- **Delay-queue / retry agendado** — in-line basta neste volume (§5.3).
- **Reprocessamento automático da dead-letter** — manual/ops no MVP.
- **`player_uuid` real** — depende de NEU-17; fica `null`.
- **Cap de tamanho de payload** — responsabilidade da cloud (handoff §7). Corrida de 5-6 min @ 1 Hz ⇒ ~300-360 pontos ⇒ **~80-130 KB/POST**, muito abaixo da faixa de MB de um body de Edge Function **[hip — limite exato não verificado nesta sessão]**. Não-issue com margem grande; não duplicar cap no edge. Se a cloud um dia retornar oversize, vira `4xx` permanente → dead-letter (já coberto).
- **Batch upload** — apesar do título da NEU-7 ("Batch Upload"), o contrato é **1 POST por jogador**. Não batchar. **[ev — contrato §1; Linear defasado]**

## 10. Riscos abertos (brutal)

1. **Backoff in-line bloqueia o consumidor** durante retry (§5.3). Mitigado pelo volume; documentado o gatilho p/ revisitar.
2. **`401` dreno tudo p/ dead-letter** num token errado (§5.2). Mitigado por boot-check + log alto; reprocesso manual.
3. **Dead-letter sem auto-reprocesso** — aceitável no MVP; precisa de runbook de ops.
4. **E2E contra a função hospedada escreve em produção** (hoje zerada). Mitigação: rodar E2E local primeiro; contra prod, limpar as linhas de teste depois (precisa do token `sbp_` + SQL/CLI). **[ev — handoff §4/§10]**
5. **Sem endpoint de leitura na cloud** → prova E2E em camadas (§11), não há GET para conferir a linha sem SQL direto. **[ev — handoff §1]**

## 11. Validação ponta-a-ponta (plano, executar com o dono)

Camadas de prova:
- (a) log do dispatcher `dispatch_success http=200 status=created`;
- (b) **replay** do mesmo `jobId` → `200 {status:"duplicate"}` (prova idempotência ponta-a-ponta **sem** ler o banco);
- (c) gold standard: `SELECT count(*)` no Postgres hospedado via Supabase CLI/token (`sbp_`).

Setup: estímulo via stack sim **ou** script socket.io focado (`registerPlayers`→`raceStarted`→`eSense`×N→`hasFinished`) — o script isola o dispatcher e é mais determinístico que depender de hardware. (`docker-compose` sim-local hoje aponta `acquisition-a` p/ `host.docker.internal`, não p/ o simulador — ajuste de setup, não de design.) **[ev — `docker-compose.yml:53`]**

**Acessos necessários (pedir ao Pedro no momento do E2E):**
- `EDGE_INGEST_TOKEN` de prod: está em `cloud-backend/.secret.prod.env` (gitignored, nesta máquina). Fornecer criando `data_broker/.env` com `EDGE_INGEST_TOKEN=<valor>` (já gitignored por `.gitignore:9`), **ou** autorizar leitura do `.secret.prod.env`.
- `sbp_` (Supabase) para a prova (c) e limpeza de prod — efêmero.

## 12. Decisões passíveis de veto (resumo)

1. Fila confiável via `BLMOVE`+`dispatch:processing` + recuperação no boot.
2. Dead-letter `dispatch:deadletter` para 4xx-permanente, esgotamento e malformados.
3. Retry in-line com backoff limitado + `maxAttempts` (não TTL de 24h do PR#4).
4. 2ª conexão Redis dedicada (`maxRetriesPerRequest:null`).
5. Dispatcher desabilitado se `API_URL` ausente (jobs acumulam, sem descarte).
6. **Sem** dashboard/`dispatchStatus`, **sem** validação local de contrato, **sem** batch.
7. Auth só `x-edge-ingest-token` (sem anon key).

Se vetar qualquer um, ajusto antes do plano de implementação.
