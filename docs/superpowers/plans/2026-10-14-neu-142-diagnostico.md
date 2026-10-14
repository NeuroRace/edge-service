# NEU-142 — Aba Diagnóstico (sem Reiniciar): plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma aba Diagnóstico mostra cada peça, em PC CENTRAL e PC COLETOR, com estado, versão, detalhes e o que fazer. Um aviso aparece no topo quando central e coletor rodam códigos diferentes.

**Architecture:**
* Cada peça calcula a versão como um **hash curto do próprio código** (SHA-256 com CRLF normalizado) e a manda no `auth` do Socket.IO, junto com os metadados.
* `presence.js` (NEU-139) guarda os metadados filtrados, conta as conexões e guarda os últimos eventos do jogo. `GET /api/status` ganha `broker.version` e `broker.uptimeSeconds`.
* O painel ganha abas. A função pura `OpsState.diagnostics()` monta os blocos, e `statusStrip()` passa a incluir o aviso de versão.

**Tech Stack:**
* Node 22 (CommonJS, `node:test`, `crypto`).
* Python 3.11 (`hashlib`, `subprocess`, `unittest`).
* HTML/CSS/JS sem build.

**Spec:** `docs/superpowers/specs/2026-10-14-neu-142-diagnostico-design.md`

## Global Constraints

* **Hash:**
  * arquivos ordenados pelo caminho relativo com `/`;
  * para cada arquivo, alimentar `caminho + "\n" + conteúdo (CRLF→LF) + "\n"` em UTF-8;
  * a versão são os **7 primeiros hex**.
  * Vetor de teste: `{'a.py': 'x\r\ny\n', 'sub/b.py': 'z'}` → **`df00286`** (vale em Node e em Python).
* **Arquivos de cada peça:**
  * broker: `data_broker/*.js` + `data_broker/public/*`;
  * acquisition: `eeg_acquisition/*.py`;
  * gesture: `gesture_detector/*.py`.
* **Metadados de `auth` aceitos:** `version`, `source`, `eegHost`, `acqPort`, `commit`, `branch`, `camera`. Strings não vazias são cortadas em 64; números precisam ser finitos; o resto é descartado.
* **Texto do aviso:** `versões diferentes entre central e coletor: <role> (central <v1> · coletor <v2>) · atualize o coletor (git pull) e reabra as peças`.
* **Versão exibida:**
  * gesture com commit: `branch · commit`;
  * com hash: `código <hash>`;
  * sem versão: `versão desconhecida`;
  * Redis e jogo: `—`.
* **Palavras de estado:** `OK`, `Sem notícia`, `Fora`.
* **Câmera:** `Câmera N`, com N = índice + 1 (spec B7).
* **DOM:** só `textContent` e `dataset`; os blocos `<details>` são fixos no HTML.
* **Testes:**
  * Node: `npm --prefix data_broker run validate`;
  * Python: `python -m unittest discover -s tests -p "test_*.py"` (venv com `python-socketio[client]`).
* **Commits:** terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Mesmo código com quebras de linha diferentes** (checkout do Windows com CRLF × Docker/Mac com LF). Esperado: mesmo hash. O teste fica nas Tasks 1 e 2.
2. **Peça antiga, sem `version`, de um lado.** Esperado: nenhum aviso, e "versão desconhecida" no bloco. O teste fica na Task 4.
3. **`auth` com campo gigante ou de tipo errado** (por exemplo, `eegHost` com 10 KB ou `acqPort` `NaN`). Esperado: cortado ou descartado, e a conexão segue. O teste fica na Task 2.
4. **Sem git no PC** (gesture rodando de um zip). Esperado: `commit`/`branch` `None`, e o detector sobe normalmente. O teste fica na Task 3.
5. **Bloco aberto durante a atualização a cada 2 s.** Esperado: continua aberto. Coberto pela estrutura fixa (Task 5) e conferido no E2E (Task 6).

## File Structure

| Arquivo | Responsabilidade |
| -- | -- |
| `data_broker/code_version.js` (novo) | `hashFiles`, `brokerCodeVersion` |
| `eeg_acquisition/code_version.py` (novo) | `hash_files`, `code_version` |
| `gesture_detector/code_version.py` (novo) | `hash_files`, `code_version`, `git_info` |
| `data_broker/presence.js` | meta filtrada, `connections`, `recentEvents`, `buildStatus` |
| `data_broker/index.js` | versão do broker no boot; `getStatus` via `buildStatus` |
| `eeg_acquisition/acquisition_clients.py` | `broker_auth` com metadados |
| `gesture_detector/broker_client.py` | parâmetro `meta` no `auth` |
| `gesture_detector/hand_fist_detector.py` | `CAMERA_INDEX`; monta a meta |
| `data_broker/public/ops_state.js` | `diagnostics`, `versionWarnings`; `statusStrip` com os avisos |
| `data_broker/public/index.html`, `ops.js`, `ops.css` | abas e blocos do Diagnóstico |
| `docs/event-contracts.md` | `auth` com metadados e `/api/status` |

---

### Task 1: Hash do código do broker (`code_version.js`)

**Files:**
- Create: `data_broker/code_version.js`
- Test: `data_broker/tests/test_code_version.test.js`

**Interfaces:**
- Produces: `hashFiles(baseDir, relPaths) → string (7 hex)`; `brokerCodeVersion(baseDir = __dirname) → string`.

- [ ] **Step 1: Write the failing test** (`data_broker/tests/test_code_version.test.js`)

