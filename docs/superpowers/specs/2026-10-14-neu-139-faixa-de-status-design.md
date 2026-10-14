# NEU-139 — Faixa de status e cards dos jogadores (design técnico)

* **Issue:** [NEU-139](https://linear.app/neurorace/issue/NEU-139). **Spec de produto:** "Spec: painel de operação plug-and-play (V2)", seções A e B (documento do projeto no Linear).
* **Prazo:** Ensaio 1, 16/10/2026. **Base:** `main` `5232e93` (inclui NEU-138, NEU-143 e NEU-92).
* **Abordagem aprovada em 14/10:** cada peça se apresenta ao broker; o broker mantém um registro de presença.

## 1. Problema técnico

* O broker não sabe quem é cada conexão: todo socket é anônimo, inclusive o painel no navegador.
* O `gesture` só emite quando um punho fecha. Sem notícia periódica, "gesto parado" é igual a "gesto morto", e a faixa não distingue amarelo de vermelho (CA: coletor desligado = vermelho).
* O jogo (Unreal) não muda antes da NEU-146. A bolinha Jogo usa o fallback da spec: "tem conexão aberta".

## 2. Identificação das peças (contrato novo)

No connect, cada cliente nosso manda `auth` do socket.io:

| Cliente | `auth` |
| -- | -- |
| `acquisition` | `{ role: 'acquisition', player: 1\|2 }` |
| `gesture` | `{ role: 'gesture', player: 1\|2 }` |
| painel (navegador) | `{ role: 'panel' }` |
| `test_client` | `{ role: 'test-client' }` |
| jogo (Unreal), `e2e/jogo-falso.js` | nenhum |

* `auth` ausente ou inválido (role desconhecido, player fora de 1/2) **não derruba a conexão**: o socket vira "não identificado".
* **Não identificado = conexão do jogo** (fallback da spec, seção 8). Por isso o `test_client`, que sobe no perfil `banca`, precisa se identificar: senão pinta o Jogo de verde com o jogo fechado.
* O PC de cada peça é implícito (spec, decisão 6): P1 = Central, P2 = Coletor.

### `gestureStatus` (evento novo, só para presença)

* O `gesture` emite `gestureStatus { player, handSeen: boolean, timeStamp }` a cada 2 s.
* O broker **não repassa** o `gestureStatus` (não vai para o jogo nem para outros clientes). Ele só atualiza a presença.
* `handGesture` continua igual.

## 3. Broker

### `data_broker/presence.js` (novo)

Registro em memória, por socket:

* `onConnect(socketId, auth)`: normaliza o `auth` para uma chave de peça (`acquisition-p1`, `acquisition-p2`, `gesture-p1`, `gesture-p2`), `panel`, `test-client` ou `unidentified`.
* `onEvent(socketId, event, payload, now)`: atualiza `lastEventAt` do socket. Guarda o último `attention`, `poorSignalLevel` e `source` (de `eSense`) e o último `handSeen` (de `gestureStatus`). Num socket não identificado, `raceStarted`, `hasFinished` e `gameEvent` viram `lastGameEvent { event, at }`.
* `onDisconnect(socketId)`.
* `snapshot(now)`:
  * por peça esperada: `connected` (há algum socket com essa chave), `lastEventAt` (o maior entre os sockets), `attention`, `poorSignalLevel`, `source` e `handSeen`;
  * jogo: `connections` (sockets não identificados abertos) e `lastGameEvent`.
* Mais de um socket com a mesma chave (reconexão com o socket velho ainda aberto) não é erro: vale o mais recente.

### Rotas

* `GET /api/status`: `{ now, pieces, game, redis: { status } }`.
  * `now` é o relógio **do broker**. O painel calcula idades com `now - lastEventAt`, os dois do mesmo relógio. Isso evita o problema de relógio deste PC (memória: clock drift no Windows/Docker).
  * `redis.status` é o `status` do cliente ioredis (`ready` = ok).
* `socket_handlers.js` chama a presença no connect, em cada evento e no disconnect. Ele trata o `gestureStatus` à parte, fora do `BROKER_EVENTS`, sem broadcast.

## 4. Peças (Python e test_client)

* `eeg_acquisition/acquisition_clients.py`: `sio.connect(..., auth={'role': 'acquisition', 'player': config.player_id})`.
* `gesture_detector/broker_client.py`:
  * `auth={'role': 'gesture', 'player': PLAYER_ID}`;
  * **não morre** se o broker estiver fora: tenta conectar de novo no máximo a cada 2 s, com `wait_timeout` curto, e descarta o evento enquanto não estiver conectado.
* `gesture_detector/hand_fist_detector.py`: guarda se a mão foi vista no último frame e emite o `gestureStatus` a cada 2 s.
* `test_client/test-client.js` (Node): `io(BROKER, { auth: { role: 'test-client' } })`.

## 5. Painel

### Faixa de status (spec A)

Função pura nova, `OpsState.statusStrip({ status, health, overview, waitingSince, now })`, que devolve as 4 bolinhas e as linhas de "o que fazer".

**Estado de cada peça:**

* `down`: sem conexão.
* `stale`: conectada, mas sem notícia há mais de 10 s, ou nunca mandou nada.
* `ok`: o resto.
* O Redis está `ok` se `redis.status === 'ready'`; senão, `down`.

**Grupos:**

| Grupo | Peças | Verde | Amarelo | Vermelho |
| -- | -- | -- | -- | -- |
| Central | `redis`, `acquisition-p1`, `gesture-p1` | todas `ok` | alguma fora de `ok` | todas `down` |
| Coletor | `acquisition-p2`, `gesture-p2` | todas `ok` | alguma fora de `ok` | todas `down` |
| Jogo | conexões não identificadas | ≥ 1 aberta | — | nenhuma |
| Nuvem | dispatcher + overview (NEU-143) | ligado, sem falha nem espera longa | `cloudNeedsAttention` | dispatcher desligado |

* Sem resposta do `/api/status`, as 4 bolinhas ficam cinza, com "broker sem resposta · confira o PC central".
* A cor sempre vem com palavra: OK, Atenção, Fora.

**Linhas de "o que fazer"** (uma por problema, na ordem Central, Coletor, Jogo, Nuvem):

| Situação | Texto |
| -- | -- |
| Coletor inteiro `down` | `Coletor sem resposta · confira se o PC coletor está ligado e o cabo plugado` (substitui as linhas das peças do coletor) |
| `acquisition-pN` `down` | `acquisition-pN desligado · suba as peças do PC central` (P1) / `… do PC coletor` (P2) |
| `acquisition-pN` `stale` | `acquisition-pN sem dados · confira o fone do PN no PC central/coletor` |
| `gesture-pN` `down` | `gesture-pN desligado · abra o detector de gesto no PC central/coletor` |
| `gesture-pN` `stale` | `gesture-pN sem notícia · reinicie o detector de gesto no PC central/coletor` |
| Redis `down` | `redis fora · reinicie o redis no PC central (a fila fica guardada)` |
| Jogo `down` | `jogo não conectado · abra o jogo no PC central` |
| Nuvem desligada | `nuvem desligada · corridas ficam guardadas no PC central` |
| Nuvem com falha | `N corrida(s) não subiram · use Reenviar no bloco Nuvem` |
| Nuvem esperando > 30 s | `corridas esperando há mais de 30 s · internet do evento?` |

* O banner atual continua só para alertas de corrida (`race_without_players`, `race_discarded`, `registered_without_signal`, `cloud_disabled`, `socket_down`).
* `signal_lost`, `queue_stuck` e `cloud_failed` saem do banner porque a faixa cobre esses casos. O filtro fica no `ops.js`; o `alerts()` não muda.

### Cards P1/P2 (spec B3–B6, B9)

* **Atenção:** número e mini gráfico (já existem).
* **Poor Signal:**
  * número e mini gráfico;
  * cor: 0 verde, 1 a 199 amarelo, 200 vermelho (`OpsState.pslLevel`);
  * com `source === 'bot'`, mostra "simulado".
* **"Sem dados":** em vermelho, no lugar da atenção e do Poor Signal, quando não chega `eSense` daquele jogador há mais de 10 s. Nunca um número congelado.
* **Gesto:**
  * um traço por `handGesture` no último minuto, mais a contagem;
  * "mão vista" vem do último `gestureStatus`, pela presença.
* **Etapas:**
  * Registrado → Correndo → Terminou;
  * `sent` e `rejected` aparecem como Terminou, porque o envio não aparece no card (B9);
  * o `cardState()` não muda; só o mapeamento da tela.
* **Sem relógio** no topo.

## 6. Testes

* **`presence`:**
  * `auth` válido, ausente e inválido;
  * dois sockets com a mesma chave;
  * `lastEventAt`;
  * evento de jogo vindo de socket não identificado;
  * `snapshot`.
* **`socket_handlers`:**
  * `gestureStatus` não faz broadcast e atualiza a presença;
  * o painel identificado não conta como jogo.
* **`statusStrip`:**
  * CA: `acquisition-p2` parado com `gesture-p2` vivo → Coletor amarelo, com a linha;
  * CA: coletor sem nenhuma peça → vermelho e a linha única;
  * a borda de 10 s;
  * Redis fora;
  * Jogo;
  * os três estados da Nuvem;
  * broker sem resposta.
* **`pslLevel`:** 0 / 1 / 199 / 200 / `null`.
* **Python:**
  * o `auth` no connect da acquisition;
  * o `gesture` sem broker não levanta exceção.
* **E2E** (simuladores, perfil `sim-local`):
  * derrubar o `acquisition-b` → Coletor amarelo em ≤ 10 s;
  * derrubar todas as peças do P2 → vermelho;
  * fechar o jogo falso → Jogo vermelho.

## 7. Fora do escopo

* Versão por peça e aviso de commit diferente (NEU-142).
* Trocar fonte ou câmera (NEU-86).
* Largar e Parar (NEU-140).
* Identificação do jogo (NEU-146). Quando o jogo mandar `auth { role: 'game' }`, a presença passa a reconhecê-lo direto, e o fallback continua para jogos antigos.

## 8. Riscos

* **O `gesture` muda nos dois PCs.** O coletor precisa estar na `main` nova no ensaio; senão o `gesture-p2` aparece como "não identificado" e conta como jogo. Mitigação: o roteiro do ensaio (NEU-147) manda atualizar os dois PCs, e a versão (NEU-142) vai mostrar a diferença.
* **Jogo antes da NEU-146:** qualquer cliente antigo sem `auth` conta como jogo.
* **Card "Sem dados" no navegador:** a idade usa o relógio do navegador, entre eventos recebidos pelo próprio navegador. Isso é coerente, porque o relógio é um só.
