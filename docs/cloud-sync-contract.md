# Cloud Sync Contract (NEU-37)

Contrato **canônico** de sincronização Edge → Cloud para os resultados de corrida
(telemetria EEG por jogador). Este documento é a fonte de verdade para a
implementação da Supabase Edge Function e do schema no `cloud-backend`.

> **Status (2026-06-21):** a Edge Function `ingest-race` foi IMPLEMENTADA e DEPLOYADA
> no `cloud-backend` (repo irmão). A **fonte de verdade** do contrato agora é a função
> real + o handoff do `cloud-backend`
> (`inbox/HANDOFF-cloud-backend-ingest-2026-06-21.md`). Este documento foi **alinhado ao
> que está deployado** nos pontos que o Edge consome (endpoint, headers, body, retry). O
> schema Postgres vive nas migrations do `cloud-backend` — este doc não o duplica (§7).

---

## 1. Visão geral do fluxo

```
[Edge: data_broker]                         [Cloud: Supabase]
 hasFinished(player) ──> monta job ──> fila Redis (dispatch:queue)
                                            │
                          dispatcher (BLPOP, retry/backoff)
                                            │  HTTPS POST (1 por jogador humano)
                                            ▼
                              Edge Function `ingest-race`
                                            │  valida token + idempotência
                                            ▼
                              Postgres (races / race_players / telemetry)
```

- **1 POST por jogador humano** ao receber `hasFinished`. Bots (`source: "bot"` ou
  e-mail vazio) **não** são despachados.
- A entrega é **assíncrona e com retry**: a corrida termina sem bloquear no envio;
  o dispatcher reentrega em background.

---

## 2. Endpoint

| Item | Valor |
|---|---|
| Método | `POST` |
| URL | `https://wtaulbdkgrnrtbfezaxw.supabase.co/functions/v1/ingest-race` |
| Content-Type | `application/json` |
| Charset | UTF-8 |

**Headers (conforme deployado):**

```
content-type: application/json
x-edge-ingest-token: <EDGE_INGEST_TOKEN>
```

> A função roda com `verify_jwt=false`, então **NÃO** se envia `apikey` nem
> `Authorization`/anon key. O único fator de auth é o header custom
> `x-edge-ingest-token` (shared-secret, comparado em tempo constante na função).

- Função: `ingest-race` (ACTIVE no projeto Supabase `wtaulbdkgrnrtbfezaxw`).
- **Auth = shared-secret apenas.** A função valida `x-edge-ingest-token` e escreve com
  `service_role` server-side (a `service_role` key nunca sai da Cloud). A anon key
  **não** é fator de segurança e **não** é usada na chamada.
- O valor do `EDGE_INGEST_TOKEN` de produção está em `cloud-backend/.secret.prod.env`
  (gitignored, na máquina onde a função foi deployada) e setado como secret no Supabase.

---

## 3. Request body (schema canônico)

Convenção: **`snake_case`** (alinhado a Postgres/PostgREST e aos nomes citados na
NEU-37: `race_id`, `player_email`, `telemetry_points`). O Edge é responsável pelo
*mapping* (traduzir o formato interno camelCase para este contrato).

```jsonc
{
  "schema_version": "1.0",                 // string, obrigatório
  "idempotency_key": "5f8c...uuid-v4",     // string uuid-v4, obrigatório (= jobId)
  "race_id": "1a2b...uuid-v4",             // string uuid-v4 da sessão/corrida
  "player_slot": 1,                        // int, 1 | 2 (slot do jogador na corrida)
  "player_email": "jogador1@exemplo.com",  // string não-vazia (humano)
  "player_uuid": null,                     // string uuid Supabase ou null (ainda não resolvido)
  "source": "real",                        // enum: "real" | "bot" (sempre "real" aqui)
  "started_at": 1735689600000,             // int, Unix epoch ms (UTC) — início da corrida
  "finished_at": 1735689660000,            // int, Unix epoch ms (UTC) — fim da corrida
  "telemetry_points": [                    // array, pode ser vazio
    {
      "t": 1735689601000,                  // int, Unix epoch ms (UTC) — timestamp da amostra
      "attention": 80,                     // int 0..100
      "meditation": 55,                    // int 0..100
      "poor_signal_level": 0,              // int 0..200, ou null
      "signal_status": "ok",               // enum: "ok" | "poor" | "no-signal" | "unknown"
      "eeg_power": {                       // objeto JSONB opaco; chaves conforme o dispositivo
        "delta": 123, "theta": 456,
        "lowAlpha": 12, "highAlpha": 13,
        "lowBeta": 14, "highBeta": 15,
        "lowGamma": 16, "highGamma": 17
      }
    }
  ]
}
```

