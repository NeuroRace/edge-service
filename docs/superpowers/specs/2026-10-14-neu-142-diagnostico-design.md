# NEU-142 — Aba Diagnóstico: estado, versão e o que fazer (design técnico)

* **Issue:** [NEU-142](https://linear.app/neurorace/issue/NEU-142). **Spec de produto:** "Spec: painel de operação plug-and-play (V2)", seções E1–E3 (documento do projeto no Linear).
* **Base:** `main` `9df5e9c` (inclui NEU-139: `presence.js`, `/api/status`, `OpsState.statusStrip`).
* **Aprovado em 14/10:**
  * versão por **hash do código** (zero passo manual);
  * **Reiniciar fica fora** (depende da NEU-137).

## 1. Problema

* Na banca de 30/09, o coletor rodava uma branch velha e ninguém viu. Hoje o painel não mostra a versão de nenhuma peça.
* As imagens Docker não têm o `.git`, porque o contexto de build é a pasta de cada peça. Pôr o commit no build exigiria `GIT_SHA=… docker compose up`, um passo escondido que a spec proíbe ("nada pode depender de configuração manual escondida").
* O Diagnóstico precisa de detalhes que o broker ainda não recebe: ThinkGear `host:porta`, fonte, câmera e a versão de cada peça.

## 2. Versão = hash do código

* **Algoritmo** (igual em Node e Python):
  1. pegar os arquivos de código da peça;
  2. ordenar pelo caminho relativo, com `/`;
  3. para cada arquivo, alimentar o SHA-256 com o caminho, `\n`, o conteúdo com `\r\n` → `\n`, e `\n`;
  4. a versão são os **7 primeiros caracteres hex**.
* **O que entra em cada peça:**

| Peça | Arquivos | Onde roda o cálculo |
| -- | -- | -- |
| `broker` | `data_broker/*.js` e `data_broker/public/*` | `data_broker/code_version.js`, no boot |
| `acquisition` | `eeg_acquisition/*.py` | `eeg_acquisition/code_version.py`, ao montar o `auth` |
| `gesture` | `gesture_detector/*.py` | `gesture_detector/code_version.py`, ao subir |

* Por que normalizar a quebra de linha: com `autocrlf`, o checkout no Windows tem CRLF e o do Mac tem LF. O mesmo commit precisa dar o mesmo hash.
* **Commit, só no `gesture`:** ele roda direto do checkout (fora do Docker), então tenta `git rev-parse --abbrev-ref HEAD` e `git rev-parse --short HEAD` com timeout de 2 s. Se falhar, fica `null`.
* **Aviso de versão:**
  * aparece quando `acquisition-p1.version` e `acquisition-p2.version` existem e são diferentes, e o mesmo para o par `gesture`;
  * é **só comparação**: peça sem versão (cliente antigo) não gera aviso, mas o Diagnóstico mostra "versão desconhecida".

## 3. Contrato: `auth` com metadados

| Cliente | `auth` |
| -- | -- |
| `acquisition` | `{ role, player, version, source, eegHost, acqPort }` |
| `gesture` | `{ role, player, version, commit, branch, camera }` |

* `presence.js` guarda os metadados por socket, mas só os campos conhecidos (`version`, `source`, `eegHost`, `acqPort`, `commit`, `branch`, `camera`). Strings são cortadas em 64 caracteres; números precisam ser finitos. O resto é descartado.
* `snapshot()`: cada peça ganha `meta` (o objeto filtrado do socket mais recente, ou `{}`).
* `snapshot()` ganha `connections`, uma contagem de sockets abertos por chave (`acquisition-p1`, …, `panel`, `test-client`, `unidentified`).
* `game.recentEvents`: os últimos 5 `{ event, at }` vindos de sockets não identificados, mais recente primeiro. O `lastGameEvent` continua.
* `GET /api/status` ganha `broker: { version, uptimeSeconds }`.
* **Câmera:** o `gesture` passa a abrir `CAMERA_INDEX` (env, padrão `0`, o mesmo de hoje) e informa esse índice. Escolher a câmera pelo painel é da NEU-86.

## 4. Painel

### Abas

* **Operação | Diagnóstico**, logo abaixo da faixa de status. A faixa continua visível nas duas.
* Operação é o `<main>` de hoje. Diagnóstico é uma `<section>` nova, escondida até ser escolhida.
* A aba escolhida não é lembrada: o painel sempre abre na Operação.

### `OpsState.diagnostics({ status, now })` (pura, testada)

Devolve `{ pcs: [{ name, pieces: [...] }], versionWarnings: string[] }`.

**Grupos:**

* `PC CENTRAL`: `broker`, `redis`, `acquisition-p1`, `gesture-p1` e `jogo`.
* `PC COLETOR`: `acquisition-p2` e `gesture-p2`.

**Cada peça** tem `{ key, level, word, version, line, details: [[rótulo, valor], …] }`:

* `level`/`word` com o mesmo `pieceState` da faixa: `ok`/"OK", `stale`/"Sem notícia", `down`/"Fora". O broker é `ok` sempre que o `/api/status` responde. O Redis é `ok` com `ready` e `down` com qualquer outro estado. O jogo é `ok` com ≥ 1 conexão e `down` sem nenhuma.
* `version`:
  * `gesture`: `branch · commit` se houver, senão `código <hash>`;
  * demais peças: `código <hash>`;
  * peça sem versão: `versão desconhecida`;
  * Redis e jogo: `—`.
* `line`: a mesma linha de "o que fazer" da faixa (`pieceLine`), só quando a peça não está `ok`. Para o Redis e o jogo, as linhas da faixa.
* **`details`** (rótulos fixos):
  * `acquisition`: fonte, ThinkGear (`host:porta`), Poor Signal, atenção, último dado (`há N s`);
  * `gesture`: câmera, mão vista (`sim`/`não`/`—`), última notícia (`há N s`);
  * `broker`: quem está conectado (`acquisition-p1 ×1 · painel ×2 · …`, pela contagem) e no ar há N min;
  * `jogo`: conexões e últimos eventos (`raceStarted há 12 s · hasFinished há 80 s`);
  * `redis`: estado.

**`versionWarnings`:** uma linha por par diferente, por exemplo `versões diferentes entre central e coletor: acquisition (central 3f9a1c · coletor 77b2e0) · atualize o coletor (git pull) e reabra as peças`.

* As mesmas linhas entram **no topo da faixa**: o `statusStrip` passa a acrescentar os `versionWarnings` em `lines`, sem mudar as cores.

### Renderização

* Os blocos ficam **fixos no `index.html`**, um `<details data-diag="<key>">` por peça, com o `<summary>` (bolinha, palavra e versão), a linha e uma `<dl>`.
* O JS só troca `textContent` e `dataset.level` (nunca `innerHTML`), e a `<dl>` só é refeita quando os detalhes mudam. Assim o bloco aberto não fecha a cada segundo (lição do clique perdido da NEU-141).

## 5. Testes

* **Hash (Node e Python):**
  * mesmo conteúdo com CRLF e com LF dá o mesmo hash;
  * mudar um byte muda o hash;
  * a ordem de criação dos arquivos não muda o hash;
  * dá 7 caracteres hex.
* **`presence`:**
  * meta filtrada (campo desconhecido descartado, string cortada em 64, número não finito descartado);
  * `connections` por chave;
  * `recentEvents` limitado a 5, mais recente primeiro.
* **`/api/status`:** inclui `broker.version` e `broker.uptimeSeconds`.
* **`diagnostics()`:**
  * grupos e peças;
  * estados;
  * formato da versão (hash, commit e desconhecida);
  * os detalhes de cada tipo;
  * aviso só quando o par existe e difere.
* **`statusStrip`:** inclui os avisos de versão nas linhas.
* **Python:**
  * o `auth` da acquisition traz `version`, `source`, `eegHost` e `acqPort`;
  * o do gesture traz `version`, `camera` e `commit`/`branch` ou `None` sem git.
* **Tela:** abas e os `data-diag` de cada peça.
* **E2E** (perfil `banca`): subir a `acquisition-b-sim` com um `.py` alterado (rebuild só dela) → aviso de versão na faixa e no Diagnóstico. Esse é o **critério de pronto da issue**.

## 6. Fora do escopo

* **Reiniciar** (G): depende da NEU-137.
* **Bloco do `simulator`:** ele não fala com o broker, então o estado não é observável. A fonte Bot aparece no bloco da acquisition.
* **Tipo de Bluetooth:** não há como ler hoje.
* **Exportar diagnóstico** (E4): a spec deixa para o fim.
* **Escolher a câmera pelo painel:** NEU-86.

## 7. Riscos

* **Peças antigas sem `version`** não geram aviso. O ensaio atualiza os dois PCs, e a partir daí qualquer diferença aparece.
* **O hash não diz qual commit é.** Ele diz só "igual ou diferente". Para saber qual, o `gesture` mostra o commit; as peças em Docker, não.