```js
// NEU-142: versao = hash curto do codigo (mesmo resultado com CRLF ou LF).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashFiles, brokerCodeVersion } = require('../code_version');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('vetor de referencia (igual ao do Python): df00286', () => {
  const dir = tree({ 'a.py': 'x\r\ny\n', 'sub/b.py': 'z' });
  assert.equal(hashFiles(dir, ['sub/b.py', 'a.py']), 'df00286');
});

test('CRLF e LF dao o mesmo hash; mudar um byte muda; ordem de entrada nao importa', () => {
  const crlf = tree({ 'a.js': 'linha1\r\nlinha2\r\n', 'b.js': 'b' });
  const lf = tree({ 'a.js': 'linha1\nlinha2\n', 'b.js': 'b' });
  const other = tree({ 'a.js': 'linha1\nlinha3\n', 'b.js': 'b' });
  assert.equal(hashFiles(crlf, ['a.js', 'b.js']), hashFiles(lf, ['b.js', 'a.js']));
  assert.notEqual(hashFiles(lf, ['a.js', 'b.js']), hashFiles(other, ['a.js', 'b.js']));
  assert.match(hashFiles(lf, ['a.js', 'b.js']), /^[0-9a-f]{7}$/);
});

test('brokerCodeVersion: so .js da raiz e public/*; tests e node_modules ficam de fora', () => {
  const base = tree({ 'index.js': 'a', 'public/ops.js': 'b', 'tests/x.test.js': 'c', 'node_modules/m/i.js': 'd', 'README.md': 'e' });
  const v = brokerCodeVersion(base);
  assert.equal(v, hashFiles(base, ['index.js', 'public/ops.js']));
  fs.writeFileSync(path.join(base, 'tests/x.test.js'), 'mudou');
  assert.equal(brokerCodeVersion(base), v, 'mudar teste nao muda a versao');
  fs.writeFileSync(path.join(base, 'public/ops.js'), 'mudou');
  assert.notEqual(brokerCodeVersion(base), v);
});

test('brokerCodeVersion do repo real: 7 hex', () => {
  assert.match(brokerCodeVersion(), /^[0-9a-f]{7}$/);
});
```

- [ ] **Step 2: Run to see it fail.** `cd data_broker && node --test tests/test_code_version.test.js` → FAIL (`Cannot find module '../code_version'`).

- [ ] **Step 3: Implement** (`data_broker/code_version.js`)

```js
// data_broker/code_version.js
// NEU-142: versao de cada peca = hash curto do proprio codigo. Zero passo manual (a imagem
// Docker nao tem o .git). CRLF -> LF: o checkout no Windows (autocrlf) e o do Mac/Docker dao
// o mesmo hash. O mesmo algoritmo existe em Python (eeg_acquisition/ e gesture_detector/).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hashFiles(baseDir, relPaths) {
  const h = crypto.createHash('sha256');
  const rels = [...relPaths].map((p) => p.split(path.sep).join('/')).sort();
  for (const rel of rels) {
    const content = fs.readFileSync(path.join(baseDir, rel), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${rel}\n${content}\n`, 'utf8');
  }
  return h.digest('hex').slice(0, 7);
}

function brokerFiles(baseDir) {
  const top = fs.readdirSync(baseDir).filter((f) => f.endsWith('.js') && fs.statSync(path.join(baseDir, f)).isFile());
  const publicDir = path.join(baseDir, 'public');
  const pub = fs.existsSync(publicDir)
    ? fs.readdirSync(publicDir).filter((f) => fs.statSync(path.join(publicDir, f)).isFile()).map((f) => `public/${f}`)
    : [];
  return [...top, ...pub];
}

function brokerCodeVersion(baseDir = __dirname) {
  return hashFiles(baseDir, brokerFiles(baseDir));
}

module.exports = { hashFiles, brokerCodeVersion };
```

- [ ] **Step 4: Run.** `node --test tests/test_code_version.test.js` → PASS (4).
- [ ] **Step 5: Commit** `feat(broker): versao do codigo por hash (CRLF normalizado) [NEU-142]`.

### Task 2: Presença com metadados, conexões e eventos do jogo; `/api/status` com o broker

**Files:**
- Modify: `data_broker/presence.js`, `data_broker/index.js`
- Modify: `data_broker/tests/test_presence.test.js` (o formato da peça ganha `meta`)
- Test: `data_broker/tests/test_presence_meta.test.js`

**Interfaces:**
- Consumes: `brokerCodeVersion()` (Task 1).
- Produces:
  * `snapshot()` → `{ pieces: { [key]: { connected, lastEventAt, attention, poorSignalLevel, source, handSeen, meta } }, game: { connections, lastGameEvent, recentEvents: [{event, at}] }, connections: { [key]: n } }`;
  * `sanitizeMeta(auth) → object`;
  * `buildStatus({ presence, redisStatus, brokerVersion, startedAt, now }) → { now, pieces, game, connections, redis: { status }, broker: { version, uptimeSeconds } }`.

- [ ] **Step 1: Write the failing test** (`data_broker/tests/test_presence_meta.test.js`)

```js
// NEU-142: metadados das pecas (versao, ThinkGear, camera), conexoes e eventos do jogo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresence, sanitizeMeta, buildStatus } = require('../presence');

test('sanitizeMeta: so campos conhecidos; string cortada em 64; numero nao finito fora', () => {
  assert.deepEqual(sanitizeMeta({ role: 'acquisition', player: 1, version: 'abc1234', source: 'real', eegHost: 'x'.repeat(10_000), acqPort: 13854, hack: 'y', camera: NaN, commit: '' }), {
    version: 'abc1234', source: 'real', eegHost: 'x'.repeat(64), acqPort: 13854,
  });
  assert.deepEqual(sanitizeMeta(undefined), {});
  assert.deepEqual(sanitizeMeta('lixo'), {});
});

test('peca leva a meta do socket mais recente; peca sem socket tem meta vazia', () => {
  const p = createPresence();
  p.onConnect('a2', { role: 'acquisition', player: 2, version: 'v2', eegHost: 'host.docker.internal', acqPort: 13854 }, 1);
  const s = p.snapshot();
  assert.deepEqual(s.pieces['acquisition-p2'].meta, { version: 'v2', eegHost: 'host.docker.internal', acqPort: 13854 });
  assert.deepEqual(s.pieces['acquisition-p1'].meta, {});
});

