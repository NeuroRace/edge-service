# NEU-140 (plano B) — Registrar com travas, vincular, Parar e sessão que expira (design técnico)

* **Issue:** [NEU-140](https://linear.app/neurorace/issue/NEU-140). **Spec de produto:** "Spec: painel de operação plug-and-play (V2)", requisitos B8a, B9, C2 (só as travas de contato), C6, L3 e seção 7.
* **Base:** branch `feature/neu-86` (PR #31), que já tem os lados em Bot (`botSlots`), o `raceInProgress` e os cards novos. O #31 está empilhado sobre o #30. Quando os dois entrarem, esta branch é rebaseada na `main`.
* **Escopo: plano B da spec (seção 8).** O jogo continua largando sozinho. A NEU-146 (o que o jogo aceita) não tem resposta.
* **Decidido em 15/10:**
  * corrida largada sem registro → **vincular à corrida** pelo painel, até o `hasFinished` daquele lado;
  * sessão aberta **expira 10 min após a largada** (`RACE_LOCK_MS`, a mesma janela da NEU-86).

## 1. Problema

* **E-mail em branco = anônimo por acidente.** Hoje um campo vazio registra o lado como anônimo (`session_manager.js`, `checkEmail` aceita vazio). Esquecer de digitar e escolher não cadastrar dão no mesmo.
* **Corrida largada sem registro se perde.** O jogo larga mesmo sem ninguém ter clicado em Registrar. O lado vira "bot", e o `hasFinished` descarta a corrida (`no_email_registered`). O alerta do painel só aparece quando **os dois** lados ficam sem registro (`ops_state.js`, `race_without_players`).
* **Não há como cancelar uma corrida.** Uma largada falsa ou um problema no meio obriga a esperar o `hasFinished`, e o resultado vai para a fila.
* **Sessão pendurada (L3).** `session:current` nunca expira. Um `hasFinished` horas depois ainda grava resultado numa sessão de outro dia.

## 2. Fora do escopo

* Largar pelo painel, contagem 3-2-1, "Próximo P1/P2" e a trava "jogo desconectado" (dependem da NEU-146).
* Parar **o jogo**. No plano B, Parar cancela só no broker. O painel avisa para parar também no jogo.
* Id de corrida vindo do jogo. Sem ele, um `hasFinished` atrasado que chega **depois da largada seguinte** cai na corrida nova (seção 9).
* Telefone como contato (frente de onboarding). Termo e LGPD (NEU-102).

## 3. Estado da sessão

`session:current` (hash) ganha dois campos e mantém os que existem:

| Campo | Valores | Significado |
| -- | -- | -- |
| `status` | `active`, `cancelled`, `expired` | `cancelled` = Parar; `expired` = mais de 10 min da largada |
| `playerNKind` | `contact`, `nosignup`, `bot`, `missing` | como o lado entrou na corrida |
| `playerNIsBot` | `true`, `false` | **sem mudança de significado:** "não vai para a nuvem". `false` só para `contact` |

* `playerNIsBot` continua sendo lido pelo `onHasFinished` e pelo painel atual. Por isso ele fica, derivado do `kind`.
* Sessão gravada antes desta mudança (sem `kind`) é lida como hoje: `IsBot=true` vira `bot`, `false` vira `contact`.

### Como cada lado entra na largada (`onRaceStarted`)

| Situação do lado | `kind` |
| -- | -- |
| `pNSource = bot` no `players:setup` (NEU-86) | `bot` |
| `pending:players` com e-mail | `contact` |
| `pending:players` com `playerNNoSignup = true` | `nosignup` |
| sem `pending:players` para o lado, ou e-mail vazio sem `noSignup` | `missing` |

* O `eSense` de um lado `missing` continua sendo guardado (hoje já é: `onEsense` só pula `source = bot`). Assim, vincular no meio da corrida leva a corrida inteira.
* Um `pending:players` antigo (sem os campos `NoSignup`) com e-mail vazio vira `missing`, não `nosignup`. Em caso de dúvida, o lado fica visível como problema em vez de ser descartado em silêncio.

## 4. Broker (`session_manager.js`)

### Registrar: `registerPlayers(p1Email, p2Email, { p1NoSignup, p2NoSignup } = {})`

* Lado em Bot: ignora e-mail e `noSignup`, como na NEU-86.
* Lado NeuroSky:
  * e-mail válido → cadastrado (`noSignup` é ignorado);
  * e-mail vazio **e** `noSignup = true` → sem cadastro;
  * e-mail vazio **sem** `noSignup` → erro `missing_contact` com `field` (`player1Email` ou `player2Email`);
  * e-mail inválido → `invalid_email` com `field`, como hoje.
* `pending:players` passa a guardar `player1NoSignup` e `player2NoSignup` (`'true'` ou `'false'`).
* Só cadastrados entram nos últimos jogadores, como hoje.

### Vincular: `linkPlayer(player, rawEmail)`

* Valida `player` (1 ou 2) e o e-mail (normaliza; vazio é inválido aqui).
* Só funciona quando:
  * a sessão está `active` (depois de aplicar a expiração, ver "Expirar" abaixo);
  * o lado é `missing`;
  * o `hasFinished` daquele lado ainda não consolidou (`playerNDispatched` ausente).
* Grava `playerNEmail`, `playerNKind = contact`, `playerNIsBot = false` e põe o contato nos últimos jogadores.
* Resultado: `{ ok: true, session }`, ou `{ ok: false, error }` com `invalid_player`, `invalid_email`, `no_active_session`, `not_missing`, `already_finished`.
* **Corrida com o `hasFinished`:** o vínculo e o `hasFinished` disputam o mesmo lado. Duas regras fecham a janela:
  * o vínculo é uma transação (`WATCH session:current` + `MULTI`) que só grava se o lado ainda não tem `playerNDispatched`. Se o `hasFinished` reivindicou o lado no meio, a transação falha e a resposta é `already_finished`;
  * o `onHasFinished` passa a fazer o **claim primeiro** (`HSETNX playerNDispatched`) para qualquer lado, e só depois **relê** a sessão para decidir entre consolidar e descartar. Depois do claim nenhum vínculo grava, então a releitura é a verdade final. Hoje ele lê a sessão antes do claim: um vínculo gravado nesse meio faria a corrida ser descartada com o painel dizendo "vinculado".

### Parar: `stopRace()`

* Sessão `active` → `status = cancelled`, mais `stoppedAt`. Apaga `session:<id>:player:1:packets` e `:2:packets`.
* Mantém `id` e `startedAt` (para o log e para o painel devolver os contatos aos campos).
* Não mexe em `pending:players` (a próxima dupla) nem em `players:recent`.
* Sem sessão `active` → `{ ok: false, error: 'no_active_session' }`.
* Log `race_stopped` com `sessionId` e a duração até o Parar.

### Eventos atrasados

* `onEsense` e `onHasFinished` só aceitam sessão `active` (depois da expiração).
* Em sessão `cancelled` ou `expired`:
  * `hasFinished` → ignorado, log `has_finished_ignored_closed_session` com `sessionId`, `status` e `playerId`. Não chama `onDiscarded` (não é descarte de corrida, a corrida já tinha sido encerrada);
  * `eSense` → ignorado, log `esense_ignored_closed_session` **uma vez por sessão** (memória do processo), não a cada pacote.
* Sem sessão nenhuma: os logs de hoje (`*_no_active_session`).

### Expirar (L3)

* Uma sessão `active` com `now - startedAt >= RACE_LOCK_MS` (10 min) é marcada `expired` na **primeira leitura** que passar por ela: `getCurrentSession`, `onEsense`, `onHasFinished`, `linkPlayer`, `stopRace`, `raceInProgress`. Não há timer.
* A marcação é condicional (`WATCH` ou `HSET` só se ainda `active`), e o log `session_expired` sai uma vez, com `sessionId` e `startedAt`.
* As listas de pacotes da sessão expirada são apagadas junto.

### `raceInProgress` (NEU-86)

* Passa a valer só para sessão `active` depois da expiração. Parar destrava fonte e câmera na hora.
* Um lado `missing` conta como humano (pode ser vinculado). Com os dois lados `missing`, a troca fica travada até terminar, parar ou expirar.

### `getCurrentSession`

* Ganha `player1Kind` e `player2Kind`.
* `status` pode ser `cancelled` ou `expired`. Para essas, os campos da sessão continuam (o painel usa os contatos ao parar).
* Sem mudança no `pending`.

## 5. API (`http_server.js`)

Rotas novas exigem `Content-Type: application/json` (CSRF, como o requeue) e corpo até 4096 bytes (`413`), e respondem `415` sem JSON.

| Rota | Corpo | Respostas |
| -- | -- | -- |
| `POST /api/players` (muda) | `{ player1Email, player2Email, player1NoSignup?, player2NoSignup? }` | `200` como hoje; `400 invalid_email` como hoje; **novo** `400 missing_contact` com `field` |
| `POST /api/session/link` (nova) | `{ player: 1\|2, email }` | `200 { ok, session }`; `400 invalid_player\|invalid_email\|invalid_json`; `409 no_active_session\|not_missing\|already_finished` |
| `POST /api/session/stop` (nova) | `{}` | `200 { ok, sessionId }`; `409 no_active_session` |
| `GET /api/session/current` (muda) | — | ganha `player1Kind`, `player2Kind`; `status` pode ser `cancelled` ou `expired` |

* `player1NoSignup` e `player2NoSignup` só valem como `true` booleano; qualquer outra coisa é `false`.
* O `race-producer.js` (E2E) sempre manda os dois e-mails, então continua funcionando.

## 6. Painel

### Registro (B8a, C2)

* Cada card NeuroSky ganha uma caixa **"Sem cadastro"** (`data-nosignup="N"`).
  * Marcada: o campo de contato fica desligado, placeholder "Sem cadastro: não vai para a nuvem".
  * Em Bot, a caixa some (o campo já fica desligado pela NEU-86).
* **Registrar fica desligado com o motivo ao lado** (`data-register-blockers`), recalculado a cada tecla:
  * "P1: digite o contato ou marque Sem cadastro";
  * "P2: e-mail inválido".
* A regra é uma função pura em `ops_state.js`: `registerBlockers({ 1: { source, email, noSignup }, 2: {...} })` → lista de `{ slot, code, text }` (`missing_contact`, `invalid_email`). Vazia = Registrar liberado.
* O broker repete a regra (`400 missing_contact`). Se ele recusar, o painel mostra o erro embaixo do campo, como já faz com `invalid_email`.

### O "esqueci" (lado `missing`)

* `cardState` ganha o estado `missing` (sessão `active`, `kind = missing`, sem `hasFinished`).
  * Card: "Sem cadastro nesta corrida". O campo daquele lado fica editável, com o botão **"Vincular a esta corrida"** (`data-link="N"`).
  * Vincular manda `POST /api/session/link`. `already_finished` mostra "Essa corrida já terminou sem cadastro".
* Depois do `hasFinished` sem vínculo: estado `lost`, card "Terminou sem cadastro: não foi salva".
* O alerta do topo `race_without_players` passa a ser **por lado** e acende sempre que algum lado estiver `missing`: "P1 largou sem cadastro. Digite o contato e clique em Vincular antes de terminar."

### Rótulos

* "Anônimo" se divide:
  * `nosignup` → "Sem cadastro: não vai para a nuvem";
  * `bot` → "Bot: não vai para a nuvem".
* Sessão `cancelled` ou `expired` = Livre: os cards voltam a "Aguardando" e os campos destravam.

### Parar corrida (C6)

* Botão **"Parar corrida"** (`data-stop`) aparece enquanto a sessão está `active`.
* Confirmação em dois passos no próprio botão: o primeiro clique troca o texto para "Confirmar: parar sem gravar?" por 5 s; o segundo manda `POST /api/session/stop`. Sem `confirm()` do navegador, porque ele trava a tela e as atualizações ao vivo.
* Depois de parar: dica "Corrida parada, nada foi gravado. Pare também no jogo."
* Se os dois campos estiverem vazios e não houver `pending`, os contatos da corrida parada voltam para os campos, **sem registrar**.
* Fonte e câmera destravam na próxima atualização (o `setupLocked` só olha sessão `active`).

## 7. Testes

* **Unitários (Node, sem Redis):**
  * `registerBlockers`: contato válido, vazio sem e com Sem cadastro, inválido, lado em Bot;
  * `cardState`: `missing`, `lost`, `nosignup`, `bot`, sessão `cancelled` e `expired` = `waiting`;
  * `alerts`: um lado `missing` acende o alerta daquele lado;
  * `setupLocked` com sessão `cancelled`.
* **Sessão contra Redis real** (em `test_session_integration.test.js`):
  * `missing_contact` no registro; `nosignup` vira `kind = nosignup`;
  * largada sem registro → `missing`; `linkPlayer` no meio → `hasFinished` gera **1** registro em `dispatch:queue` com o e-mail vinculado;
  * `linkPlayer` depois do `hasFinished` → `already_finished`, fila sem mudança;
  * claim antes da releitura: um vínculo gravado entre a chegada do `hasFinished` e o claim consolida com o e-mail (teste com um `redis` que intercala o vínculo no meio);
  * `hasFinished` duplicado de um lado `bot` ou `missing` continua sem ir para a fila e sem dois descartes;
  * **CA de C6:** `stopRace` no meio e depois `hasFinished` daquela corrida → fila sem mudança; a próxima largada cria sessão `active` normalmente e consolida;
  * `eSense` depois do Parar não cria lista de pacotes;
  * sessão com 11 min → `expired` na leitura, `hasFinished` ignorado, listas apagadas;
  * sessão antiga sem `kind` continua consolidando.
* **Rotas:** `200`, `400`, `409`, `413` e `415` de `link` e `stop`; `400 missing_contact` em `/api/players`.
* **Tela:** `data-nosignup`, `data-register-blockers`, `data-link`, `data-stop` no HTML.
* **E2E** (perfil `banca`, nuvem desligada e conferida no `/health`, jogo falso `e2e/jogo-falso.js`):
  * largar sem registrar → card "Sem cadastro nesta corrida" → vincular → terminar → 1 registro na fila;
  * Parar no meio, depois mandar `hasFinished` → fila sem mudança, log `has_finished_ignored_closed_session`; a próxima corrida consolida;
  * Registrar desligado com o motivo, e liberado com Sem cadastro.

## 8. Contrato e docs

* `docs/event-contracts.md`: rotas novas, `missing_contact`, `kind` e os status `cancelled`/`expired`, e a limitação da seção 9.
* `docs/banca-runbook.md`: Sem cadastro, Vincular e Parar (com "pare também no jogo").

## 9. Riscos e limitações

* **`hasFinished` atrasado depois da largada seguinte.** O jogo não manda id de corrida, então não dá para separar. Antes da largada seguinte o evento é ignorado; depois, ele consolida na corrida nova. Mitigação: o painel orienta parar também no jogo. A solução de verdade (id da corrida no `raceStarted` e no `hasFinished`) vai para a NEU-146.
* **Corrida real com mais de 10 min.** O resultado é ignorado como sessão expirada. Hoje as corridas são bem mais curtas; se o ensaio mostrar outra coisa, `RACE_LOCK_MS` é uma constante só.
* **Vincular errado.** O operador pode vincular o contato do jogador errado. O painel mostra o contato vinculado no card; não há "desvincular" nesta fase.
* **Conflito com o #30 e o #31.** Esta branch depende dos dois. Mudança no `session_manager.js` ou no `ops.js` deles antes do merge dá retrabalho na rebase.
