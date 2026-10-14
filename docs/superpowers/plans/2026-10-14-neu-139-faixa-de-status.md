# NEU-139 — Faixa de status e cards: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O painel mostra, num olhar, se Central, Coletor, Jogo e Nuvem estão bem (com o que fazer). Cada jogador tem atenção, Poor Signal, gesto e "Sem dados" ao vivo.

**Architecture:**
* As peças nossas (`acquisition`, `gesture`, painel, `test_client`) se apresentam no connect do socket.io com `auth`. O jogo não se apresenta e é reconhecido como a conexão anônima.
* O broker mantém um registro de presença em memória (`presence.js`) e o expõe em `GET /api/status`, com o relógio do broker.
* O painel calcula a faixa numa função pura (`OpsState.statusStrip`). Os cards usam os eventos que o painel já recebe pelo socket.

**Tech Stack:**
* Node 22 (CommonJS, `node:test`) e socket.io 4.
* Python 3.11, python-socketio 5.14 e `unittest`.
* HTML/CSS/JS sem build (`data_broker/public`).

**Spec:** `docs/superpowers/specs/2026-10-14-neu-139-faixa-de-status-design.md`. A spec de produto está no Linear ("Spec: painel de operação plug-and-play (V2)", seções A e B).

## Global Constraints

* **Limites:**
  * peça sem notícia há **mais de 10 s** não é verde;
  * "Sem dados" no card após **10 s** sem `eSense`;
  * espera longa da nuvem: **30 s** (`QUEUE_STUCK_MS`).
* **Cores do Poor Signal:** 0 verde, 1 a 199 amarelo, 200 vermelho; com Bot, "simulado".
* **Cor sempre junto de palavra:** OK, Atenção, Fora. Cinza quando não se sabe.
* **Textos da faixa:** exatamente os da tabela da spec, seção 5.
* **`auth` inválido ou ausente nunca derruba a conexão.** O socket vira `unidentified`, que conta como jogo.
* **O `gestureStatus` nunca é repassado** a outros clientes.
* **Dados do broker entram no DOM só por `textContent`,** nunca como HTML (regra do repo).
* **Testes:** `cd data_broker && npm run validate`; Python com `python -m unittest discover -s tests -p "test_*.py"` (na raiz).
* **Commits:** terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`player` chega como string** (`"2"`, vindo de variável de ambiente) no `auth`. Esperado: vale como player 2. O teste fica na Task 1.
2. **Reconexão com o socket velho ainda aberto** (dois sockets da mesma peça). Esperado: a peça segue conectada e vale a notícia mais recente. O teste fica na Task 1.
3. **Peça conectada que nunca mandou nada** (fone desligado desde o início, ou gesto antes do 1º sinal). Esperado: amarelo "sem dados" ou "sem notícia", nunca verde. O teste fica na Task 4.
4. **Painel aberto em duas abas.** Esperado: nenhuma aba conta como jogo. O teste fica na Task 2.
5. **`/health` falha mas `/api/status` responde.** Esperado: a Nuvem fica cinza (não sei), não "desligada". O teste fica na Task 4.

## File Structure

| Arquivo | Responsabilidade |
| -- | -- |
| `data_broker/presence.js` (novo) | registro de presença: `auth` → peça, último evento, snapshot |
| `data_broker/event_contracts.js` | + validação de `gestureStatus` |
| `data_broker/socket_handlers.js` | liga a presença no connect, nos eventos e no disconnect; `gestureStatus` sem broadcast |
| `data_broker/http_server.js` | `GET /api/status` |
| `data_broker/index.js` | instancia a presença e monta o status (com o Redis) |
| `data_broker/public/ops_state.js` | + `statusStrip`, `pslLevel`, `STALE_MS` |
| `data_broker/public/index.html`, `ops.js`, `ops.css` | faixa, cards, `auth` do painel, sem relógio |
| `eeg_acquisition/acquisition_clients.py` | `auth` no connect |
| `gesture_detector/broker_client.py` | `auth`, reconexão sem exceção, `StatusTicker` e payload de status |
| `gesture_detector/hand_fist_detector.py` | `last_hand_seen` e envio do `gestureStatus` a cada 2 s |
| `test_client/test-client.js` | `auth: { role: 'test-client' }` |
| `docs/event-contracts.md` | `auth`, `gestureStatus` e `/api/status` |

---

### Task 1: Registro de presença (`presence.js`)

**Files:**
- Create: `data_broker/presence.js`
- Test: `data_broker/tests/test_presence.test.js`

**Interfaces:**
- Produces:
  - `createPresence()` → `{ onConnect(socketId, auth, now) → key, onEvent(socketId, event, payload, now), onDisconnect(socketId), snapshot() → { pieces: { [key]: { connected, lastEventAt, attention, poorSignalLevel, source, handSeen } }, game: { connections, lastGameEvent } } }`;
  - `keyFromAuth(auth) → 'acquisition-p1'|'acquisition-p2'|'gesture-p1'|'gesture-p2'|'panel'|'test-client'|'unidentified'`;
  - `PIECES` (array das 4 chaves de peça).

- [ ] **Step 1: Write the failing test** (`data_broker/tests/test_presence.test.js`)

