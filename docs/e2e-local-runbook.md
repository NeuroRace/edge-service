# Runbook — Teste E2E local da corrida (edge → cloud)

Como rodar uma corrida de ponta a ponta **localmente**, sem tocar em produção, usando o
harness produtor de corrida (`data_broker/e2e/race-producer.js`, NEU-70) no lugar do
game-engine + tela de operador.

> **Segurança (leia com atenção — a proteção cobre METADE da esteira).**
> O harness recusa qualquer `--broker` que não seja local (localhost / 127.0.0.1 / ::1) —
> ver `assertLocalTarget` em `data_broker/e2e/race-payloads.js`. **Isso protege só a perna
> edge.** A perna da nuvem (dispatcher → `ingest-race`) é configurada no **broker** via
> `API_URL`/`EDGE_INGEST_TOKEN` e **NÃO é validada pelo harness** — nada aqui impede um
> broker mal-configurado de despachar uma corrida de teste para a nuvem hospedada.
> Portanto: aponte `API_URL` para o Supabase **local** (portas 54321/54322) e confie na
> proteção do `../cloud-backend/scripts/proof-ingest.sh` para o lado cloud. Motivo real:
> já houve uma corrida de teste que vazou para produção. **Nunca** use `API_URL`/token da
> nuvem hospedada num teste.

## O que a esteira exercita

```
harness (game-engine + ops fake) → broker Socket.IO → Redis (dispatch:queue)
        → dispatcher → ingest-race (Supabase LOCAL) → Postgres LOCAL → (web lê)
```

## Pré-requisitos
- Docker (broker + Redis).
- Node 20+ com deps do broker instaladas: `cd data_broker && npm ci`.
- Para a perna da nuvem: Supabase CLI (`supabase`), rodando o `../cloud-backend` local.

---

## Parte 1 — Metade edge (harness → broker → dispatch:queue)  ✅ verificado

Prova que o harness dirige o broker e a corrida é consolidada na fila durável.
Dispatcher fica **desligado** (sem `API_URL`) — os jobs acumulam em `dispatch:queue`.

```bash
# 1. Redis local
docker run --rm -d -p 6379:6379 --name neurorace-e2e-redis redis:7

# 2. Broker local. ATENÇÃO: a porta 3000 pode já estar ocupada nesta máquina
#    (ex.: um app Rails). Use uma porta livre e aponte o harness para ela.
cd data_broker
REDIS_URL=redis://127.0.0.1:6379 BROKER_PORT=34100 node index.js &

# 3. Harness: registra 2 jogadores + emite a corrida
node e2e/race-producer.js --broker http://127.0.0.1:34100 \
     --emails jogador1@ex.com,jogador2@ex.com --points 5

# 4. Conferir a fila (esperado: 2 — um registro por jogador)
docker exec neurorace-e2e-redis redis-cli LLEN dispatch:queue
docker exec neurorace-e2e-redis redis-cli LINDEX dispatch:queue 0   # inspeciona o registro

# 5. Teardown
kill %1 ; docker rm -f neurorace-e2e-redis
```

**Resultado esperado** (observado em 2026-07-02): harness sai com código 0;
`LLEN dispatch:queue = 2`; log do broker mostra `race_started` (player1IsBot/2IsBot=false)
e `race_result_persisted` para os dois jogadores, com o número de `packets` = `--points`.

---

## Parte 2 — Esteira completa até o Supabase local  ⚠️ NÃO verificado neste runbook

> **Honestidade:** os passos abaixo estão descritos por evidência do código/config, mas
> **não foram executados de ponta a ponta** ainda. As partes que costumam morder: a rede
> do Docker até a função local (`host.docker.internal` no macOS) e o casamento do token.
> Confirme rodando; corrija este runbook com o que aprender.

```bash
# A. Nuvem LOCAL (no repo ../cloud-backend)
supabase start
supabase db reset                     # aplica todas as migrations do zero
supabase functions serve ingest-race --env-file supabase/functions/.env
# A função local fica em http://127.0.0.1:54321/functions/v1/ingest-race
# e o Postgres local em postgresql://postgres:postgres@127.0.0.1:54322/postgres

# B. Broker + dispatcher LIGADO, apontando para a função LOCAL
cd ../edge-service/data_broker
REDIS_URL=redis://127.0.0.1:6379 BROKER_PORT=34100 \
  API_URL=http://host.docker.internal:54321/functions/v1/ingest-race \
  EDGE_INGEST_TOKEN=<token do supabase/functions/.env local> \
  node index.js &
# (dentro de container use host.docker.internal; rodando node no host, use 127.0.0.1)

# C. Rodar o harness (igual à Parte 1)
node e2e/race-producer.js --broker http://127.0.0.1:34100 \
     --emails jogador1@ex.com,jogador2@ex.com --points 5

# D. ASSERT no Postgres local
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select race_id, player_slot, source from race_players order by created_at desc limit 5;"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select count(*) from telemetry_points;"
# leaderboard (só aparece com display_name + corrida terminada):
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select * from get_leaderboard('best_time', 10);"
```

Checagens de saúde: `dispatch:deadletter` deve estar **vazia**
(`redis-cli LLEN dispatch:deadletter` = 0) e o log do broker deve mostrar `dispatch_ok`.

---

## Parte 3 — Camada web (opcional, só quando precisar)

A web **só lê** o banco. Não faz parte da esteira do harness. Para verificá-la, semeie o
banco e verifique no browser, **desacoplado** do harness:

1. Semear: `../web-plataform/scripts/seed-demo.mjs` para um e-mail já confirmado.
2. Cadastrar/logar na web com esse e-mail (a RLS liga a corrida ao usuário via o e-mail).
3. Conferir `/dashboard` (dados do próprio usuário) e o ranking (sem PII).

---

## Escopo de teste (decisão, NEU-70)
- **Até o Supabase = o teste que importa** (é onde mora o risco de integração).
- **Até a UI = só quando precisar**, e desacoplado (banco semeado), ou como smoke de
  aceitação manual antes do evento — não como gate automatizado.

## Limitações conhecidas
- `eeg_acquisition/simulator.py` aceita **1 conexão e sai** — o harness gera a própria
  telemetria e **não** depende dele.
- Identidade real dos jogadores é stub (`validateEmail`, NEU-17): `player_uuid` vai `null`.
- Colisão de slot por jogador diferente responde `500` no ingest (NEU-69).