test('connections conta sockets abertos por chave', () => {
  const p = createPresence();
  p.onConnect('a', { role: 'panel' }, 1);
  p.onConnect('b', { role: 'panel' }, 1);
  p.onConnect('c', {}, 1);
  p.onConnect('d', { role: 'gesture', player: 1 }, 1);
  assert.deepEqual(p.snapshot().connections, { panel: 2, unidentified: 1, 'gesture-p1': 1 });
  p.onDisconnect('b');
  assert.equal(p.snapshot().connections.panel, 1);
});

test('recentEvents: ultimos 5 eventos do jogo, mais recente primeiro; sobrevivem a desconexao', () => {
  const p = createPresence();
  p.onConnect('g', {}, 1);
  for (let i = 1; i <= 7; i += 1) p.onEvent('g', i % 2 ? 'raceStarted' : 'hasFinished', {}, i * 10);
  p.onConnect('panel', { role: 'panel' }, 1);
  p.onEvent('panel', 'gameEvent', {}, 999);
  p.onDisconnect('g');
  const ev = p.snapshot().game.recentEvents;
  assert.equal(ev.length, 5);
  assert.deepEqual(ev[0], { event: 'raceStarted', at: 70 });
  assert.deepEqual(ev[4], { event: 'hasFinished', at: 20 });
});

test('buildStatus: inclui broker.version e uptime pelo relogio do broker', () => {
  const p = createPresence();
  const s = buildStatus({ presence: p, redisStatus: 'ready', brokerVersion: 'abc1234', startedAt: 1_000, now: 181_000 });
  assert.equal(s.now, 181_000);
  assert.deepEqual(s.redis, { status: 'ready' });
  assert.deepEqual(s.broker, { version: 'abc1234', uptimeSeconds: 180 });
  assert.ok(s.pieces && s.game && s.connections);
});
```

No `tests/test_presence.test.js`, nos dois `deepEqual` do formato da peça (`emptyPiece` e `acquisition-p2` com dados), acrescentar `meta: {}`.

- [ ] **Step 2: Run to see it fail.** `node --test tests/test_presence_meta.test.js tests/test_presence.test.js` → FAIL (`sanitizeMeta is not a function`, `meta` ausente).

- [ ] **Step 3: Implement** em `presence.js`:

```js
const META_FIELDS = ['version', 'source', 'eegHost', 'acqPort', 'commit', 'branch', 'camera'];
const RECENT_GAME_EVENTS = 5;