```js
// NEU-139: quem esta conectado ao broker e quando deu noticia.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresence, keyFromAuth, PIECES } = require('../presence');

test('keyFromAuth: papeis validos, player como string e auth invalido', () => {
  assert.equal(keyFromAuth({ role: 'acquisition', player: 1 }), 'acquisition-p1');
  assert.equal(keyFromAuth({ role: 'gesture', player: '2' }), 'gesture-p2', 'player de env chega como string');
  assert.equal(keyFromAuth({ role: 'panel' }), 'panel');
  assert.equal(keyFromAuth({ role: 'test-client' }), 'test-client');
  assert.equal(keyFromAuth({ role: 'acquisition', player: 3 }), 'unidentified');
  assert.equal(keyFromAuth({ role: 'hacker' }), 'unidentified');
  assert.equal(keyFromAuth(undefined), 'unidentified');
  assert.equal(keyFromAuth('lixo'), 'unidentified');
});

test('snapshot: peca esperada sem socket fica desconectada', () => {
  const p = createPresence();
  const s = p.snapshot();
  assert.deepEqual(Object.keys(s.pieces), PIECES);
  assert.deepEqual(s.pieces['acquisition-p2'], { connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null });
  assert.deepEqual(s.game, { connections: 0, lastGameEvent: null });
});

test('eSense e gestureStatus atualizam a peca; desconectar tira', () => {
  const p = createPresence();
  p.onConnect('a2', { role: 'acquisition', player: 2 }, 100);
  p.onConnect('g2', { role: 'gesture', player: 2 }, 100);
  p.onEvent('a2', 'eSense', { player: 2, attention: 70, poorSignalLevel: 26, source: 'real' }, 500);
  p.onEvent('g2', 'gestureStatus', { player: 2, handSeen: true }, 600);
  let s = p.snapshot();
  assert.deepEqual(s.pieces['acquisition-p2'], { connected: true, lastEventAt: 500, attention: 70, poorSignalLevel: 26, source: 'real', handSeen: null });
  assert.equal(s.pieces['gesture-p2'].handSeen, true);
  assert.equal(s.pieces['gesture-p2'].lastEventAt, 600);
  p.onDisconnect('a2');
  s = p.snapshot();
  assert.equal(s.pieces['acquisition-p2'].connected, false);
  assert.equal(s.pieces['acquisition-p2'].lastEventAt, null);
});

test('conectada sem nunca mandar nada: connected sem lastEventAt', () => {
  const p = createPresence();
  p.onConnect('a1', { role: 'acquisition', player: 1 }, 100);
  assert.deepEqual([p.snapshot().pieces['acquisition-p1'].connected, p.snapshot().pieces['acquisition-p1'].lastEventAt], [true, null]);
});

test('reconexao com socket velho aberto: vale a noticia mais recente', () => {
  const p = createPresence();
  p.onConnect('old', { role: 'acquisition', player: 1 }, 100);
  p.onEvent('old', 'eSense', { attention: 10, poorSignalLevel: 0, source: 'real' }, 200);
  p.onConnect('new', { role: 'acquisition', player: 1 }, 300);
  p.onEvent('new', 'eSense', { attention: 90, poorSignalLevel: 0, source: 'real' }, 400);
  let piece = p.snapshot().pieces['acquisition-p1'];
  assert.deepEqual([piece.connected, piece.lastEventAt, piece.attention], [true, 400, 90]);
  p.onDisconnect('old');
  piece = p.snapshot().pieces['acquisition-p1'];
  assert.deepEqual([piece.connected, piece.attention], [true, 90]);
});

test('jogo = conexoes nao identificadas; painel e test-client nao contam', () => {
  const p = createPresence();
  p.onConnect('panel-1', { role: 'panel' }, 1);
  p.onConnect('panel-2', { role: 'panel' }, 1);
  p.onConnect('tc', { role: 'test-client' }, 1);
  assert.equal(p.snapshot().game.connections, 0);
  p.onConnect('game', {}, 1);
  p.onEvent('game', 'raceStarted', {}, 50);
  p.onEvent('panel-1', 'hasFinished', {}, 60);
  assert.deepEqual(p.snapshot().game, { connections: 1, lastGameEvent: { event: 'raceStarted', at: 50 } });
});

test('evento de socket desconhecido e ignorado', () => {
  const p = createPresence();
  assert.doesNotThrow(() => p.onEvent('nope', 'eSense', { attention: 1 }, 1));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd data_broker && node --test tests/test_presence.test.js`
Expected: FAIL (`Cannot find module '../presence'`).

- [ ] **Step 3: Write minimal implementation** (`data_broker/presence.js`)

```js
// data_broker/presence.js
// NEU-139: quem esta conectado ao broker e quando deu noticia pela ultima vez.
// Cada peca nossa se apresenta no connect (`socket.handshake.auth`); o jogo nao se
// apresenta e e reconhecido como a conexao anonima (fallback da spec, secao 8).
const PIECES = ['acquisition-p1', 'gesture-p1', 'acquisition-p2', 'gesture-p2'];
const ROLES_WITH_PLAYER = new Set(['acquisition', 'gesture']);
const ROLES_WITHOUT_PLAYER = new Set(['panel', 'test-client']);
const GAME_EVENTS = new Set(['raceStarted', 'hasFinished', 'gameEvent']);

// Auth ausente ou invalido nunca derruba a conexao: vira 'unidentified' (= jogo).
function keyFromAuth(auth) {
  const role = auth && typeof auth === 'object' && typeof auth.role === 'string' ? auth.role : null;
  if (ROLES_WITH_PLAYER.has(role)) {
    const player = Number(auth.player);
    return player === 1 || player === 2 ? `${role}-p${player}` : 'unidentified';
  }
  if (ROLES_WITHOUT_PLAYER.has(role)) return role;
  return 'unidentified';
}

function emptyPiece() {
  return { connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null };
}

function createPresence() {
  const sockets = new Map(); // socketId -> { key, lastEventAt, data, lastGameEvent }

  function onConnect(socketId, auth, now) {
    const key = keyFromAuth(auth);
    sockets.set(socketId, { key, connectedAt: now, lastEventAt: null, data: {}, lastGameEvent: null });
    return key;
  }

  function onEvent(socketId, event, payload, now) {
    const s = sockets.get(socketId);
    if (!s) return;
    s.lastEventAt = now;
    const p = payload && typeof payload === 'object' ? payload : {};
    if (event === 'eSense') {
      s.data.attention = p.attention ?? null;
      s.data.poorSignalLevel = p.poorSignalLevel ?? null;
      s.data.source = p.source ?? null;
    } else if (event === 'gestureStatus') {
      s.data.handSeen = p.handSeen === true;
    }
    if (s.key === 'unidentified' && GAME_EVENTS.has(event)) s.lastGameEvent = { event, at: now };
  }

  function onDisconnect(socketId) {
    sockets.delete(socketId);
  }

  function snapshot() {
    const all = [...sockets.values()];
    const pieces = {};
    for (const key of PIECES) {
      const mine = all.filter((s) => s.key === key);
      if (mine.length === 0) { pieces[key] = emptyPiece(); continue; }
      // Reconexao com o socket velho ainda aberto: vale o que deu noticia por ultimo.
      const latest = mine.reduce((best, s) => ((s.lastEventAt ?? -1) > (best.lastEventAt ?? -1) ? s : best));
      pieces[key] = { ...emptyPiece(), ...latest.data, connected: true, lastEventAt: latest.lastEventAt };
    }
    const game = all.filter((s) => s.key === 'unidentified');
    const lastGameEvent = game.map((s) => s.lastGameEvent).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
    return { pieces, game: { connections: game.length, lastGameEvent } };
  }

  return { onConnect, onEvent, onDisconnect, snapshot };
}

module.exports = { createPresence, keyFromAuth, PIECES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd data_broker && node --test tests/test_presence.test.js`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add data_broker/presence.js data_broker/tests/test_presence.test.js
git commit -m "feat(broker): registro de presenca das pecas por auth do socket [NEU-139]"
```

### Task 2: Broker liga a presença, `gestureStatus` e `GET /api/status`

**Files:**
- Modify: `data_broker/event_contracts.js` (+ `validateGestureStatusPayload`)
- Modify: `data_broker/socket_handlers.js` (`createForwardEventHandler` e `registerSocketHandlers`)
- Modify: `data_broker/http_server.js` (parâmetro `getStatus`, rota)
- Modify: `data_broker/index.js`
- Test: `data_broker/tests/test_presence_wiring.test.js`

**Interfaces:**
- Consumes: `createPresence()` (Task 1).
- Produces:
  - `registerSocketHandlers(io, log, runtimeState, session, presence = null, now = Date.now)`;
  - `createHttpServer(getHealthSnapshot, session, log, dispatchAdmin, getStatus = null)`;
  - `GET /api/status` → `{ now, pieces, game, redis: { status } }`;
  - `validateEventPayload('gestureStatus', p)` → `null` ou um código de erro.

- [ ] **Step 1: Write the failing test** (`data_broker/tests/test_presence_wiring.test.js`)

```js
// NEU-139: o broker alimenta a presenca e expoe /api/status.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { registerSocketHandlers } = require('../socket_handlers');
const { createRuntimeState } = require('../runtime_state');
const { createPresence } = require('../presence');
const { createHttpServer } = require('../http_server');
const { validateEventPayload } = require('../event_contracts');

