# NEU-86 — NeuroSky ou Bot por jogador e câmera pelo painel (design técnico)

* **Issue:** [NEU-86](https://linear.app/neurorace/issue/NEU-86). **Spec de produto:** "Spec: painel de operação plug-and-play (V2)", requisitos B1, B2, B7, C5 e D2.
* **Base:** branch do PR #30 (NEU-151, `4e29bcb`), que conecta a acquisition ao broker **antes** do EEG e a mantém conectada. Sem isso, um P1 com o ThinkGear fechado nunca chegaria ao broker e não receberia o pedido de virar Bot. Quando o #30 entrar na `main`, esta branch é rebaseada.
* **Decidido em 14/10:**
  * troca **ao vivo**, sem reiniciar peça (não depende da NEU-137);
  * Bot gerado **dentro da acquisition**, sem o container `simulator`;
  * câmera do **P1 e do P2 pelo painel** (a janela do coletor é da NEU-144).

## 1. Problema

* A fonte é fixada ao subir o Docker (`SOURCE`, `EEG_HOST`). Trocar exige recriar o container.
* O detector abre a câmera de `CAMERA_INDEX` e nunca troca. Se a leitura falha, ele fecha (`hand_fist_detector.py`, `if not ret: break`).
* Hoje "bot" é "e-mail em branco" (`session_manager.js`, `playerNIsBot`), e o rótulo `source` do dado não serve de garantia (B2): o perfil `banca` roda simulador como `real`.

## 2. Fonte: NeuroSky ou Bot

### Quem guarda a escolha

* O broker, num hash Redis `players:setup` com `p1Source`, `p2Source` (`neurosky` | `bot`) e `p1Camera`, `p2Camera` (`0`, `1` ou `2`).
* Padrão: `neurosky` nos dois, câmera sem valor (o detector usa o próprio `CAMERA_INDEX`).
* O hash sobrevive a reinício do broker. Fica uma cópia em memória (`player_setup.js`) para o `/api/status`, que é síncrono.

### Como chega na peça

* Quando uma peça `acquisition-pN` se conecta, o broker manda `setSource { source }` só para ela, com a escolha guardada.
* Quando o operador troca, o broker grava e manda `setSource` para todos os sockets `acquisition-pN` abertos.
* Um módulo novo, `piece_commands.js`, guarda os sockets abertos de cada peça e manda os comandos. A `presence` continua só observando.

### O que a acquisition faz

* **Modos:**
  * `neurosky` é o leitor configurado: TCP em `EEG_HOST:ACQ_PORT`, com o rótulo `SOURCE` do env. Assim os perfis de hoje continuam iguais (`banca` com simulador como `real`, `sim-local` com `acquisition-b` como `bot`).
  * `bot` é um gerador dentro do processo, que reaproveita o `generate_packet()` do `simulator.py`. Manda 1 pacote por segundo com rótulo `bot`.
* **`SourceSwitch`** (novo `source_switch.py`, thread-safe):
  * guarda o modo e o leitor ativo. Um leitor aberto para um modo que já mudou (a troca chegou durante o connect) é fechado na hora;
  * o handler do `setSource` (thread do socket.io) chama `switch.request(mode)`. Se o modo mudou, ele fecha o leitor ativo (`shutdown` acorda o `recv` bloqueado) e acorda a espera do backoff.
* **Laço do #30:** a queda causada pela troca não conta como falha. O laço zera `attempt`, não espera o backoff e abre o leitor novo.
* **Espera do backoff interrompível:** se o operador troca para Bot enquanto a peça espera para tentar o ThinkGear de novo (até 10 s), a troca acontece na hora. Isso cumpre o critério dos 10 s.
* Valor desconhecido em `setSource` é ignorado com log `warning`.
* O auth continua mandando `source`, o rótulo do modo inicial.

### Bot nunca sobe (B2)

* No `onRaceStarted`, `playerNIsBot` passa a ser `email vazio` **ou** `pNSource == 'bot'`, lido do `players:setup` na hora da largada. A decisão é a escolha do painel, não o rótulo do dado.
* No `registerPlayers`, o e-mail de um lado em Bot é ignorado: grava vazio e não entra nos "últimos jogadores".
* **Teste (CA de B2):**
  * P1 NeuroSky cadastrado contra P2 Bot: exatamente 1 registro em `dispatch:queue`, o do P1;
  * Bot contra Bot: 0 registros.

## 3. Câmera

* Opções fixas: "Câmera 1", "Câmera 2" e "Câmera 3" (índices 0, 1 e 2). O OpenCV no Windows não dá o nome nem lista os aparelhos de forma confiável.
* O broker manda `setCamera { camera }` para `gesture-pN`:
  * na conexão, só se houver escolha guardada;
  * quando o operador troca.
* **No detector:**
  * novo `camera_switch.py` (sem `cv2`, com o "abridor" injetado para ser testável). Ele guarda o pedido vindo da thread do socket.io, e o laço de vídeo aplica entre dois frames;
  * se a câmera nova não abrir ou não der o primeiro frame, o detector volta para a anterior e guarda o erro `Câmera N não abriu`;
  * o `gestureStatus` passa a levar `camera` (índice em uso) e `cameraError` (texto ou `null`). O contrato aceita os dois campos como opcionais;
  * o texto na janela do detector mostra "Câmera N". É assim que se confere qual aparelho é.
* A falha de leitura fora de uma troca continua fechando o detector, como hoje. Mudar isso fica fora do escopo.

## 4. Trava durante a corrida (C5)

* **No broker:** `session.raceInProgress(now)` é verdadeiro quando:
  * `session:current` está `active`;
  * a largada foi há menos de 10 min;
  * algum jogador humano (não bot) ainda não terminou (`playerNDispatched`).
* O limite de 10 min existe porque a sessão nunca expira (L3, NEU-140). Sem ele, uma corrida esquecida travaria a troca para sempre.
* As rotas de troca respondem `409 race_in_progress` enquanto houver corrida.
* **No painel:** os seletores de fonte e câmera dos dois cards ficam desabilitados enquanto qualquer card estiver em "Correndo", com o motivo no `title`.

## 5. API

| Rota | Corpo | Respostas |
| -- | -- | -- |
| `POST /api/players/source` | `{ player: 1\|2, source: 'neurosky'\|'bot' }` | `200 { ok, setup }`, `400 invalid_player\|invalid_source`, `409 race_in_progress`, `415` sem JSON |
| `POST /api/players/camera` | `{ player: 1\|2, camera: 0\|1\|2 }` | `200 { ok, setup }`, `400 invalid_player\|invalid_camera`, `409`, `415` |
| `GET /api/status` | — | ganha `setup: { 1: { source, camera }, 2: { … } }` |

* As duas rotas exigem `Content-Type: application/json` (CSRF, como o requeue) e têm o mesmo limite de corpo.
* `presence` passa a guardar `camera` e `cameraError` do `gestureStatus`.
* No Diagnóstico, a "fonte" da acquisition passa a vir do último pacote (`source`) e, sem pacote, do auth.
* A câmera do `gesture` passa a vir do último `gestureStatus` e, sem ele, do auth.

## 6. Painel

* **Fonte:** cada card ganha um par de botões **NeuroSky | Bot** (`aria-pressed`), que reflete o `setup` do `/api/status`.
* **Bot:**
  * desliga o campo de e-mail (`disabled`, placeholder "Bot: não vai para a nuvem");
  * o registro manda vazio para esse lado;
  * o card mostra "simulado" no Poor Signal, como já faz com dado `bot`.
* **Câmera:** cada card ganha um `<select>` "Câmera 1/2/3". Ele mostra a câmera em uso, informada pelo detector, e a escolha guardada. Se o detector devolver erro, o texto aparece embaixo, por exemplo "Câmera 3 não abriu; voltou para a Câmera 1".
* **Últimos jogadores (D2):** clicar em P1 ou P2 num lado em Bot volta aquele lado para NeuroSky antes de preencher.
* **Simulador "como humano":** não há nada dele no painel hoje, então não há o que tirar.

## 7. Testes

* **Python (acquisition):**
  * `SourceSwitch`: trocar de modo fecha o leitor ativo e acorda a espera; repetir o mesmo modo não faz nada; valor inválido é ignorado;
  * o leitor Bot gera pacote com `eSense` e rótulo `bot`, e depois de fechado devolve vazio;
  * o laço não conta a troca como falha e não espera o backoff;
  * `create_broker_client` registra o handler `setSource`.
* **Python (gesto):**
  * `CameraSwitch`: aplica o pedido; volta para a anterior quando a nova não abre; guarda o erro;
  * o `gestureStatus` leva `camera` e `cameraError`;
  * o cliente registra o handler `setCamera`.
* **Node:**
  * `player_setup`: padrão, gravar, ler de volta do Redis, valores inválidos;
  * rotas: 200, 400, 409 e 415;
  * `setSource` e `setCamera` no connect e na troca, só para a peça certa;
  * `raceInProgress` (ativa, terminada, mais de 10 min, bot);
  * B2 contra Redis real (os dois CAs da seção 2);
  * contrato do `gestureStatus` com os campos novos;
  * `presence` com a câmera;
  * tela: botões, `select` e `data-*`.
* **E2E** (perfil `banca`, broker e acquisitions em Docker):
  * trocar o P1 para Bot pelo painel: pacotes `bot` em até 10 s; voltar para NeuroSky: pacotes `real` em até 10 s;
  * trocar para Bot com o ThinkGear fora (acquisition apontando para uma porta fechada): pacotes `bot` em até 10 s;
  * câmera: sem câmera nesta máquina para o teste real, então o E2E usa o detector falso com `CameraSwitch` e um abridor falso. **O critério "ver punhos chegando" fica para o ensaio, com câmera de verdade.**

## 8. Fora do escopo

* Janela do coletor com seletor de câmera do P2 (NEU-144).
* Reiniciar peça (NEU-153).
* "Sem cadastro" explícito, Largar e Parar (NEU-140). Aqui, Bot apenas desliga o campo; o anônimo continua sendo o e-mail em branco.
* Listar as câmeras que existem de fato no PC.

## 9. Riscos

* **Conflito com o #30:** se o Rodrigo mudar o laço antes do merge, a rebase dá retrabalho no `acquisition_runner.py`.
* **`shutdown` em socket bloqueado no Windows:** a acquisition roda em Linux (Docker), onde `shutdown` acorda o `recv`. Fora do Docker, o pior caso é esperar o timeout de leitura (`EEG_READ_TIMEOUT_SECONDS`, 10 s).
* **Câmera:** índices que não existem só são descobertos ao tentar abrir. O operador vê o erro e o detector continua na câmera anterior.
* **Peça antiga (sem o handler):** ignora `setSource` e `setCamera` em silêncio. O painel mostra a escolha, mas o dado continua `real`. O ensaio atualiza os dois PCs, e o aviso de versão da NEU-142 mostra quem está desatualizado.