// NEU-142: so campos conhecidos do auth; string cortada em 64, numero so se finito.
function sanitizeMeta(auth) {
  const out = {};
  if (!auth || typeof auth !== 'object') return out;
  for (const k of META_FIELDS) {
    const v = auth[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v.slice(0, 64);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
```

* `emptyPiece()` passa a ter `meta: {}`.
* `createPresence()`:
  * `const recentEvents = [];`;
  * `onConnect` guarda `meta: sanitizeMeta(auth)` no socket;
  * em `onEvent`, no ramo do jogo: `recentEvents.unshift({ event, at: now }); recentEvents.length = Math.min(recentEvents.length, RECENT_GAME_EVENTS);`.
* `snapshot()`:
  * a peça encontrada vira `{ ...emptyPiece(), ...latest.data, connected: true, lastEventAt: latest.lastEventAt, meta: { ...latest.meta } }`;
  * `connections` é a contagem por `s.key` de todos os sockets;
  * retorna `{ pieces, game: { connections: game.length, lastGameEvent, recentEvents: recentEvents.map((e) => ({ ...e })) }, connections }`.
* Acrescentar:

```js
// NEU-142: corpo do GET /api/status (relogio do broker em `now`).
function buildStatus({ presence, redisStatus, brokerVersion, startedAt, now }) {
  return {
    now,
    ...presence.snapshot(),
    redis: { status: redisStatus },
    broker: { version: brokerVersion, uptimeSeconds: Math.floor((now - startedAt) / 1000) },
  };
}
```

* Exportar `sanitizeMeta` e `buildStatus`.

`index.js`:

```js
const { createPresence, buildStatus } = require('./presence');
const { brokerCodeVersion } = require('./code_version');
// ...
const presence = createPresence();
const brokerVersion = brokerCodeVersion();
const startedAt = Date.now();
const getStatus = () => buildStatus({ presence, redisStatus: redis.status, brokerVersion, startedAt, now: Date.now() });
```

Também passar `brokerVersion` no log `broker_listening`.

- [ ] **Step 4: Run.** `npm --prefix data_broker run validate` → PASS.
- [ ] **Step 5: Commit** `feat(broker): presenca guarda versao/metadados, conexoes e eventos do jogo; /api/status com o broker [NEU-142]`.

### Task 3: As peças Python mandam versão e metadados

**Files:**
- Create: `eeg_acquisition/code_version.py`, `gesture_detector/code_version.py`
- Modify: `eeg_acquisition/acquisition_clients.py`, `gesture_detector/broker_client.py`, `gesture_detector/hand_fist_detector.py`
- Modify: `tests/test_acquisition_clients.py` (o `broker_auth` ganha campos)
- Test: `tests/test_code_version.py`, `tests/test_gesture_broker_client.py` (+ meta)

**Interfaces:**
- Produces:
  * `code_version(base_dir=None) -> str` (os dois módulos);
  * `hash_files(base_dir, rel_paths) -> str`;
  * `git_info(base_dir=None, run=subprocess.run) -> {'branch', 'commit'}` (só no gesture);
  * `broker_auth(config)` → `{role, player, version, source, eegHost, acqPort}`;
  * `WebSocketBrokerClient(broker_url, player_id, meta=None, ...)`.

- [ ] **Step 1: Write the failing tests**

`tests/test_code_version.py`:

```python
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ACQ = load("acq_code_version", "eeg_acquisition/code_version.py")
GES = load("ges_code_version", "gesture_detector/code_version.py")


def tree(files):
    d = Path(tempfile.mkdtemp())
    for rel, content in files.items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content.encode("utf-8"))
    return d


class CodeVersionTests(unittest.TestCase):
    def test_reference_vector_matches_node(self):
        d = tree({"a.py": "x\r\ny\n", "sub/b.py": "z"})
        for mod in (ACQ, GES):
            self.assertEqual(mod.hash_files(d, ["sub/b.py", "a.py"]), "df00286")

    def test_crlf_and_lf_same_hash_and_byte_change_differs(self):
        crlf = tree({"a.py": "l1\r\nl2\r\n", "b.py": "b"})
        lf = tree({"a.py": "l1\nl2\n", "b.py": "b"})
        other = tree({"a.py": "l1\nl3\n", "b.py": "b"})
        self.assertEqual(ACQ.hash_files(crlf, ["a.py", "b.py"]), ACQ.hash_files(lf, ["b.py", "a.py"]))
        self.assertNotEqual(ACQ.hash_files(lf, ["a.py", "b.py"]), ACQ.hash_files(other, ["a.py", "b.py"]))

    def test_code_version_uses_only_top_level_py(self):
        d = tree({"x.py": "1", "y.py": "2", "notes.md": "n", "__pycache__/x.cpython-311.pyc": "bin"})
        self.assertEqual(GES.code_version(d), GES.hash_files(d, ["x.py", "y.py"]))
        self.assertRegex(ACQ.code_version(), r"^[0-9a-f]{7}$")

    def test_git_info_without_git_returns_none(self):
        def boom(*args, **kwargs):
            raise FileNotFoundError("git")
        self.assertEqual(GES.git_info(ROOT, run=boom), {"branch": None, "commit": None})

    def test_git_info_reads_branch_and_commit(self):
        outs = iter(["main\n", "abc1234\n"])

        def fake(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 0, stdout=next(outs), stderr="")
        self.assertEqual(GES.git_info(ROOT, run=fake), {"branch": "main", "commit": "abc1234"})


if __name__ == "__main__":
    unittest.main()
```

`tests/test_acquisition_clients.py`: trocar a asserção exata por

```python
    def test_broker_auth_identifies_acquisition_player_and_metadata(self):
        auth = acquisition_clients.broker_auth(make_config(2))
        self.assertEqual({k: auth[k] for k in ("role", "player", "source", "eegHost", "acqPort")},
                         {"role": "acquisition", "player": 2, "source": "real", "eegHost": "127.0.0.1", "acqPort": 13854})
        self.assertRegex(auth["version"], r"^[0-9a-f]{7}$")
```

e, no teste do `create_broker_client`, comparar só `kwargs["auth"]["role"]` e `["player"]`.

`tests/test_gesture_broker_client.py` (acrescentar):

```python
    def test_meta_goes_into_auth(self):
        clock, sio = FakeClock(), FakeSio(fail=False)
        client = WebSocketBrokerClient("http://x:3000", 2, meta={"version": "abc1234", "camera": 0, "commit": None},
                                       client_factory=lambda: sio, clock=clock, spawn=lambda fn: fn())
        client.connect_to_broker()
        self.assertEqual(sio.connect_calls[0][1]["auth"], {"role": "gesture", "player": 2, "version": "abc1234", "camera": 0})
```

(Um valor `None` não entra no `auth`.)

- [ ] **Step 2: Run to see it fail.** `python -m unittest discover -s tests -p "test_*.py"` → FAIL (os módulos não existem; `version` ausente; `meta` inesperado).

- [ ] **Step 3: Implement**

`eeg_acquisition/code_version.py` (o `gesture_detector/code_version.py` é igual, **mais** `git_info`):

```python
# NEU-142: versao = hash curto do proprio codigo (mesmo algoritmo de data_broker/code_version.js).
# CRLF -> LF para o checkout no Windows e o build no Docker darem o mesmo hash.
import hashlib
from pathlib import Path


def hash_files(base_dir, rel_paths):
    h = hashlib.sha256()
    for rel in sorted(str(p).replace("\\", "/") for p in rel_paths):
        content = (Path(base_dir) / rel).read_bytes().decode("utf-8").replace("\r\n", "\n")
        h.update(f"{rel}\n{content}\n".encode("utf-8"))
    return h.hexdigest()[:7]


def code_version(base_dir=None):
    base = Path(base_dir) if base_dir else Path(__file__).resolve().parent
    return hash_files(base, [p.name for p in base.glob("*.py") if p.is_file()])
```

`gesture_detector/code_version.py`, acrescentar:

```python
import subprocess


def git_info(base_dir=None, run=subprocess.run):
    """Branch e commit do checkout (o gesto roda fora do Docker). Sem git: None nos dois."""
    base = str(Path(base_dir) if base_dir else Path(__file__).resolve().parent)
    try:
        def git(*args):
            return run(["git", "-C", base, *args], capture_output=True, text=True, timeout=2, check=True).stdout.strip() or None
        return {"branch": git("rev-parse", "--abbrev-ref", "HEAD"), "commit": git("rev-parse", "--short", "HEAD")}
    except Exception:
        return {"branch": None, "commit": None}
```

`acquisition_clients.py`:

```python
from code_version import code_version

def broker_auth(config: AcquisitionConfig):
    # NEU-139/142: o broker reconhece a peca e mostra versao e ThinkGear no Diagnostico.
    return {"role": "acquisition", "player": config.player_id, "version": code_version(),
            "source": config.source, "eegHost": config.eeg_host, "acqPort": config.acq_port}
```

`broker_client.py`: no `__init__`, o novo parâmetro `meta=None`, logo depois de `player_id`. O `auth` vira `{"role": "gesture", "player": player_id, **{k: v for k, v in (meta or {}).items() if v is not None}}`.

`hand_fist_detector.py`, no `main()`:

```python
    PLAYER_ID = int(os.getenv('PLAYER_ID', '1'))
    BROKER_URL = os.getenv('BROKER_URL', 'http://localhost:3000')
    # NEU-142: indice da camera vem de CAMERA_INDEX (padrao 0, como antes); vai no Diagnostico.
    CAMERA_INDEX = int(os.getenv('CAMERA_INDEX', '0'))
    cap = cv2.VideoCapture(CAMERA_INDEX)
    detector = HandFistDetector(consecutive_frames_for_event=5)
    meta = {"version": code_version(), "camera": CAMERA_INDEX, **git_info()}
```

* Tirar o `cap = cv2.VideoCapture(0)` antigo e o `detector = ...` de antes das variáveis.
* O `WebSocketBrokerClient(BROKER_URL, PLAYER_ID, meta=meta)`.
* Import: `from code_version import code_version, git_info`.

- [ ] **Step 4: Run.** Python → OK. Conferir que o detector compila: `python -c "import ast; ast.parse(open('gesture_detector/hand_fist_detector.py', encoding='utf-8').read())"`.
- [ ] **Step 5: Commit** `feat(pecas): acquisition e gesto mandam versao por hash e metadados no auth; camera por CAMERA_INDEX [NEU-142]`.

### Task 4: `OpsState.diagnostics()` e o aviso de versão na faixa

**Files:**
- Modify: `data_broker/public/ops_state.js`
- Test: `data_broker/tests/test_diagnostics.test.js`

**Interfaces:**
- Consumes:
  * `status` do `/api/status` (Task 2);
  * `pieceState`, `pieceLine` e `STALE_MS` (já existem, NEU-139).
- Produces:
  * `OpsState.diagnostics({ status }) → { pcs: [{ name, pieces: [{ key, level, word, version, line, details }] }], versionWarnings }`;
  * `OpsState.versionWarnings(pieces) → string[]`;
  * `statusStrip()` passa a pôr os avisos **no começo** de `lines`.

- [ ] **Step 1: Write the failing test** (`data_broker/tests/test_diagnostics.test.js`)

```js
// NEU-142: blocos do Diagnostico (estado, versao, detalhes, o que fazer) e aviso de versao.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

const T = 500_000;
const piece = (extra = {}) => ({ connected: true, lastEventAt: T - 2000, attention: 61, poorSignalLevel: 26, source: 'real', handSeen: true, meta: {}, ...extra });
const off = () => ({ connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null, meta: {} });
function status(over = {}) {
  return {
    now: T,
    pieces: {
      'acquisition-p1': piece({ meta: { version: 'aaaaaaa', source: 'real', eegHost: 'host.docker.internal', acqPort: 13854 } }),
      'gesture-p1': piece({ meta: { version: 'bbbbbbb', camera: 0, commit: 'abc1234', branch: 'main' } }),
      'acquisition-p2': piece({ meta: { version: 'aaaaaaa', source: 'real', eegHost: 'host.docker.internal', acqPort: 13854 } }),
      'gesture-p2': piece({ meta: { version: 'bbbbbbb', camera: 1 } }),
    },
    game: { connections: 1, lastGameEvent: null, recentEvents: [{ event: 'raceStarted', at: T - 12_000 }, { event: 'hasFinished', at: T - 80_000 }] },
    connections: { 'acquisition-p1': 1, 'gesture-p1': 1, 'acquisition-p2': 1, 'gesture-p2': 1, panel: 2, unidentified: 1 },
    redis: { status: 'ready' },
    broker: { version: 'ccccccc', uptimeSeconds: 600 },
    ...over,
  };
}
const find = (d, key) => d.pcs.flatMap((pc) => pc.pieces).find((p) => p.key === key);

test('grupos PC CENTRAL e PC COLETOR com as pecas na ordem', () => {
  const d = S.diagnostics({ status: status() });
  assert.deepEqual(d.pcs.map((pc) => [pc.name, pc.pieces.map((p) => p.key)]), [
    ['PC CENTRAL', ['broker', 'redis', 'acquisition-p1', 'gesture-p1', 'jogo']],
    ['PC COLETOR', ['acquisition-p2', 'gesture-p2']],
  ]);
  assert.deepEqual(d.versionWarnings, []);
});

test('acquisition: estado, versao por hash e detalhes', () => {
  const p = find(S.diagnostics({ status: status() }), 'acquisition-p1');
  assert.deepEqual([p.level, p.word, p.version, p.line], ['ok', 'OK', 'código aaaaaaa', null]);
  assert.deepEqual(p.details, [['fonte', 'real'], ['ThinkGear', 'host.docker.internal:13854'], ['Poor Signal', '26'], ['atenção', '61'], ['último dado', 'há 2 s']]);
});

test('gesture: commit quando houver, senao hash; camera N = indice + 1', () => {
  const d = S.diagnostics({ status: status() });
  assert.equal(find(d, 'gesture-p1').version, 'main · abc1234');
  assert.equal(find(d, 'gesture-p2').version, 'código bbbbbbb');
  assert.deepEqual(find(d, 'gesture-p2').details, [['câmera', 'Câmera 2'], ['mão vista', 'sim'], ['última notícia', 'há 2 s']]);
});

test('peca fora: palavra, linha de o que fazer e versao desconhecida', () => {
  const st = status(); st.pieces['acquisition-p2'] = off();
  const p = find(S.diagnostics({ status: st }), 'acquisition-p2');
  assert.deepEqual([p.level, p.word, p.version], ['down', 'Fora', 'versão desconhecida']);
  assert.match(p.line, /^acquisition-p2 sem conexão · confira o ThinkGear/);
  assert.deepEqual(p.details[1], ['ThinkGear', '—']);
});

test('sem noticia ha mais de 10 s: Sem notícia', () => {
  const st = status(); st.pieces['gesture-p1'] = piece({ lastEventAt: T - 11_000, meta: {} });
  const p = find(S.diagnostics({ status: st }), 'gesture-p1');
  assert.deepEqual([p.level, p.word], ['stale', 'Sem notícia']);
});

test('broker, redis e jogo', () => {
  const d = S.diagnostics({ status: status() });
  const broker = find(d, 'broker');
  assert.deepEqual([broker.level, broker.version], ['ok', 'código ccccccc']);
  assert.deepEqual(broker.details, [['conectados', 'acquisition-p1 ×1 · gesture-p1 ×1 · acquisition-p2 ×1 · gesture-p2 ×1 · painel ×2 · não identificado (jogo) ×1'], ['no ar há', '10 min']]);
  assert.deepEqual(find(d, 'redis').details, [['estado', 'ready']]);
  const jogo = find(d, 'jogo');
  assert.deepEqual([jogo.level, jogo.version], ['ok', '—']);
  assert.deepEqual(jogo.details, [['conexões', '1'], ['últimos eventos', 'raceStarted há 12 s · hasFinished há 80 s']]);
  const st = status({ redis: { status: 'reconnecting' }, game: { connections: 0, lastGameEvent: null, recentEvents: [] } });
  const d2 = S.diagnostics({ status: st });
  assert.deepEqual([find(d2, 'redis').level, find(d2, 'redis').line], ['down', 'redis fora · reinicie o redis no PC central (a fila fica guardada)']);
  assert.deepEqual([find(d2, 'jogo').level, find(d2, 'jogo').line], ['down', 'jogo não conectado · abra o jogo no PC central']);
});

test('aviso de versao so quando o par existe e difere; peca antiga sem versao nao avisa', () => {
  const st = status(); st.pieces['acquisition-p2'].meta.version = 'ddddddd';
  assert.deepEqual(S.diagnostics({ status: st }).versionWarnings, [
    'versões diferentes entre central e coletor: acquisition (central aaaaaaa · coletor ddddddd) · atualize o coletor (git pull) e reabra as peças',
  ]);
  const old = status(); old.pieces['gesture-p2'].meta = {};
  assert.deepEqual(S.diagnostics({ status: old }).versionWarnings, []);
});

test('statusStrip poe o aviso de versao no topo das linhas', () => {
  const st = status(); st.pieces['gesture-p2'].meta.version = 'eeeeeee';
  const r = S.statusStrip({ status: st, health: { dispatcher: { enabled: true } }, overview: { counts: { waiting: 0, failed: 0 } }, waitingSince: null, now: T });
  assert.equal(r.lines[0], 'versões diferentes entre central e coletor: gesture (central bbbbbbb · coletor eeeeeee) · atualize o coletor (git pull) e reabra as peças');
});

test('sem status (broker sem resposta): nada a mostrar', () => {
  assert.deepEqual(S.diagnostics({ status: null }), { pcs: [], versionWarnings: [] });
});
```

- [ ] **Step 2: Run to see it fail.** `node --test tests/test_diagnostics.test.js` → FAIL (`S.diagnostics is not a function`).

- [ ] **Step 3: Implement** em `ops_state.js`, depois de `statusStrip`, e exportar `diagnostics` e `versionWarnings`:

```js
  // ---------- NEU-142: Diagnostico ----------
  const DIAG_WORD = { ok: 'OK', stale: 'Sem notícia', down: 'Fora' };
  const CONN_LABEL = [['acquisition-p1', 'acquisition-p1'], ['gesture-p1', 'gesture-p1'], ['acquisition-p2', 'acquisition-p2'], ['gesture-p2', 'gesture-p2'], ['panel', 'painel'], ['test-client', 'test-client'], ['unidentified', 'não identificado (jogo)']];

  function ago(ms) {
    return ms === null || ms === undefined || !Number.isFinite(ms) ? '—' : `há ${Math.max(0, Math.round(ms / 1000))} s`;
  }

  function versionLabel(key, meta) {
    if (key.startsWith('gesture') && meta.commit) return `${meta.branch || '?'} · ${meta.commit}`;
    return meta.version ? `código ${meta.version}` : 'versão desconhecida';
  }

  function versionWarnings(pieces) {
    const out = [];
    for (const role of ['acquisition', 'gesture']) {
      const v1 = pieces[`${role}-p1`] && pieces[`${role}-p1`].meta && pieces[`${role}-p1`].meta.version;
      const v2 = pieces[`${role}-p2`] && pieces[`${role}-p2`].meta && pieces[`${role}-p2`].meta.version;
      if (v1 && v2 && v1 !== v2) out.push(`versões diferentes entre central e coletor: ${role} (central ${v1} · coletor ${v2}) · atualize o coletor (git pull) e reabra as peças`);
    }
    return out;
  }

  function diagnostics({ status }) {
    if (!status) return { pcs: [], versionWarnings: [] };
    const t = Number(status.now);
    const pieces = status.pieces || {};
    const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
    function ourPiece(key) {
      const p = pieces[key] || {}; const meta = p.meta || {};
      const st = pieceState(p, t);
      const age = p.lastEventAt === null || p.lastEventAt === undefined ? null : t - p.lastEventAt;
      const details = key.startsWith('acquisition')
        ? [['fonte', dash(meta.source)], ['ThinkGear', meta.eegHost ? `${meta.eegHost}:${dash(meta.acqPort)}` : '—'], ['Poor Signal', dash(p.poorSignalLevel)], ['atenção', dash(p.attention)], ['último dado', ago(age)]]
        : [['câmera', meta.camera === undefined ? '—' : `Câmera ${Number(meta.camera) + 1}`], ['mão vista', p.handSeen === null || p.handSeen === undefined ? '—' : p.handSeen ? 'sim' : 'não'], ['última notícia', ago(age)]];
      return { key, level: st, word: DIAG_WORD[st], version: versionLabel(key, meta), line: st === 'ok' ? null : pieceLine(key, st), details };
    }
    const conns = status.connections || {};
    const connText = CONN_LABEL.filter(([k]) => conns[k]).map(([k, label]) => `${label} ×${conns[k]}`).join(' · ') || 'ninguém';
    const uptime = status.broker && Number(status.broker.uptimeSeconds);
    const broker = {
      key: 'broker', level: 'ok', word: DIAG_WORD.ok, line: null,
      version: status.broker && status.broker.version ? `código ${status.broker.version}` : 'versão desconhecida',
      details: [['conectados', connText], ['no ar há', Number.isFinite(uptime) ? `${Math.floor(uptime / 60)} min` : '—']],
    };
    const redisOk = status.redis && status.redis.status === 'ready';
    const redis = {
      key: 'redis', level: redisOk ? 'ok' : 'down', word: redisOk ? DIAG_WORD.ok : DIAG_WORD.down, version: '—',
      line: redisOk ? null : 'redis fora · reinicie o redis no PC central (a fila fica guardada)',
      details: [['estado', dash(status.redis && status.redis.status)]],
    };
    const game = status.game || {};
    const gameOk = Number(game.connections) > 0;
    const jogo = {
      key: 'jogo', level: gameOk ? 'ok' : 'down', word: gameOk ? DIAG_WORD.ok : DIAG_WORD.down, version: '—',
      line: gameOk ? null : 'jogo não conectado · abra o jogo no PC central',
      details: [['conexões', String(Number(game.connections) || 0)], ['últimos eventos', (game.recentEvents || []).map((e) => `${e.event} ${ago(t - e.at)}`).join(' · ') || '—']],
    };
    return {
      pcs: [
        { name: 'PC CENTRAL', pieces: [broker, redis, ourPiece('acquisition-p1'), ourPiece('gesture-p1'), jogo] },
        { name: 'PC COLETOR', pieces: [ourPiece('acquisition-p2'), ourPiece('gesture-p2')] },
      ],
      versionWarnings: versionWarnings(pieces),
    };
  }
```

E, em `statusStrip`, logo depois de `const lines = [];`: `lines.push(...versionWarnings(pieces));`. Para isso, mover o `const pieces = status.pieces || {};` para antes dessa linha, se preciso.

- [ ] **Step 4: Run.** `npm --prefix data_broker run validate` → PASS, incluindo `test_status_strip` intacto.
- [ ] **Step 5: Commit** `feat(ops): diagnostics() com estado, versao, detalhes e aviso de versao na faixa [NEU-142]`.

### Task 5: Painel — abas e blocos do Diagnóstico

**Files:**
- Modify: `data_broker/public/index.html`, `ops.js`, `ops.css`
- Test: `data_broker/tests/test_ops_screen.test.js` (+ marcação)

**Interfaces:**
- Consumes: `OpsState.diagnostics` (Task 4); `st.status` (já existe, NEU-139).

- [ ] **Step 1: Write the failing test.** Acrescentar no teste de marcação:

```js
    // NEU-142: abas e blocos fixos do Diagnostico.
    assert.match(res.body, /data-tab="ops"/); assert.match(res.body, /data-tab="diag"/);
    assert.match(res.body, /data-panel="diag"/);
    for (const k of ['broker', 'redis', 'acquisition-p1', 'gesture-p1', 'jogo', 'acquisition-p2', 'gesture-p2']) assert.match(res.body, new RegExp(`data-diag="${k}"`));
```

- [ ] **Step 2: Run to see it fail.** `node --test tests/test_ops_screen.test.js` → FAIL (`data-tab`).

- [ ] **Step 3: Implement**

`index.html`: logo depois da `</section>` da faixa:

```html
  <nav class="tabs" role="tablist" aria-label="Telas do painel">
    <button type="button" role="tab" class="tab" data-tab="ops" aria-selected="true">Operação</button>
    <button type="button" role="tab" class="tab" data-tab="diag" aria-selected="false">Diagnóstico</button>
  </nav>
```

* O `<main class="grid">` ganha `data-panel="ops"`.
* Depois do `</main>`, a seção do Diagnóstico com os 7 blocos (gerar por script, um por chave):

```html
  <section class="diag" data-panel="diag" hidden aria-label="Diagnóstico">
    <div class="diag-pc"><h2 class="diag-pc-name">PC CENTRAL</h2>
      <!-- broker, redis, acquisition-p1, gesture-p1, jogo -->
    </div>
    <div class="diag-pc"><h2 class="diag-pc-name">PC COLETOR</h2>
      <!-- acquisition-p2, gesture-p2 -->
    </div>
  </section>
```

Cada bloco, com `KEY`:

```html
      <details class="diag-piece" data-diag="KEY" data-level="unknown">
        <summary><i class="dot"></i><span class="diag-name mono">KEY</span><b class="mono" data-diag-word>—</b><span class="diag-version mono" data-diag-version>—</span></summary>
        <p class="diag-line mono" data-diag-line hidden></p>
        <dl class="diag-details" data-diag-details></dl>
      </details>
```

`ops.js`:

```js
  // ---------- NEU-142: abas e Diagnostico ----------
  document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  }));
  const DIAG_KEYS = ['broker', 'redis', 'acquisition-p1', 'gesture-p1', 'jogo', 'acquisition-p2', 'gesture-p2'];
  function renderDiag() {
    const d = S.diagnostics({ status: st.status });
    const byKey = Object.fromEntries(d.pcs.flatMap((pc) => pc.pieces).map((p) => [p.key, p]));
    for (const key of DIAG_KEYS) {
      const el = $(`[data-diag="${key}"]`); const p = byKey[key];
      el.dataset.level = p ? p.level : 'unknown';
      el.querySelector('[data-diag-word]').textContent = p ? p.word : '—';
      el.querySelector('[data-diag-version]').textContent = p ? p.version : '—';
      const line = el.querySelector('[data-diag-line]');
      line.hidden = !(p && p.line); line.textContent = p && p.line ? p.line : '';
      // So refaz a lista quando muda: o <details> continua aberto de qualquer jeito.
      const dl = el.querySelector('[data-diag-details]'); const detailsKey = JSON.stringify(p ? p.details : []);
      if (dl.dataset.key !== detailsKey) {
        dl.dataset.key = detailsKey; dl.replaceChildren();
        for (const [label, value] of (p ? p.details : [])) {
          const dt = document.createElement('dt'); dt.textContent = label;
          const dd = document.createElement('dd'); dd.className = 'mono'; dd.textContent = value;
          dl.append(dt, dd);
        }
      }
    }
  }