function fakeIo() {
  const io = new EventEmitter();
  const connect = (id, auth) => {
    const socket = new EventEmitter();
    socket.id = id;
    socket.handshake = { auth };
    socket.broadcast = { emitted: [], emit(event, payload) { this.emitted.push({ event, payload }); } };
    io.emit('connection', socket);
    return socket;
  };
  return { io, connect };
}

const esense = { player: 2, attention: 70, meditation: 50, eegPower: {}, poorSignalLevel: 0, status: 'ok', source: 'real', timeStamp: 1 };

test('gestureStatus: valido atualiza a presenca e NAO faz broadcast', () => {
  const { io, connect } = fakeIo();
  const presence = createPresence();
  let clock = 1000;
  registerSocketHandlers(io, () => {}, createRuntimeState(), null, presence, () => clock);
  const g = connect('g2', { role: 'gesture', player: 2 });
  clock = 2000;
  g.emit('gestureStatus', { player: 2, handSeen: true, timeStamp: 1 });
  assert.deepEqual(g.broadcast.emitted, []);
  const piece = presence.snapshot().pieces['gesture-p2'];
  assert.deepEqual([piece.connected, piece.lastEventAt, piece.handSeen], [true, 2000, true]);
  g.emit('gestureStatus', { player: 2, handSeen: 'sim' });
  assert.equal(presence.snapshot().pieces['gesture-p2'].handSeen, true, 'payload invalido nao muda a presenca');
});

test('eSense valido atualiza a presenca e continua com broadcast; disconnect tira', () => {
  const { io, connect } = fakeIo();
  const presence = createPresence();
  registerSocketHandlers(io, () => {}, createRuntimeState(), null, presence, () => 5000);
  const a = connect('a2', { role: 'acquisition', player: 2 });
  a.emit('eSense', esense);
  assert.equal(a.broadcast.emitted.length, 1);
  assert.equal(presence.snapshot().pieces['acquisition-p2'].lastEventAt, 5000);
  a.emit('disconnect', 'transport close');
  assert.equal(presence.snapshot().pieces['acquisition-p2'].connected, false);
});

test('duas abas do painel nao contam como jogo; conexao anonima conta', () => {
  const { io, connect } = fakeIo();
  const presence = createPresence();
  registerSocketHandlers(io, () => {}, createRuntimeState(), null, presence);
  connect('p1', { role: 'panel' });
  connect('p2', { role: 'panel' });
  assert.equal(presence.snapshot().game.connections, 0);
  connect('game', undefined);
  assert.equal(presence.snapshot().game.connections, 1);
});

test('sem presenca, o broker segue funcionando como antes', () => {
  const { io, connect } = fakeIo();
  registerSocketHandlers(io, () => {}, createRuntimeState(), null);
  const a = connect('a1', undefined);
  assert.doesNotThrow(() => a.emit('gestureStatus', { player: 1, handSeen: true, timeStamp: 1 }));
  a.emit('eSense', { ...esense, player: 1 });
  assert.equal(a.broadcast.emitted.length, 1);
});

test('validateEventPayload gestureStatus', () => {
  assert.equal(validateEventPayload('gestureStatus', { player: 1, handSeen: false, timeStamp: 1 }), null);
  assert.equal(validateEventPayload('gestureStatus', { player: 1, handSeen: 'x', timeStamp: 1 }), 'handSeen_must_be_boolean');
  assert.equal(validateEventPayload('gestureStatus', null), 'payload_must_be_object');
});

test('GET /api/status devolve o que getStatus monta; sem getStatus = 404', async () => {
  const body = { now: 9, pieces: {}, game: { connections: 0, lastGameEvent: null }, redis: { status: 'ready' } };
  for (const [getStatus, expected] of [[() => body, 200], [null, 404]]) {
    const server = createHttpServer(() => ({ status: 'ok' }), null, () => {}, null, getStatus);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/status' }, (r) => {
        let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }).on('error', reject);
    });
    server.close();
    assert.equal(res.status, expected);
    if (expected === 200) assert.deepEqual(JSON.parse(res.body), body);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd data_broker && node --test tests/test_presence_wiring.test.js`
Expected: FAIL. A presença não é alimentada, falta o `gestureStatus` em `validateEventPayload` e a rota dá 404.

- [ ] **Step 3: Implement**

`event_contracts.js`: acrescentar antes de `validateEventPayload` e um `case`:

```js
// NEU-139: sinal de vida do detector de gesto (a cada 2 s). So alimenta a presenca.
function validateGestureStatusPayload(payload) {
  if (!isPlainObject(payload)) return 'payload_must_be_object';
  if (!isFiniteNumber(payload.player)) return 'player_must_be_number';
  if (typeof payload.handSeen !== 'boolean') return 'handSeen_must_be_boolean';
  return null;
}
```
```js
    case 'gestureStatus':
      return validateGestureStatusPayload(payload);
