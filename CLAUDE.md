# CLAUDE.md — edge-service (NeuroRace)

Guia para agentes de IA (e humanos) trabalharem neste repo. Leia antes de mexer.
`AGENTS.md` é symlink deste arquivo (fonte única).

## Princípios (não-negociáveis)
- **Honestidade brutal:** problemas antes de positivos; sem suavizar.
- **Evidência, nunca inferência:** não afirme "pronto/passa/funciona/deployado/mergeado" sem prova (output de comando, SHA+diff, resposta HTTP, caminho de arquivo). Se não pôde verificar, diga "não verifiquei — assumindo X" e pare.
- **Não-regressão:** não declare concluído sem a suíte relevante verde. Mudança aditiva/reversível por padrão.
- **Sem over-engineering:** faça o mínimo que resolve; sinalize o resto, não toque sem ok.
- **PT-BR no chat.**

## O que é
O lado **edge** (kiosk) do NeuroRace: captura EEG/gestos em tempo real, faz broadcast, **persiste o resultado da corrida** localmente (Redis) e o **sincroniza** com a API na nuvem (Supabase). Fluxo: `capturar → broadcast + persistir (dispatch:queue) → dispatcher → cloud`. O par na nuvem é o `../cloud-backend/`; o contrato de escrita edge→cloud está em `docs/cloud-sync-contract.md`.

## Layout
- `data_broker/` — broker Socket.IO (Node 22, CommonJS): validação de contratos (`event_contracts.js`), persistência da corrida (`session_manager.js`), dispatcher para a nuvem (`api_dispatcher.js`), health + API HTTP (`http_server.js`).
- `eeg_acquisition/` — aquisição EEG + simulador (Python).
- `gesture_detector/` — gesto por webcam (fora do Compose). `test_client/` — cliente que só escuta eventos.
- `docs/` — `event-contracts.md`, `cloud-sync-contract.md`, `superpowers/{specs,plans}/`.

## Rodar (precisa de Docker)
Detalhes e perfis no `README.md`. Resumo: `docker compose --profile sim-local up`. O broker depende do `redis`. O dispatcher é **opt-in**: só envia à nuvem com `API_URL` + `EDGE_INGEST_TOKEN`; sem eles, o resultado é persistido em `dispatch:queue` e não enviado (nada é perdido).

## Testar (é assim que se prova não-regressão)
```bash
cd data_broker
npm run validate            # node --check index.js + node --test (descobre *.test.js)
```
- **NÃO** rode `node --test tests/` — no Node 22 ele trata o diretório como módulo e falha. Use `npm run validate` ou `node --test <arquivo>`.
- **Testes de integração são pulados sem `REDIS_URL`** (persistência e dispatcher contra Redis real). Para rodá-los:
  ```bash
  docker run -d --rm -p 6379:6379 --name edge-redis redis:7-alpine
  REDIS_URL=redis://127.0.0.1:6379 npm run validate
  docker stop edge-redis
  ```
- Aquisição (Python): `python -m unittest discover -s tests -p "test_*.py"`.

Baseline verde de referência (main `9036e21`, verificado 2026-07-02): **`node --test` = 67 testes, 63 pass / 0 fail / 4 skip** (os 4 skip são integração sem `REDIS_URL`; com Redis, passam). **Não declare concluído sem isso verde.**

## Convenções (best practices deste repo)
- **CommonJS** no broker (`require`/`module.exports`), sem TypeScript. `fetch` global do Node 22 (sem lib HTTP).
- **ioredis:** `multi().exec()` retorna tuplas `[err, result]` e NÃO rejeita em falha por-comando → use o padrão `execMulti` (`session_manager.js`). Comando bloqueante (`BLMOVE`) exige **conexão dedicada** com `maxRetriesPerRequest: null` (`createBlockingRedisClient`).
- **Contrato-first:** eventos validados em `event_contracts.js`; contrato edge→cloud em `docs/cloud-sync-contract.md`. Mudou o contrato? Atualize o doc.
- **Auth com a nuvem:** só o header `x-edge-ingest-token` (a função roda `verify_jwt=false`); **nunca** `apikey`/`Authorization`.
- **Log estruturado:** `log(level, message, metadata)`.
- **Entrega ao cloud é at-least-once + idempotente** (`idempotency_key`=jobId dedup na nuvem); o dispatcher tem fila confiável + dead-letter + retry.

## Fluxo de trabalho
1. Branch a partir de `main` (`git checkout main && git pull`, depois `git checkout -b feat/...`). **Não** commite direto em `main` — use branch + PR (convenção do repo; todo o trabalho recente foi assim).
2. TDD por task (teste falha → implementa → passa → commit). Planos grandes: `superpowers:subagent-driven-development` (implementer + review por task) + `/pr-review-toolkit:review-pr` no fim.
3. **Worktrees:** prefira-as por padrão em trabalhos de **implementação** (isolam a mudança; permitem sessões/agentes paralelos sem colidir) — `superpowers:using-git-worktrees`. Dispensáveis para análise/investigação (sem escrita de código).
4. CI (`.github/workflows/ci.yml`) precisa estar **verde** antes do merge: jobs `broker` (npm ci + validate, com serviço redis), `acquisition` (python unittest), `compose-config`.
5. PR → review → merge (merge commit). Delete a branch após o merge.
6. Commits terminam com o trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Segredos / tokens (NUNCA ecoar, NUNCA commitar)
- **Linear:** time **NEU**. Token via `$NEURORACE_LINEAR_API_KEY` (convenção NeuroRace); se não estiver setado no ambiente desta sessão, peça ao Pedro. Linear **não é fonte da verdade** (issues podem estar defasadas).
- **`EDGE_INGEST_TOKEN` de produção** (para E2E ao vivo contra a função `ingest-race`): vive em `../cloud-backend/.secret.prod.env` (local, `chmod 600`). Use via `data_broker/.env` (gitignored) ou env efêmera; **nunca** leia/eco em chat nem commite.
- `data_broker/.env`, `/.env` (raiz), `inbox/`, `.superpowers/` são gitignored — não commite.

## Ponteiros
- Bootstrap e modos de execução: `README.md`.
- Specs/planos: `docs/superpowers/{specs,plans}/`. Contrato edge→cloud: `docs/cloud-sync-contract.md`. Par na nuvem: `../cloud-backend/`.
- **Teste E2E local (NEU-70):** runbook em `docs/e2e-local-runbook.md` (esteira edge→cloud local, sem tocar produção). Harness produtor de corrida (faz o papel do game-engine + tela de ops): `data_broker/e2e/race-producer.js` — ferramenta de teste, recusa alvo não-local.
- Follow-ups no Linear: **NEU-68** (dashboard de emails), **NEU-69** (tech-debt do dispatcher), **NEU-17** (identificação / `player_uuid`).