```

Incluir `renderDiag()` em `render()` (depois de `renderStrip()`).

`ops.css` (antes do `@media (max-width: 720px)`):

```css
/* Abas e Diagnostico (NEU-142) */
/* `display: grid` do .grid/.diag sobrepoe o [hidden] do navegador: forcar aqui. */
[data-panel][hidden] { display: none; }
.tabs { display: flex; gap: 0.4rem; max-width: 1100px; margin: 0 auto 1rem; }
.tab { font: inherit; padding: 0.35rem 0.9rem; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--fg-muted); cursor: pointer; }
.tab[aria-selected="true"] { color: var(--fg-strong); border-color: var(--fg-muted); background: var(--bg-elev); }
.tab:focus-visible { outline: 2px solid var(--fg-strong); outline-offset: 2px; }
.diag { max-width: 1100px; margin: 0 auto; display: grid; gap: 1rem; }
.diag-pc { border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); padding: 0.8rem 1rem; }
.diag-pc-name { margin: 0 0 0.6rem; font-size: 0.8rem; letter-spacing: 0.08em; color: var(--fg-muted); }
.diag-piece { border-top: 1px solid var(--hairline); padding: 0.5rem 0; }
.diag-piece summary { display: flex; gap: 0.6rem; align-items: center; cursor: pointer; list-style: none; }
.diag-piece summary::-webkit-details-marker { display: none; }
.diag-name { color: var(--fg-strong); min-width: 9rem; }
.diag-piece b { font-weight: 500; font-size: 0.8rem; color: var(--fg-muted); min-width: 6rem; }
.diag-version { color: var(--fg-muted); font-size: 0.8rem; }
.diag-piece[data-level="ok"] .dot { background: var(--ok); } .diag-piece[data-level="ok"] b { color: var(--ok); }
.diag-piece[data-level="stale"] .dot { background: var(--warn); } .diag-piece[data-level="stale"] b { color: var(--warn); }
.diag-piece[data-level="down"] .dot { background: var(--error); } .diag-piece[data-level="down"] b { color: var(--error); }
.diag-line { margin: 0.4rem 0 0 1.4rem; color: var(--warn); font-size: 0.82rem; }
.diag-details { display: grid; grid-template-columns: 9rem 1fr; gap: 0.2rem 0.8rem; margin: 0.5rem 0 0 1.4rem; font-size: 0.85rem; }
.diag-details dt { color: var(--fg-muted); } .diag-details dd { margin: 0; color: var(--fg); }
```

- [ ] **Step 4: Run.** `npm --prefix data_broker run validate` → PASS.
- [ ] **Step 5: Commit** `feat(ops): aba Diagnostico com estado, versao, detalhes e o que fazer por peca [NEU-142]`.

### Task 6: E2E, docs e PR

- [ ] **Step 1: Docs.**
  * `docs/event-contracts.md`, na tabela de `auth`: acquisition `{ role, player, version, source, eegHost, acqPort }` e gesture `{ role, player, version, commit, branch, camera }`; a regra de filtro dos metadados; `/api/status` com `connections`, `game.recentEvents` e `broker { version, uptimeSeconds }`.
  * `README.md`: `CAMERA_INDEX` do detector de gesto.

- [ ] **Step 2: E2E**, com `API_URL` vazio e o perfil `banca` com a imagem nova, mais o gesto falso com `meta` (o script do scratchpad da NEU-139, passando `meta={"version": code_version(), "camera": 0, **git_info()}`):
  * As 4 peças com a mesma versão → nenhum aviso. O Diagnóstico mostra os 7 blocos; ao abrir o `acquisition-p1`, aparecem fonte, ThinkGear, Poor Signal, atenção e último dado.
  * **Critério de pronto:**
    1. acrescentar uma linha de comentário em `eeg_acquisition/acquisition_core.py`;
    2. `docker compose --profile banca build acquisition-b-sim && docker compose --profile banca up -d acquisition-b-sim`;
    3. o aviso `versões diferentes … acquisition (central X · coletor Y)` aparece na faixa;
    4. **reverter** o arquivo (`git checkout -- eeg_acquisition/acquisition_core.py`) e reconstruir a `acquisition-b-sim`.
  * Bloco aberto no Diagnóstico continua aberto depois de 5 s de atualização.
  * Encerrar com `docker compose --profile banca stop` (**nunca `down -v`**).

- [ ] **Step 3: Suítes completas.**
  * Node em série, com um Redis descartável na porta 6399;
  * Python;
  * `scripts/validate-compose-ports.sh` e `validate-compose-banca.sh`.

- [ ] **Step 4: Commit, push e PR**, com o token do `santos-nikolas` por comando.