```

`socket_handlers.js`:
* `createForwardEventHandler({ log, socket, event, runtimeState, session, presence = null, now = Date.now })`: logo depois de `runtimeState.markEventValidated();`, acrescentar `if (presence) presence.onEvent(socket.id, event, payload, now());`.
* `registerSocketHandlers`:

```js
function registerSocketHandlers(io, log, runtimeState, session, presence = null, now = Date.now) {
  io.on('connection', (socket) => {
    runtimeState.markClientConnected();
    const piece = presence ? presence.onConnect(socket.id, socket.handshake && socket.handshake.auth, now()) : null;
    log('info', 'client_connected', { socketId: socket.id, piece });

    socket.on('disconnect', (reason) => {
      runtimeState.markClientDisconnected();
      if (presence) presence.onDisconnect(socket.id);
      log('info', 'client_disconnected', { socketId: socket.id, piece, reason });
    });

    for (const event of BROKER_EVENTS) {
      socket.on(event, createForwardEventHandler({ log, socket, event, runtimeState, session, presence, now }));
    }

    // NEU-139: sinal de vida do gesto. NAO entra em BROKER_EVENTS: nunca e repassado.
    socket.on('gestureStatus', (payload) => {
      if (!presence || validateEventPayload('gestureStatus', payload) !== null) return;
      presence.onEvent(socket.id, 'gestureStatus', payload, now());
    });
  });
}
```

`http_server.js`: assinatura `createHttpServer(getHealthSnapshot, session, log = () => {}, dispatchAdmin = null, getStatus = null)` e, logo depois do `/health`:

```js
    // NEU-139: presenca das pecas para a faixa de status (relogio do broker em `now`).
    if (getStatus && req.method === 'GET' && req.url === '/api/status') {
      sendJson(res, 200, getStatus());
      return;
    }
```

`index.js`:

```js
const { createPresence } = require('./presence');
// ...
const presence = createPresence();
const getStatus = () => ({ now: Date.now(), ...presence.snapshot(), redis: { status: redis.status } });
const server = createHttpServer(() => runtimeState.snapshot(), session, log, dispatchAdmin, getStatus);
// ...
registerSocketHandlers(io, log, runtimeState, session, presence);
```

- [ ] **Step 4: Run tests**

Run: `cd data_broker && npm run validate`
Expected: todos passam (os de integração são pulados sem `REDIS_URL`).

- [ ] **Step 5: Commit**

```bash
git add data_broker/event_contracts.js data_broker/socket_handlers.js data_broker/http_server.js data_broker/index.js data_broker/tests/test_presence_wiring.test.js
git commit -m "feat(broker): presenca no socket, gestureStatus sem broadcast e GET /api/status [NEU-139]"
```

### Task 3: Peças se apresentam (Python e `test_client`)

**Files:**
- Modify: `eeg_acquisition/acquisition_clients.py`
- Modify: `gesture_detector/broker_client.py` (reescrita)
- Modify: `gesture_detector/hand_fist_detector.py`
- Modify: `test_client/test-client.js`
- Test: `tests/test_acquisition_clients.py`, `tests/test_gesture_broker_client.py`

**Interfaces:**
- Produces:
  - `broker_auth(config) -> dict` (acquisition);
  - `WebSocketBrokerClient(broker_url, player_id, client_factory=..., clock=time.monotonic)` com `connect_to_broker() -> bool`, `send_event(event_type, payload) -> bool` e `close()`;
  - `StatusTicker(interval_s=2.0, clock=time.monotonic).due() -> bool`;
  - `gesture_status_payload(player_id, hand_seen, now_ms) -> dict`.

- [ ] **Step 1: Write the failing tests**

`tests/test_acquisition_clients.py`:

```python
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg_acquisition"))

import acquisition_clients  # noqa: E402
from acquisition_config import AcquisitionConfig  # noqa: E402


def make_config(player_id=2):
    return AcquisitionConfig(
        player_id=player_id, acq_port=13854, eeg_host="127.0.0.1", broker_url="http://broker:3000",
        source="real", buffer_size=4096, poor_signal_level_threshold=0, eeg_connect_timeout_seconds=5,
        eeg_read_timeout_seconds=10, broker_connect_timeout_seconds=5, retry_base_delay_seconds=1,
        retry_max_delay_seconds=10, max_reconnect_attempts=0,
    )


class BrokerAuthTests(unittest.TestCase):
    def test_broker_auth_identifies_acquisition_and_player(self):
        self.assertEqual(acquisition_clients.broker_auth(make_config(2)), {"role": "acquisition", "player": 2})

    def test_create_broker_client_sends_auth_on_connect(self):
        with mock.patch.object(acquisition_clients.socketio, "Client") as client_cls:
            acquisition_clients.create_broker_client(make_config(1))
        _, kwargs = client_cls.return_value.connect.call_args
        self.assertEqual(kwargs["auth"], {"role": "acquisition", "player": 1})


if __name__ == "__main__":
    unittest.main()
```

`tests/test_gesture_broker_client.py`:

```python
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gesture_detector"))

from broker_client import StatusTicker, WebSocketBrokerClient, gesture_status_payload  # noqa: E402


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class FakeSio:
    def __init__(self, fail=True):
        self.connected = False
        self.fail = fail
        self.connect_calls = []
        self.emitted = []

    def connect(self, url, **kwargs):
        self.connect_calls.append((url, kwargs))
        if self.fail:
            raise ConnectionError("broker fora")
        self.connected = True

    def emit(self, event, payload):
        self.emitted.append((event, payload))

    def disconnect(self):
        self.connected = False


class GestureBrokerClientTests(unittest.TestCase):
    def test_broker_down_never_raises_and_retries_at_most_every_2s(self):
        clock, sio = FakeClock(), FakeSio(fail=True)
        client = WebSocketBrokerClient("http://x:3000", 2, client_factory=lambda: sio, clock=clock)
        self.assertFalse(client.send_event("handGesture", {"player": 2}))
        clock.t = 1.0
        self.assertFalse(client.send_event("handGesture", {"player": 2}))
        self.assertEqual(len(sio.connect_calls), 1)
        clock.t = 2.5
        client.send_event("handGesture", {"player": 2})
        self.assertEqual(len(sio.connect_calls), 2)

    def test_connect_sends_auth_and_events_flow_once_connected(self):
        clock, sio = FakeClock(), FakeSio(fail=False)
        client = WebSocketBrokerClient("http://x:3000", 1, client_factory=lambda: sio, clock=clock)
        with client:
            self.assertTrue(client.send_event("gestureStatus", {"player": 1}))
        self.assertEqual(sio.connect_calls[0][1]["auth"], {"role": "gesture", "player": 1})
        self.assertEqual(sio.emitted, [("gestureStatus", {"player": 1})])

    def test_status_ticker_fires_immediately_then_every_interval(self):
        clock = FakeClock()
        ticker = StatusTicker(interval_s=2.0, clock=clock)
        self.assertTrue(ticker.due())
        clock.t = 1.9
        self.assertFalse(ticker.due())
        clock.t = 2.0
        self.assertTrue(ticker.due())

    def test_gesture_status_payload(self):
        self.assertEqual(gesture_status_payload(2, True, 123), {"player": 2, "handSeen": True, "timeStamp": 123})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m unittest discover -s tests -p "test_*.py"`
Expected: FAIL (`broker_auth` não existe; `StatusTicker` não existe).

- [ ] **Step 3: Implement**

`eeg_acquisition/acquisition_clients.py`:

```python
def broker_auth(config: AcquisitionConfig):
    # NEU-139: o broker reconhece a peca pelo auth do socket.io (faixa de status do painel).
    return {"role": "acquisition", "player": config.player_id}