### Regras de campo

- **Timestamps**: todos em **Unix epoch milissegundos, UTC** (inteiro). Zero conversão
  no Edge (é o que `Date.now()` e o dispositivo já produzem); a Cloud converte para
  `timestamptz` na inserção (`to_timestamp(ms / 1000.0)`).
- **`idempotency_key`**: é o `jobId` (uuid-v4) do job de despacho. Estável entre
  retentativas do mesmo job (ver §5).
- **`eeg_power`**: blob opaco. Mantém as chaves do dispositivo (NeuroSky:
  `delta, theta, lowAlpha, highAlpha, lowBeta, highBeta, lowGamma, highGamma`). A Cloud
  armazena como `jsonb` sem reescrever chaves.
- **`signal_status`**: mesma enum já validada no broker
  (`data_broker/event_contracts.js`) e produzida por `acquisition_core.signal_status`.
- **`telemetry_points` vazio**: válido (jogador humano sem amostras acumuladas). A Cloud
  persiste a corrida mesmo sem pontos.
- **Contrato lenient (conforme deployado):** a função valida os campos conhecidos
  (tipos + ranges) e **ignora extras**; versionado por `schema_version`.

---

## 4. Respostas e semântica de retry **[decisão]**

| Status | Significado | Ação do dispatcher |
|---|---|---|
| `200` / `201` | Aceito (inclui replay idempotente já processado) | Sucesso; job sai da fila |
| `400`, `401`, `403`, `422` | Rejeição **permanente** (payload/contrato/auth inválidos) | **Não** retentar; mandar para dead-letter e logar `error` |
| `409` | Conflito idempotente (já existe) | Tratar como sucesso |
| `429`, `5xx`, timeout, erro de rede | Falha **transitória** | Retentar com backoff |

- A Cloud deve responder `2xx` para **replays idempotentes** (mesmo `idempotency_key`),
  para que uma retentativa após um sucesso não-confirmado não gere erro nem duplicata.
- Corpo de erro recomendado: `{ "error": "<code>", "message": "<humano>" }`.

> Observação: o dispatcher do PR #4 (`api_dispatcher.js`, não mergeado) **retenta
> qualquer não-2xx igualmente** e não distingue 4xx de 5xx. Alinhar a esta tabela é
> parte da implementação do dispatcher (NEU-7), não deste contrato. Ver §6.

---

## 5. Idempotência (obrigatório)

A entrega é *at-least-once*: o mesmo job pode chegar mais de uma vez (retry após
sucesso não confirmado, reprocessamento). A Edge Function **deve** ser idempotente:

- Chave: `idempotency_key`.
- A Cloud aplica `UNIQUE (idempotency_key)` na tabela de resultados; um segundo POST
  com a mesma chave **não** cria nova linha e responde `2xx`/`409`.

