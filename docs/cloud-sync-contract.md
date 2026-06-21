# Cloud Sync Contract (NEU-37)

Contrato **canônico** de sincronização Edge → Cloud para os resultados de corrida
(telemetria EEG por jogador). Este documento é a fonte de verdade para a
implementação da Supabase Edge Function e do schema no `cloud-backend`.

> **Status:** proposta finalizada para revisão. Substitui a seção "Payload enviado
> para a Supabase Edge Function" do README do branch `feature/eeg-persistence-dispatch`
> (PR #4), que o próprio autor marcou como provisória. Os pontos marcados
> **[decisão]** foram decididos aqui e podem ser vetados; os marcados
> **[pendente-supabase]** dependem de informação do projeto Supabase para virar config concreta.

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
| URL | `https://<project-ref>.supabase.co/functions/v1/ingest-race` **[pendente-supabase]** |
| Content-Type | `application/json` |
| Charset | UTF-8 |

**Headers de autenticação:**

```
Authorization: Bearer <EDGE_INGEST_TOKEN>
apikey: <SUPABASE_ANON_KEY>
```

- **[decisão]** Nome canônico da função: `ingest-race`.
- **[decisão]** Autenticação por **token dedicado** (`EDGE_INGEST_TOKEN`), não pela
  anon key sozinha. Racional: o broker é um cliente de ingestão confiável; um token
  próprio permite rotação/revogação sem afetar clientes web e não acopla a escrita de
  telemetria à anon key pública. A Edge Function valida o token e escreve com
  `service_role` no servidor (a `service_role` key **nunca** sai da Cloud).
  - Compatível com o MVP: se preferir começar só com a anon key, `EDGE_INGEST_TOKEN`
    pode ser igual à anon key até a função estar madura. **[pendente-supabase]**

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
  "player_id": 1,                          // int, 1 | 2 (slot do jogador na corrida)
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

> Observação: o dispatcher atual (`api_dispatcher.js`) **retenta qualquer não-2xx
> igualmente** e não distingue 4xx de 5xx. Alinhar a esta tabela é parte da
> implementação da NEU-37 (não deste contrato). Ver §7.

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

A NEU-37 pede explicitamente o *mapping*. Hoje o `session_manager.js` monta
`job.payload` assim (campos internos), e o `api_dispatcher.js` envia **apenas**
`job.payload` no body. Gap a fechar na implementação:

| Canônico (este contrato) | Origem no código atual | Gap |
|---|---|---|
| `schema_version` | — | **faltando** (adicionar constante) |
| `idempotency_key` | `job.jobId` | **não vai no body** (está no envelope do job, não no `payload`) |
| `race_id` | `job.sessionId` | **não vai no body** |
| `player_id` | `job.playerId` | **não vai no body** |
| `player_email` | `payload.email` | renomear |
| `player_uuid` | `payload.playerUuid` | renomear |
| `source` | — (sempre humano) | adicionar (`"real"`) |
| `started_at` | `payload.startedAt` | renomear |
| `finished_at` | `payload.finishedAt` | renomear |
| `telemetry_points[]` | `payload.packets[]` | renomear + transformar cada item |
| `telemetry_points[].t` | `packet.timeStamp` | renomear |
| `telemetry_points[].attention` | `packet.attention` | ok |
| `telemetry_points[].meditation` | `packet.meditation` | ok |
| `telemetry_points[].poor_signal_level` | `packet.poorSignalLevel` | renomear |
| `telemetry_points[].signal_status` | `packet.status` | renomear |
| `telemetry_points[].eeg_power` | `packet.eegPower` | renomear (chaves internas preservadas) |
| — | `packet.player`, `packet.source` | **remover** (redundantes; já no envelope) |

**Defeito crítico que este contrato corrige:** o body atual não carrega `race_id`,
`player_id` nem `idempotency_key`, então a Cloud não consegue correlacionar a corrida,
o slot do jogador, nem deduplicar retentativas.

---

## 7. Schema Postgres proposto (cloud-backend) **[decisão / pendente-supabase]**

Proposta mínima normalizada. Ajustável conforme o modelo do `cloud-backend`.

```sql
-- corrida (uma linha por race_id)
create table races (
  race_id      uuid primary key,
  started_at   timestamptz not null,
  finished_at  timestamptz not null,
  created_at   timestamptz not null default now()
);

-- resultado por jogador (alvo da idempotência)
create table race_players (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  uuid not null unique,            -- dedupe de retentativas
  race_id          uuid not null references races(race_id),
  player_id        int  not null check (player_id in (1,2)),
  player_email     text not null,
  player_uuid      uuid,
  source           text not null,
  created_at       timestamptz not null default now(),
  unique (race_id, player_id)
);

-- amostras de telemetria
create table telemetry_points (
  id                 bigint generated always as identity primary key,
  race_player_id     uuid not null references race_players(id) on delete cascade,
  t                  timestamptz not null,
  attention          int,
  meditation         int,
  poor_signal_level  int,
  signal_status      text,
  eeg_power          jsonb
);
```

Alternativa mais simples para MVP: `telemetry_points` como coluna `jsonb` dentro de
`race_players` (sem tabela separada). Decidir conforme volume e necessidade de query.

---

## 8. Segurança / RLS **[decisão / pendente-supabase]**

- **RLS habilitado** em `races`, `race_players`, `telemetry_points` **sem policy de
  escrita pública**. Só a `service_role` (usada server-side pela Edge Function) escreve.
- A Edge Function valida `EDGE_INGEST_TOKEN` antes de qualquer escrita.
- A **anon key** continua sendo o que o broker carrega hoje
  (`SUPABASE_ANON_KEY`), mas **não** deve ter permissão de insert direto nessas tabelas.
- A **service_role key** nunca trafega para o Edge; vive só como secret da Edge Function.

---

## 9. Decisões tomadas (passíveis de veto)

1. **snake_case** no contrato (vs. camelCase interno do broker). Edge faz o mapping.
2. **Timestamps em epoch ms** (não ISO 8601) — zero conversão no Edge.
3. **`idempotency_key` = `jobId`**, com `UNIQUE` na Cloud.
4. **Token de ingestão dedicado** (`EDGE_INGEST_TOKEN`), service_role server-side.
5. **4xx não-retentável / 5xx retentável** (corrige o retry indiscriminado atual).
6. **Função `ingest-race`**, schema Postgres normalizado de 3 tabelas.

Se discordar de qualquer um, me avise e eu reviso o contrato antes da implementação.

---

## 10. O que preciso do Supabase para implementar a Edge Function (próximo passo)

Para sair do contrato (doc) e implementar a função + a config do broker, preciso de:

1. **Project ref** (subdomínio `https://<project-ref>.supabase.co`).
2. **anon key** (`SUPABASE_ANON_KEY`) e **`SUPABASE_URL`**.
3. Decisão de auth: usar `EDGE_INGEST_TOKEN` dedicado? Se sim, definir o valor (secret).
4. Acesso para criar a Edge Function (`supabase functions`) e aplicar o schema SQL
   (ou confirmação de que isso fica com o time do `cloud-backend`).
5. Confirmação do modelo de tabelas (§7) ou o modelo já existente, se houver.

> Não cole secrets no chat público. Quando chegarmos lá, me diga **como** você quer
> fornecer (ex.: eu gero um `.env` local que você preenche, ou você configura os
> secrets direto no Supabase e eu só referencio os nomes das variáveis).