```
e no `create_broker_client`: `sio.connect(config.broker_url, auth=broker_auth(config), wait_timeout=config.broker_connect_timeout_seconds)`.

`gesture_detector/broker_client.py` (arquivo inteiro):

```python
# broker_client.py
# Cliente do broker para o detector de gesto. NEU-139: se apresenta (auth), nunca
# morre com o broker fora (tenta de novo no maximo a cada 2 s) e manda sinal de vida.
import time

import socketio

RECONNECT_INTERVAL_S = 2.0
STATUS_INTERVAL_S = 2.0


def gesture_status_payload(player_id: int, hand_seen: bool, now_ms: int) -> dict:
    return {"player": player_id, "handSeen": bool(hand_seen), "timeStamp": now_ms}


class StatusTicker:
    """True na primeira chamada e depois a cada `interval_s`."""

    def __init__(self, interval_s: float = STATUS_INTERVAL_S, clock=time.monotonic):
        self.interval_s = interval_s
        self._clock = clock
        self._last = None

    def due(self) -> bool:
        now = self._clock()
        if self._last is None or now - self._last >= self.interval_s:
            self._last = now
            return True
        return False


class WebSocketBrokerClient:
    def __init__(self, broker_url: str, player_id: int,
                 client_factory=lambda: socketio.Client(reconnection=False), clock=time.monotonic):
        """broker_url: ex. 'http://localhost:3000' (central) ou 'http://192.168.50.1:3000' (coletor)."""
        self.broker_url = broker_url
        self.auth = {"role": "gesture", "player": player_id}
        # Reconexao automatica do socketio desligada: quem reconecta e connect_to_broker,
        # para nao haver duas tentativas concorrentes.
        self.sio = client_factory()
        self._clock = clock
        self._last_attempt = None

    def connect_to_broker(self) -> bool:
        if self.sio.connected:
            return True
        now = self._clock()
        if self._last_attempt is not None and now - self._last_attempt < RECONNECT_INTERVAL_S:
            return False
        self._last_attempt = now
        try:
            self.sio.connect(self.broker_url, auth=self.auth, wait_timeout=1)
            print(f"Conectado ao Broker em {self.broker_url}.")
            return True
        except Exception as e:  # socketio.exceptions.ConnectionError, rede, etc.
            print(f"Broker fora ({self.broker_url}): {e}. Tento de novo em {RECONNECT_INTERVAL_S:.0f} s.")
            return False

    def send_event(self, event_type: str, payload: dict | None = None) -> bool:
        if not self.connect_to_broker():
            return False
        try:
            self.sio.emit(event_type, payload)
            return True
        except Exception as e:
            print(f"Erro ao enviar '{event_type}' ao Broker: {e}")
            return False

    def close(self):
        if self.sio and self.sio.connected:
            self.sio.disconnect()
            print("Conexão com o Broker encerrada.")

    def __enter__(self):
        self.connect_to_broker()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
```

`gesture_detector/hand_fist_detector.py`:
* `__init__`: `self.last_hand_seen = False`;
* em `process_frame`, logo depois de `results = self.hands.process(rgb)`: `self.last_hand_seen = bool(results.multi_hand_landmarks)`;
* import: `from broker_client import StatusTicker, WebSocketBrokerClient, gesture_status_payload`;
* no `main()`: `with WebSocketBrokerClient(BROKER_URL, PLAYER_ID) as broker:` e `status_ticker = StatusTicker()` antes do `while`; dentro do loop, depois de `process_frame`:

```python
            if status_ticker.due():
                broker.send_event("gestureStatus", gesture_status_payload(PLAYER_ID, detector.last_hand_seen, int(time.time() * 1000)))
```

* O envio do `handGesture` fica igual, mas sem o `try/except`, porque o `send_event` já não levanta exceção. Os prints de evento continuam.

`test_client/test-client.js`: `const socket = io(BROKER, { auth: { role: 'test-client' } });`

- [ ] **Step 4: Run tests**

Run: `python -m unittest discover -s tests -p "test_*.py"` e `python -c "import ast,sys; ast.parse(open('gesture_detector/hand_fist_detector.py',encoding='utf-8').read())"`
Expected: PASS, e o detector compila (ele não roda no CI porque depende de `cv2`/`mediapipe`).

- [ ] **Step 5: Commit**

```bash
git add eeg_acquisition/acquisition_clients.py gesture_detector/broker_client.py gesture_detector/hand_fist_detector.py test_client/test-client.js tests/test_acquisition_clients.py tests/test_gesture_broker_client.py
git commit -m "feat(pecas): acquisition, gesto e test-client se apresentam; gesto manda sinal de vida e nao morre sem broker [NEU-139]"
```

### Task 4: Regra da faixa e do Poor Signal (`ops_state.js`)

**Files:**
- Modify: `data_broker/public/ops_state.js`
- Test: `data_broker/tests/test_status_strip.test.js`

**Interfaces:**
- Consumes:
  - `/api/status` (Task 2);
  - `cloudNeedsAttention` (NEU-143, já existe).
- Produces:
  - `OpsState.statusStrip({ status, health, overview, waitingSince, now }) → { groups: { central, coletor, jogo, nuvem }, lines: string[] }`, com níveis `'ok'|'warn'|'down'|'unknown'`;
  - `OpsState.pslLevel(psl) → 'good'|'weak'|'bad'|'none'`;
  - `OpsState.STALE_MS = 10000`.

- [ ] **Step 1: Write the failing test** (`data_broker/tests/test_status_strip.test.js`)

```js
// NEU-139: faixa de status (Central, Coletor, Jogo, Nuvem) e cor do Poor Signal.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

const T = 100_000;
const live = (extra = {}) => ({ connected: true, lastEventAt: T - 1000, attention: 50, poorSignalLevel: 0, source: 'real', handSeen: true, ...extra });
const off = () => ({ connected: false, lastEventAt: null, attention: null, poorSignalLevel: null, source: null, handSeen: null });
const allOk = () => ({
  now: T,
  pieces: { 'acquisition-p1': live(), 'gesture-p1': live(), 'acquisition-p2': live(), 'gesture-p2': live() },
  game: { connections: 1, lastGameEvent: null },
  redis: { status: 'ready' },
});
const health = { dispatcher: { enabled: true } };
const overview = { counts: { waiting: 0, sending: 0, failed: 0 } };
const strip = (status, extra = {}) => S.statusStrip({ status, health, overview, waitingSince: null, now: T, ...extra });