Isso neutraliza a duplicação de dados em retentativas (risco levantado na review do PR #4).

---

## 6. Mapping Edge → Cloud (estado atual × canônico)

A NEU-37 pede explicitamente o *mapping*. Hoje o `session_manager.js` (mergeado no
`main`) monta o registro interno na `dispatch:queue` em camelCase. O dispatcher (NEU-7,
ainda não existe) precisa traduzir para o body canônico. Gap a fechar:

| Canônico (este contrato) | Origem no record interno | Gap |
|---|---|---|
| `schema_version` | — | **faltando** (adicionar constante `"1.0"`) |
| `idempotency_key` | `record.jobId` | renomear |
| `race_id` | `record.sessionId` | renomear |
| `player_slot` | `record.playerId` | renomear |
| `player_email` | `record.payload.email` | renomear |
| `player_uuid` | `record.payload.playerUuid` | renomear |
| `source` | — (sempre humano) | adicionar (`"real"`) |
| `started_at` | `record.payload.startedAt` | ok (já epoch ms) |
| `finished_at` | `record.payload.finishedAt` | ok (já epoch ms) |
| `telemetry_points[]` | `record.payload.packets[]` | renomear + transformar cada item |
| `telemetry_points[].t` | `packet.timeStamp` | renomear |
| `telemetry_points[].attention` | `packet.attention` | ok |
| `telemetry_points[].meditation` | `packet.meditation` | ok |
| `telemetry_points[].poor_signal_level` | `packet.poorSignalLevel` | renomear |
| `telemetry_points[].signal_status` | `packet.status` | renomear |
| `telemetry_points[].eeg_power` | `packet.eegPower` | renomear (chaves internas preservadas) |
| — | `packet.player`, `packet.source` | **remover** (redundantes; já no envelope) |

> O record interno produzido hoje (lido em `session_manager.js`) é:
> `{ jobId, playerId, sessionId, persistedAt, payload:{ email, playerUuid, startedAt, finishedAt, packets:[<eSense cru>] } }`.

---

## 7. Schema Postgres (implementado no cloud-backend)

O schema foi **implementado e aplicado** no `cloud-backend` — este doc **não o duplica**
(evita drift). São **4 tabelas**: `players` (canônico por email normalizado
`lower(trim)`, `user_id` nullable → `auth.users`), `races`, `race_players` (alvo da
idempotência: `unique(idempotency_key)` **e** `unique(race_id, player_slot)`) e
`telemetry_points` (`eeg_power jsonb`).

Fonte de verdade: `cloud-backend/supabase/migrations/`. RLS habilitado, escrita só via
`service_role` (a função usa). **O Edge não precisa conhecer o schema — só o contrato HTTP.**

---

## 8. Segurança / RLS (conforme deployado)

- **RLS habilitado** nas tabelas, **sem policies** (0 policies) — nenhum acesso público;
  só a `service_role` (server-side, dentro da função) escreve.
- A Edge Function valida `x-edge-ingest-token` (comparação em tempo constante) antes de
  qualquer escrita.
- A **anon key não é usada** na ingestão (`verify_jwt=false`).
- A **service_role key** nunca trafega para o Edge; a função a obtém do próprio runtime.
- Invariante de segurança: o vínculo `players.user_id` só acontece na **confirmação** do
  e-mail (`mailer_autoconfirm` deve permanecer `false` em produção).

---

## 9. Decisões tomadas (passíveis de veto)

1. **snake_case** no contrato (vs. camelCase interno do broker). Edge faz o mapping.
2. **Timestamps em epoch ms** (não ISO 8601) — zero conversão no Edge.
3. **`idempotency_key` = `jobId`**, com `UNIQUE` na Cloud.
4. **Auth shared-secret** (`x-edge-ingest-token`, `verify_jwt=false`), service_role
   server-side. Anon key não é usada.
5. **4xx não-retentável / 5xx retentável** (corrige o retry indiscriminado do PR #4).
6. **Função `ingest-race`**, schema Postgres de **4 tabelas** (implementado no cloud-backend).

Se discordar de qualquer um, avise e o contrato é revisado antes da implementação do dispatcher.

---

## 10. Estado: API implementada — o que falta é o lado Edge (NEU-7)

A Edge Function já existe, está **ACTIVE** e deployada (probe `401` ao vivo confirma).
O trabalho restante é **no Edge**, o **dispatcher (NEU-7)**:

- consumir a `dispatch:queue` (o `session_manager.js`, mergeado, já a produz);
- mapear o record interno (camelCase) → este contrato (snake_case, `player_slot`) — §6;
- `POST` na URL da §2 com `x-edge-ingest-token`, aplicando a semântica de retry da §4
  (com fila confiável + dead-letter + cap de tentativas; ver os bugs do PR #4 no handoff).

Acessos (token de prod, Supabase, Linear): pedir ao Pedro / ver
`inbox/HANDOFF-cloud-backend-ingest-2026-06-21.md`.