test('tudo bem: 4 verdes e nenhuma linha', () => {
  assert.deepEqual(strip(allOk()), { groups: { central: 'ok', coletor: 'ok', jogo: 'ok', nuvem: 'ok' }, lines: [] });
});

test('CA: acquisition-p2 parado com gesture-p2 vivo -> Coletor amarelo com o que fazer', () => {
  const st = allOk(); st.pieces['acquisition-p2'] = off();
  const r = strip(st);
  assert.equal(r.groups.coletor, 'warn');
  assert.deepEqual(r.lines, ['acquisition-p2 desligado · suba as peças do PC coletor']);
});

test('CA: PC coletor desligado -> vermelho e uma linha so', () => {
  const st = allOk(); st.pieces['acquisition-p2'] = off(); st.pieces['gesture-p2'] = off();
  const r = strip(st);
  assert.equal(r.groups.coletor, 'down');
  assert.deepEqual(r.lines, ['Coletor sem resposta · confira se o PC coletor está ligado e o cabo plugado']);
});

test('sem noticia ha mais de 10 s nao e verde; exatamente 10 s ainda e', () => {
  const st = allOk(); st.pieces['acquisition-p1'] = live({ lastEventAt: T - 10_000 });
  assert.equal(strip(st).groups.central, 'ok');
  st.pieces['acquisition-p1'] = live({ lastEventAt: T - 10_001 });
  const r = strip(st);
  assert.equal(r.groups.central, 'warn');
  assert.deepEqual(r.lines, ['acquisition-p1 sem dados · confira o fone do P1 no PC central']);
});

test('conectada mas nunca mandou nada: amarelo, nunca verde', () => {
  const st = allOk(); st.pieces['gesture-p2'] = live({ lastEventAt: null });
  const r = strip(st);
  assert.equal(r.groups.coletor, 'warn');
  assert.deepEqual(r.lines, ['gesture-p2 sem notícia · reinicie o detector de gesto no PC coletor']);
});

test('gesture-p1 desligado e redis fora: Central amarelo com as duas linhas, redis primeiro', () => {
  const st = allOk(); st.pieces['gesture-p1'] = off(); st.redis = { status: 'reconnecting' };
  const r = strip(st);
  assert.equal(r.groups.central, 'warn');
  assert.deepEqual(r.lines, ['redis fora · reinicie o redis no PC central (a fila fica guardada)', 'gesture-p1 desligado · abra o detector de gesto no PC central']);
});

test('idade usa o relogio do broker (status.now), nao o do navegador', () => {
  const st = allOk();
  const r = S.statusStrip({ status: st, health, overview, waitingSince: null, now: T + 60_000 });
  assert.equal(r.groups.central, 'ok');
});

test('jogo sem conexao -> vermelho', () => {
  const st = allOk(); st.game = { connections: 0, lastGameEvent: null };
  const r = strip(st);
  assert.equal(r.groups.jogo, 'down');
  assert.deepEqual(r.lines, ['jogo não conectado · abra o jogo no PC central']);
});

test('nuvem: desligada vermelho; falha amarelo; espera longa amarelo; /health falhou = cinza', () => {
  let r = strip(allOk(), { health: { dispatcher: { enabled: false, reason: 'api_url_missing' } } });
  assert.deepEqual([r.groups.nuvem, r.lines], ['down', ['nuvem desligada · corridas ficam guardadas no PC central']]);
  r = strip(allOk(), { overview: { counts: { waiting: 0, failed: 2 } } });
  assert.deepEqual([r.groups.nuvem, r.lines], ['warn', ['2 corrida(s) não subiram · use Reenviar no bloco Nuvem']]);
  r = strip(allOk(), { overview: { counts: { waiting: 3, failed: 0 } }, waitingSince: T - 31_000 });
  assert.deepEqual([r.groups.nuvem, r.lines], ['warn', ['corridas esperando há mais de 30 s · internet do evento?']]);
  r = strip(allOk(), { health: null });
  assert.deepEqual([r.groups.nuvem, r.lines], ['unknown', []]);
});

test('broker sem resposta: tudo cinza com uma linha', () => {
  assert.deepEqual(S.statusStrip({ status: null, health: null, overview: null, waitingSince: null, now: T }), {
    groups: { central: 'unknown', coletor: 'unknown', jogo: 'unknown', nuvem: 'unknown' },
    lines: ['broker sem resposta · confira o PC central'],
  });
});

test('pslLevel: 0 verde, 1..199 amarelo, 200 vermelho, sem valor = none', () => {
  assert.equal(S.pslLevel(0), 'good');
  assert.equal(S.pslLevel(1), 'weak');
  assert.equal(S.pslLevel(199), 'weak');
  assert.equal(S.pslLevel(200), 'bad');
  assert.equal(S.pslLevel(null), 'none');
  assert.equal(S.pslLevel(undefined), 'none');
  assert.equal(S.STALE_MS, 10_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd data_broker && node --test tests/test_status_strip.test.js`
Expected: FAIL (`S.statusStrip is not a function`).

- [ ] **Step 3: Implement** (em `ops_state.js`, antes do `return` final; exportar `statusStrip`, `pslLevel` e `STALE_MS`)

```js
  // ---------- NEU-139: faixa de status ----------
  const STALE_MS = 10000;
  const PIECE_PC = { 'acquisition-p1': 'PC central', 'gesture-p1': 'PC central', 'acquisition-p2': 'PC coletor', 'gesture-p2': 'PC coletor' };

  // Poor Signal do NeuroSky: 0 contato perfeito, 200 sem contato.
  function pslLevel(psl) {
    if (psl === null || psl === undefined || !Number.isFinite(Number(psl))) return 'none';
    const n = Number(psl);
    return n === 0 ? 'good' : n < 200 ? 'weak' : 'bad';
  }

  // Sem noticia ha mais de STALE_MS (ou nunca) nao e 'ok'. `now` = relogio do broker.
  function pieceState(piece, now) {
    if (!piece || !piece.connected) return 'down';
    if (piece.lastEventAt === null || piece.lastEventAt === undefined || now - piece.lastEventAt > STALE_MS) return 'stale';
    return 'ok';
  }

  function pieceLine(key, state) {
    const pc = PIECE_PC[key];
    const player = key.slice(-2).toUpperCase();
    if (key.startsWith('acquisition')) {
      return state === 'down' ? `${key} desligado · suba as peças do ${pc}` : `${key} sem dados · confira o fone do ${player} no ${pc}`;
    }
    return state === 'down' ? `${key} desligado · abra o detector de gesto no ${pc}` : `${key} sem notícia · reinicie o detector de gesto no ${pc}`;
  }

  function groupLevel(states) {
    if (states.every((s) => s === 'ok')) return 'ok';
    if (states.every((s) => s === 'down')) return 'down';
    return 'warn';
  }

  function statusStrip({ status, health, overview, waitingSince, now }) {
    if (!status) {
      return { groups: { central: 'unknown', coletor: 'unknown', jogo: 'unknown', nuvem: 'unknown' }, lines: ['broker sem resposta · confira o PC central'] };
    }
    const t = Number.isFinite(Number(status.now)) ? Number(status.now) : now;
    const pieces = status.pieces || {};
    const lines = [];
    const states = (keys) => keys.map((k) => [k, pieceState(pieces[k], t)]);

    const redisState = status.redis && status.redis.status === 'ready' ? 'ok' : 'down';
    const centralPieces = states(['acquisition-p1', 'gesture-p1']);
    const central = groupLevel([redisState, ...centralPieces.map(([, s]) => s)]);
    if (redisState === 'down') lines.push('redis fora · reinicie o redis no PC central (a fila fica guardada)');
    for (const [k, s] of centralPieces) if (s !== 'ok') lines.push(pieceLine(k, s));

    const coletorPieces = states(['acquisition-p2', 'gesture-p2']);
    const coletor = groupLevel(coletorPieces.map(([, s]) => s));
    if (coletor === 'down') lines.push('Coletor sem resposta · confira se o PC coletor está ligado e o cabo plugado');
    else for (const [k, s] of coletorPieces) if (s !== 'ok') lines.push(pieceLine(k, s));

    const jogo = status.game && Number(status.game.connections) > 0 ? 'ok' : 'down';
    if (jogo === 'down') lines.push('jogo não conectado · abra o jogo no PC central');

    let nuvem = 'unknown';
    const disp = health && health.dispatcher;
    if (health && (!disp || !disp.enabled)) {
      nuvem = 'down';
      lines.push('nuvem desligada · corridas ficam guardadas no PC central');
    } else if (health && cloudNeedsAttention({ overview, waitingSince, now })) {
      nuvem = 'warn';
      const failed = Number(overview && overview.counts && overview.counts.failed) || 0;
      lines.push(failed > 0 ? `${failed} corrida(s) não subiram · use Reenviar no bloco Nuvem` : 'corridas esperando há mais de 30 s · internet do evento?');
    } else if (health) {
      nuvem = 'ok';
    }
    return { groups: { central, coletor, jogo, nuvem }, lines };
  }
```

- [ ] **Step 4: Run tests**

Run: `cd data_broker && npm run validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add data_broker/public/ops_state.js data_broker/tests/test_status_strip.test.js
git commit -m "feat(ops): regra da faixa de status e da cor do Poor Signal [NEU-139]"
```

### Task 5: Painel — faixa, cards e `auth` do painel

**Files:**
- Modify: `data_broker/public/index.html`, `data_broker/public/ops.js`, `data_broker/public/ops.css`
- Test: `data_broker/tests/test_ops_screen.test.js` (+ asserções de marcação)

**Interfaces:**
- Consumes:
  - `GET /api/status` (Task 2);
  - `OpsState.statusStrip`, `pslLevel` e `STALE_MS` (Task 4).

- [ ] **Step 1: Write the failing test.** No `test_ops_screen.test.js`, no teste que já busca `/` e confere `data-block`, acrescentar:

```js
    assert.match(res.body, /data-strip/);
    for (const g of ['central', 'coletor', 'jogo', 'nuvem']) assert.match(res.body, new RegExp(`data-ball="${g}"`));
    assert.match(res.body, /data-psl="1"/); assert.match(res.body, /data-gesture="2"/);
    assert.doesNotMatch(res.body, /id="clock"/);
    assert.doesNotMatch(res.body, /data-step="sent"/);
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd data_broker && node --test tests/test_ops_screen.test.js`. Expected: FAIL em `data-strip`.

- [ ] **Step 3: Implement**

`index.html`:
* Tirar `<div class="top-right"><span class="mono" id="clock">--:--:--</span></div>` do header.
* Logo depois do `</header>`:

```html
  <section class="strip" data-strip aria-label="Estado do estande">
    <div class="balls">
      <span class="ball" data-ball="central" data-level="unknown"><i class="dot"></i> Central <b class="mono" data-ball-word>—</b></span>
      <span class="ball" data-ball="coletor" data-level="unknown"><i class="dot"></i> Coletor <b class="mono" data-ball-word>—</b></span>
      <span class="ball" data-ball="jogo" data-level="unknown"><i class="dot"></i> Jogo <b class="mono" data-ball-word>—</b></span>
      <span class="ball" data-ball="nuvem" data-level="unknown"><i class="dot"></i> Nuvem <b class="mono" data-ball-word>—</b></span>
    </div>
    <ul class="strip-lines mono" data-strip-lines aria-live="polite"></ul>
  </section>
```

* Nas duas listas `.steps`, tirar `<li data-step="sent">Enviada</li>` e trocar `Finalizada` por `Terminou`.
* Em cada `.signal` (slot N), substituir o `<div class="signal-body">…</div>` por:

```html
          <div class="signal-body">
            <div class="attn"><span class="attn-num mono" data-attn="N">—</span><span class="attn-label">atenção</span></div>
            <svg class="spark" viewBox="0 0 240 48" preserveAspectRatio="none" aria-hidden="true"><path data-spark="N" d=""></path></svg>
            <div class="attn"><span class="psl-num mono" data-psl="N" data-level="none">—</span><span class="attn-label">poor signal</span></div>
            <svg class="spark spark-psl" viewBox="0 0 240 48" preserveAspectRatio="none" aria-hidden="true"><path data-spark-psl="N" d=""></path></svg>
            <div class="attn"><span class="attn-num mono" data-fists="N">0</span><span class="attn-label">punhos/min</span></div>
            <svg class="spark gesture" viewBox="0 0 240 24" preserveAspectRatio="none" aria-hidden="true"><g data-gesture="N"></g></svg>
          </div>
```

(N = 1 e 2). O `data-quality` sai; a cor do Poor Signal passa a estar no número.

`ops.js`:
* Socket: `window.io({ transports: ['websocket', 'polling'], auth: { role: 'panel' } })`.
* `st` ganha `status: null`, `pslSeries: { 1: [], 2: [] }` e `fists: { 1: [], 2: [] }`.
* `refresh()`: acrescentar `getJson('/api/status')` ao `Promise.allSettled`; `st.status = res.status === 'fulfilled' ? res.value : null`. Calcular `st.waitingSince` como o `queueSince` atual, mas a partir de `st.overview.counts.waiting`: se `waiting > 0` e `waitingSince === null`, passa a `Date.now()`; se `waiting === 0`, volta a `null`.
* No `eSense`, depois de guardar a atenção: `const ps = st.pslSeries[slot]; ps.push({ t: now, a: Math.min(100, Number(p.poorSignalLevel) / 2) }); while (ps.length && now - ps[0].t > SPARK_MS) ps.shift();` e `st.packets[slot].source = p.source`.
* Novo `socket.on('handGesture', (p) => { const slot = Number(p && p.player); if (slot !== 1 && slot !== 2) return; st.fists[slot].push(Date.now()); renderSignal(slot); })`.
* `renderSignal(slot)`:
  * Sem pacote, ou último pacote há mais de `S.STALE_MS`: `data-attn` e `data-psl` mostram **"Sem dados"** com `dataset.level = 'bad'`. O mini gráfico da atenção fica vazio; nunca o número congelado.
  * Senão:
    * a atenção vai como número;
    * se `packets[slot].source === 'bot'`, o Poor Signal mostra **"simulado"** com `dataset.level = 'none'`;
    * senão, `String(psl)` com `dataset.level = S.pslLevel(psl)`.
  * Gesto: tirar de `st.fists[slot]` o que tiver mais de 60 s; `data-fists` mostra a contagem. O `<g data-gesture>` recebe um `<rect>` (criado com `document.createElementNS('http://www.w3.org/2000/svg','rect')`, largura 2, altura 24) por punho, em `x = (60000 - (now - t)) / 60000 * 238`.
  * O resto (link e mini gráfico de atenção) segue como hoje.
* `renderStrip()`:

```js
  const LEVEL_WORD = { ok: 'OK', warn: 'Atenção', down: 'Fora', unknown: '—' };
  function renderStrip() {
    const r = S.statusStrip({ status: st.status, health: st.health, overview: st.overview, waitingSince: st.waitingSince, now: Date.now() });
    for (const [g, level] of Object.entries(r.groups)) {
      const ball = $(`[data-ball="${g}"]`); ball.dataset.level = level;
      ball.querySelector('[data-ball-word]').textContent = LEVEL_WORD[level];
    }
    const ul = $('[data-strip-lines]'); ul.replaceChildren();
    for (const line of r.lines) { const li = document.createElement('li'); li.textContent = line; ul.appendChild(li); }
  }
```

  Chamar dentro de `render()` e no `setInterval` de 1 s.
* Banner: em `renderBanner`, depois de montar `list`, filtrar `list = list.filter((a) => !['signal_lost', 'queue_stuck', 'cloud_failed'].includes(a.code));` (a faixa cobre).
* Etapas: `STEP_ORDER = ['registered', 'racing', 'finished']`; `const idx = state === 'sent' || state === 'rejected' ? 2 : STEP_ORDER.indexOf(state);`. `STATE_LABEL`: `finished: 'Terminou'`, `sent: 'Terminou'` e `rejected: 'Terminou'`.
* Relógio: tirar a linha `$('#clock').textContent = …` do `setInterval`.

`ops.css` (acrescentar):

```css
/* Faixa de status (NEU-139) */
.strip { margin: 0 auto 1rem; max-width: 1100px; padding: 0.6rem 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); }
.balls { display: flex; gap: 1.4rem; flex-wrap: wrap; }
.ball { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--fg-strong); }
.ball .dot { width: 12px; height: 12px; }
.ball[data-level="ok"] .dot { background: var(--ok); } .ball[data-level="warn"] .dot { background: var(--warn); } .ball[data-level="down"] .dot { background: var(--error); }
.ball[data-level="warn"] b { color: var(--warn); } .ball[data-level="down"] b { color: var(--error); } .ball[data-level="ok"] b { color: var(--ok); } .ball b { font-weight: 500; font-size: 0.8rem; color: var(--fg-muted); }
.strip-lines { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.2rem; font-size: 0.82rem; color: var(--warn); }
.strip-lines:empty { display: none; }
.psl-num { font-size: 1.4rem; color: var(--fg-strong); line-height: 1; }
[data-level="good"] { color: var(--ok); } .psl-num[data-level="weak"] { color: var(--warn); } [data-level="bad"] { color: var(--error); }
.attn-num[data-level="bad"], .psl-num[data-level="bad"] { font-size: 1rem; }
.spark-psl path { stroke: var(--warn); }
.gesture rect { fill: var(--fg-strong); }
```

(E `.signal-body` passa a `grid-template-columns: 110px 1fr` com 3 linhas, o que já vale pelo grid atual.)

- [ ] **Step 4: Verify**
* `cd data_broker && npm run validate` → PASS.
* Abrir o painel com o broker local e os simuladores (Task 6) e conferir visualmente: a faixa, os cards, "Sem dados" e "simulado".

- [ ] **Step 5: Commit**

```bash
git add data_broker/public data_broker/tests/test_ops_screen.test.js
git commit -m "feat(ops): faixa de status, Poor Signal, gesto e Sem dados nos cards; painel se apresenta [NEU-139]"
```

### Task 6: E2E com simuladores, docs e PR

**Files:**
- Modify: `docs/event-contracts.md` (auth, `gestureStatus`, `/api/status`), `README.md` (uma linha em "tela de operação")

- [ ] **Step 1: Docs.**
* Em `docs/event-contracts.md`, uma seção "Identificação das peças (NEU-139)" com a tabela de `auth` da spec, o evento `gestureStatus { player, handSeen, timeStamp }` (não repassado) e o formato do `GET /api/status`.
* No `README.md`, onde lista as rotas: `GET /api/status` — presença das peças para a faixa do painel.

- [ ] **Step 2: E2E local.**
* Rodar com `docker compose --profile sim-local up -d --build`, com `API_URL` vazio, mais um `gesture` falso. O falso é um script Python de 10 linhas que usa `WebSocketBrokerClient` + `StatusTicker` com `player 1` e `player 2`.
* Conferir no painel (Playwright) e em `/api/status`:
  * tudo vivo, exceto o jogo → Jogo vermelho;
  * `docker compose stop acquisition-b` → Coletor amarelo com `acquisition-p2 desligado · …` em ≤ 10 s;
  * parar também o gesto falso do P2 → Coletor vermelho com a linha única;
  * `node e2e/jogo-falso.js http://localhost:3000 30 1,2` → Jogo verde.
* Desligar tudo com `docker compose stop`, **nunca `down -v`**: o volume tem as corridas reais de 28/08.

- [ ] **Step 3: Suítes completas.**
* `cd data_broker && REDIS_URL=redis://127.0.0.1:6399 node --test --test-concurrency=1`, com um Redis descartável na 6399;
* `python -m unittest discover -s tests -p "test_*.py"`;
* `scripts/validate-compose-ports.sh` e `scripts/validate-compose-banca.sh`.

- [ ] **Step 4: Commit, push e PR**, com o token do `santos-nikolas` por comando.
