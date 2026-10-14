# NEU-86 — NeuroSky ou Bot por jogador e câmera pelo painel: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o operador troca a fonte de cada jogador (NeuroSky | Bot) e a câmera de cada detector de gesto pelo painel, sem terminal e sem reiniciar peça, e corrida de bot nunca entra na fila de envio.

**Architecture:**
- O broker guarda a escolha de cada jogador (`players:setup` no Redis, com cópia em memória) e manda comandos (`setSource` e `setCamera`) para a peça certa, tanto quando ela conecta quanto quando o operador troca.
- A acquisition troca de leitor dentro do laço do PR #30, sem cair do broker. O Bot é um leitor interno, com a mesma interface do socket do ThinkGear.
- O detector de gesto aplica a troca de câmera entre dois frames e volta para a anterior se a nova não abrir.
- A trava da corrida existe nos dois lados: o broker responde 409 e o painel desabilita os controles.

**Tech Stack:** Node 22 (CommonJS, `node:test`, ioredis), Python 3.11 (`unittest`, python-socketio), OpenCV no detector, HTML/CSS/JS sem build no painel.

**Spec:** `docs/superpowers/specs/2026-10-14-neu-86-fonte-camera-design.md` (spec de produto: "Spec: painel de operação plug-and-play (V2)", B1, B2, B7, C5 e D2).

## Global Constraints

- **Base:** branch `feature/neu-86`, criada de `origin/feat/splits-eeg-state-from-acquisition-presence` (PR #30, `4e29bcb`). Não editar o que o #30 fez além do necessário para a troca.
- **Fontes:** `'neurosky'` e `'bot'`, exatamente esses valores. O padrão é `'neurosky'` nos dois jogadores.
- **Câmeras:** índices `0`, `1` e `2`, exibidos como "Câmera 1", "Câmera 2" e "Câmera 3".
- **Hash Redis `players:setup`:**
  - campos `p1Source`, `p2Source`, `p1Camera`, `p2Camera`;
  - câmera sem escolha vale `null` no `get()`.
- **Trava da corrida:** `RACE_LOCK_MS = 10 * 60 * 1000`, com a mesma constante no broker e no painel (`public/ops_state.js`).
- **Rotas novas:** exigem `Content-Type: application/json` (`415` sem isso) e aceitam corpo de no máximo 4096 bytes.
- **Erros:** `invalid_player`, `invalid_source` e `invalid_camera` dão 400; `race_in_progress` dá 409.
- **Bot nunca sobe (B2):** quem decide é a escolha do painel lida na largada, não o `source` do pacote.
- **Painel:**
  - nunca usar `innerHTML` com dado do broker;
  - textos em PT-BR;
  - as cores vêm dos tokens de `:root` (`--fg`, `--fg-muted`, `--bg`, `--hairline`, `--warn`, `--error`).
- **Commits:** terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca commitar `.env`.
- **Redis do estande:** nunca rodar `docker compose down -v` (o volume `edge-service_redis-data` tem 6 corridas reais na dead-letter). Parar sempre com `stop`.
- **Python dos testes:** `PY=C:/Users/nikol/AppData/Local/Temp/claude/C--IC-2026/42524914-5adb-4858-a7d8-eaba9ab01089/scratchpad/venv-edge/Scripts/python.exe`.
- **Suíte Python:** `$PY -m unittest discover -s tests -p "test_*.py"`. **Suíte Node:** `npm --prefix data_broker run validate`.

## Review Focus

1. **Troca durante o connect do ThinkGear:** o pedido chega depois da escolha do leitor e antes do `attach`. O leitor velho não pode ficar lendo para sempre. Coberto na Task 1 (`test_attach_of_stale_reader_shuts_it_at_once`).
2. **Clique repetido no mesmo botão:** escolher de novo a fonte que já está ativa não derruba o leitor nem gera queda de dados. Coberto nas Tasks 1 e 4 (no-op).
3. **Broker reiniciado com a escolha no Redis:** as peças que reconectam antes do `load()` terminar recebem o padrão e, depois do `load()`, recebem a escolha guardada. Coberto na Task 5 (`pushAll`).
4. **Índice de câmera que não existe:** o detector não fecha. Ele volta para a câmera anterior e o painel mostra o erro. Coberto na Task 3.
5. **Sessão esquecida de outro dia:** `session:current` nunca expira e não pode travar a troca para sempre. Coberto nas Tasks 4 (`raceInProgress` com 11 min) e 6 (`setupLocked`).

---

### Task 1: `SourceSwitch` e o leitor Bot (acquisition)

**Files:**
- Create: `eeg_acquisition/source_switch.py`
- Create: `eeg_acquisition/bot_source.py`
- Test: `tests/test_source_switch.py`

**Interfaces:**
- Produces:
  - `MODES = ("neurosky", "bot")`
  - `SourceSwitch(mode="neurosky")`, com:
    - `.mode -> str`
    - `.attach(reader, mode) -> None`
    - `.request(mode) -> bool`
    - `.take_switched() -> bool`
    - `.wait(seconds) -> bool` (True quando houve troca)
    - `.config_for(config) -> AcquisitionConfig`
  - `BotReader(interval_s=1.0)`, com `.recv(bufsize) -> bytes`, `.shutdown(how)` e `.close()`

- [ ] **Step 1: Escrever os testes**

`tests/test_source_switch.py`:

```python
import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg_acquisition"))

from acquisition_config import AcquisitionConfig  # noqa: E402
from acquisition_core import build_esense_payload, extract_json_messages, parse_packet  # noqa: E402
from bot_source import BotReader  # noqa: E402
from source_switch import MODES, SourceSwitch  # noqa: E402


def make_config(**over):
    base = dict(
        player_id=1, acq_port=13854, eeg_host="127.0.0.1", broker_url="http://broker:3000", source="real",
        buffer_size=4096, poor_signal_level_threshold=0, eeg_connect_timeout_seconds=5, eeg_read_timeout_seconds=10,
        broker_connect_timeout_seconds=5, retry_base_delay_seconds=1, retry_max_delay_seconds=10, max_reconnect_attempts=0,
    )
    base.update(over)
    return AcquisitionConfig(**base)


class FakeReader:
    def __init__(self):
        self.shutdowns = []

    def shutdown(self, how):
        self.shutdowns.append(how)


class SourceSwitchTests(unittest.TestCase):
    def test_modes(self):
        self.assertEqual(MODES, ("neurosky", "bot"))
        self.assertEqual(SourceSwitch().mode, "neurosky")

    def test_request_new_mode_shuts_active_reader_and_flags_switch(self):
        sw, reader = SourceSwitch(), FakeReader()
        sw.attach(reader, "neurosky")
        self.assertTrue(sw.request("bot"))
        self.assertEqual(sw.mode, "bot")
        self.assertEqual(reader.shutdowns, [socket.SHUT_RDWR])
        self.assertTrue(sw.take_switched())
        self.assertFalse(sw.take_switched())

    def test_same_mode_is_a_no_op(self):
        # Clique repetido no botao que ja esta ativo nao derruba o leitor (Review Focus 2).
        sw, reader = SourceSwitch(), FakeReader()
        sw.attach(reader, "neurosky")
        self.assertFalse(sw.request("neurosky"))
        self.assertEqual(reader.shutdowns, [])
        self.assertFalse(sw.take_switched())

    def test_unknown_mode_is_ignored(self):
        sw = SourceSwitch()
        for bad in ("BOT", "", None, 1, "real", ["bot"]):
            self.assertFalse(sw.request(bad))
        self.assertEqual(sw.mode, "neurosky")

    def test_attach_of_stale_reader_shuts_it_at_once(self):
        # A troca chegou enquanto o connect do ThinkGear estava em andamento (Review Focus 1).
        sw, reader = SourceSwitch(), FakeReader()
        sw.request("bot")
        sw.attach(reader, "neurosky")
        self.assertEqual(reader.shutdowns, [socket.SHUT_RDWR])

    def test_shutdown_error_on_closed_reader_is_swallowed(self):
        class Closed:
            def shutdown(self, how):
                raise OSError("ja fechado")

        sw = SourceSwitch()
        sw.attach(Closed(), "neurosky")
        self.assertTrue(sw.request("bot"))

    def test_wait_returns_early_when_switched(self):
        sw = SourceSwitch()
        threading.Timer(0.05, lambda: sw.request("bot")).start()
        started = time.monotonic()
        self.assertTrue(sw.wait(5))
        self.assertLess(time.monotonic() - started, 1)

    def test_wait_times_out_without_switch(self):
        self.assertFalse(SourceSwitch().wait(0.01))

    def test_take_switched_rearms_wait(self):
        sw = SourceSwitch()
        sw.request("bot")
        sw.take_switched()
        self.assertFalse(sw.wait(0.01))

    def test_config_for_labels_bot_and_keeps_env_label_for_neurosky(self):
        cfg, sw = make_config(source="real"), SourceSwitch()
        self.assertEqual(sw.config_for(cfg).source, "real")
        sw.request("bot")
        self.assertEqual(sw.config_for(cfg).source, "bot")
        self.assertEqual(cfg.source, "real")


class BotReaderTests(unittest.TestCase):
    def test_recv_yields_one_esense_packet_terminated_by_cr(self):
        data = BotReader(interval_s=0).recv(4096).decode("utf-8")
        self.assertTrue(data.endswith("\r"))
        packet = json.loads(data)
        self.assertIn("eSense", packet)
        self.assertEqual(packet["poorSignalLevel"], 0)

    def test_packet_goes_through_the_real_pipeline_parsers(self):
        raw, rest = extract_json_messages(BotReader(interval_s=0).recv(4096).decode("utf-8"))
        self.assertEqual(rest, "")
        payload = build_esense_payload(parse_packet(raw[0]), player_id=1, source="bot", threshold=0, now_ms=1)
        self.assertEqual(payload["source"], "bot")

    def test_after_shutdown_recv_returns_empty_without_waiting(self):
        reader = BotReader(interval_s=5)
        threading.Timer(0.05, lambda: reader.shutdown(socket.SHUT_RDWR)).start()
        started = time.monotonic()
        self.assertEqual(reader.recv(4096), b"")
        self.assertLess(time.monotonic() - started, 1)

    def test_close_is_idempotent(self):
        reader = BotReader()
        reader.close()
        reader.close()
        self.assertEqual(reader.recv(10), b"")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `$PY -m unittest tests.test_source_switch -v`
Expected: ERROR, `ModuleNotFoundError: No module named 'bot_source'`

- [ ] **Step 3: Implementar**

`eeg_acquisition/bot_source.py`:

```python
# NEU-86: fonte "Bot" dentro da propria acquisition. Imita o socket do ThinkGear
# (recv/shutdown/close) com o mesmo pacote do simulator.py, 1 por segundo. Assim o
# Bot funciona igual nos dois PCs, sem container de simulador.
import json
import threading

from simulator import generate_packet


class BotReader:
    def __init__(self, interval_s: float = 1.0):
        self.interval_s = interval_s
        self._closed = threading.Event()

    def recv(self, _bufsize: int) -> bytes:
        # Fechado (troca de fonte ou fim) = b"", como um socket cuja outra ponta fechou.
        if self._closed.wait(self.interval_s):
            return b""
        return (json.dumps(generate_packet()) + "\r").encode("utf-8")

    def shutdown(self, _how) -> None:
        self._closed.set()

    def close(self) -> None:
        self._closed.set()
```

`eeg_acquisition/source_switch.py`:

```python
# NEU-86: modo de leitura escolhido no painel (NeuroSky = leitor configurado em
# EEG_HOST:ACQ_PORT; Bot = gerador interno). `request` chega na thread do socket.io;
# o laco da acquisition le o resto. Trocar fecha o leitor ativo (shutdown acorda o
# recv bloqueado) e acorda a espera do backoff, para a troca valer em segundos.
import socket
import threading
from dataclasses import replace

MODES = ("neurosky", "bot")


class SourceSwitch:
    def __init__(self, mode: str = "neurosky"):
        self._lock = threading.Lock()
        self._mode = mode
        self._active = None
        self._switched = False
        self._wake = threading.Event()

    @property
    def mode(self) -> str:
        with self._lock:
            return self._mode

    @staticmethod
    def _shutdown(reader) -> None:
        try:
            reader.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass  # ja fechado: nada a acordar

    def attach(self, reader, mode: str) -> None:
        """Registra o leitor aberto para `mode`. Se o modo ja mudou (troca durante o connect), fecha na hora."""
        with self._lock:
            self._active = reader
            stale = mode != self._mode
        if stale:
            self._shutdown(reader)

    def request(self, mode) -> bool:
        if not isinstance(mode, str) or mode not in MODES:
            return False
        with self._lock:
            if mode == self._mode:
                return False
            self._mode = mode
            self._switched = True
            active = self._active
        self._wake.set()
        if active is not None:
            self._shutdown(active)
        return True

    def take_switched(self) -> bool:
        """True uma vez depois de cada troca; rearma a espera."""
        with self._lock:
            switched, self._switched = self._switched, False
            if switched:
                self._wake.clear()
        return switched

    def wait(self, seconds: float) -> bool:
        """Espera do backoff. True = acordou por troca de fonte."""
        return self._wake.wait(seconds)

    def config_for(self, config):
        return replace(config, source="bot") if self.mode == "bot" else config
```

- [ ] **Step 4: Rodar e ver passar**

Run: `$PY -m unittest tests.test_source_switch -v`
Expected: PASS, 14 testes

- [ ] **Step 5: Commit**

```bash
git add eeg_acquisition/source_switch.py eeg_acquisition/bot_source.py tests/test_source_switch.py
git commit -m "feat(acquisition): SourceSwitch e leitor Bot interno para trocar a fonte ao vivo [NEU-86]"
```

---

### Task 2: acquisition troca a fonte pelo `setSource` sem cair do broker

**Files:**
- Modify: `eeg_acquisition/acquisition_clients.py`
- Modify: `eeg_acquisition/acquisition_runner.py` (o laço do #30)
- Test: `tests/test_acquisition_clients.py`, `tests/test_acquisition_runner.py`

**Interfaces:**
- Consumes: `SourceSwitch`, `BotReader` e `MODES` (Task 1).
- Produces:
  - `create_eeg_client(config, switch=None)`
  - `source_handler(switch, log) -> callable(data)`
  - `create_broker_client(config, on_set_source=None)`
  - `connect_broker_with_retry(config, log, sleep=time.sleep, on_set_source=None)`
  - `sleep_reporting_status(...)`, que para quando `sleep(step)` devolve True
  - `run_acquisition_service(config, log, switch=None)`
  - log `eeg_source_switched`

- [ ] **Step 1: Escrever os testes (clientes)**

Acrescentar em `tests/test_acquisition_clients.py`. Acrescentar também os imports `from source_switch import SourceSwitch` e `from bot_source import BotReader` depois do `import acquisition_clients`.

```python
class FakeLog:
    def __init__(self):
        self.lines = []

    def info(self, msg, **kw):
        self.lines.append(("info", msg, kw))

    def warning(self, msg, **kw):
        self.lines.append(("warning", msg, kw))


class SourceSelectionTests(unittest.TestCase):
    def test_bot_mode_uses_internal_reader_and_never_opens_a_socket(self):
        switch = SourceSwitch()
        switch.request("bot")
        with mock.patch.object(acquisition_clients.socket, "socket") as sock:
            client = acquisition_clients.create_eeg_client(make_config(1), switch)
        sock.assert_not_called()
        self.assertIsInstance(client, BotReader)
        client.close()

    def test_neurosky_mode_opens_thinkgear_socket_and_attaches_it(self):
        switch = SourceSwitch()
        with mock.patch.object(acquisition_clients.socket, "socket") as sock:
            client = acquisition_clients.create_eeg_client(make_config(1), switch)
        client.connect.assert_called_once_with(("127.0.0.1", 13854))
        switch.request("bot")
        client.shutdown.assert_called_once()  # o leitor ativo e o que foi aberto

    def test_source_handler_switches_on_valid_and_logs_invalid(self):
        switch, log = SourceSwitch(), FakeLog()
        handler = acquisition_clients.source_handler(switch, log)
        handler({"source": "bot"})
        self.assertEqual(switch.mode, "bot")
        handler({"source": "real"})
        handler("bot")
        self.assertEqual(switch.mode, "bot")
        self.assertEqual([m for lvl, m, _ in log.lines if lvl == "warning"], ["set_source_ignored", "set_source_ignored"])

    def test_set_source_handler_is_registered_before_connect(self):
        # O broker manda o setSource logo na conexao: registrar depois perderia o primeiro.
        handler = lambda data: None  # noqa: E731
        with mock.patch.object(acquisition_clients.socketio, "Client") as client_cls:
            acquisition_clients.create_broker_client(make_config(1), on_set_source=handler)
        names = [c[0] for c in client_cls.return_value.method_calls]
        self.assertEqual(names[:2], ["on", "connect"])
        self.assertEqual(client_cls.return_value.on.call_args[0], ("setSource", handler))
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `$PY -m unittest tests.test_acquisition_clients -v`
Expected: FAIL/ERROR, `create_eeg_client() takes 1 positional argument` e `module 'acquisition_clients' has no attribute 'source_handler'`

- [ ] **Step 3: Implementar (clientes)**

Em `eeg_acquisition/acquisition_clients.py`:

```python
import socket
import socketio

from acquisition_config import AcquisitionConfig
from bot_source import BotReader
from code_version import code_version
from source_switch import MODES


def create_eeg_client(config: AcquisitionConfig, switch=None):
    # NEU-86: com o painel em Bot, o leitor e o gerador interno (nao abre socket).
    mode = switch.mode if switch is not None else "neurosky"
    if mode == "bot":
        client = BotReader()
    else:
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(config.eeg_connect_timeout_seconds)
        client.connect((config.eeg_host, config.acq_port))
        client.sendall(b'{"enableRawOutput": false, "format": "Json"}')
        client.settimeout(config.eeg_read_timeout_seconds)
    if switch is not None:
        switch.attach(client, mode)
    return client


def source_handler(switch, log):
    """Handler do `setSource` vindo do broker (roda na thread do socket.io)."""
    def on_set_source(data):
        source = data.get("source") if isinstance(data, dict) else None
        if not isinstance(source, str) or source not in MODES:
            log.warning("set_source_ignored", source=str(source)[:32])
        elif switch.request(source):
            log.info("eeg_source_switch_requested", source=source)
    return on_set_source
```

Em `create_broker_client`, trocar a assinatura e registrar o handler antes do `connect`:

```python
def create_broker_client(config: AcquisitionConfig, on_set_source=None):
    sio = socketio.Client(
        logger=True,
        engineio_logger=False,
        reconnection=True,
        reconnection_attempts=0,
        reconnection_delay=config.retry_base_delay_seconds,
        reconnection_delay_max=config.retry_max_delay_seconds,
    )
    # NEU-86: antes do connect, porque o broker manda o setSource logo na conexao.
    if on_set_source is not None:
        sio.on("setSource", on_set_source)
    sio.connect(config.broker_url, auth=broker_auth(config), wait_timeout=config.broker_connect_timeout_seconds)
    return sio
```

- [ ] **Step 4: Rodar e ver passar**

Run: `$PY -m unittest tests.test_acquisition_clients -v`
Expected: PASS, 6 testes

- [ ] **Step 5: Escrever os testes (laço)**

Acrescentar em `tests/test_acquisition_runner.py`:
- trocar o import do runner por `import acquisition_runner` mais o `from acquisition_runner import (...)` que já existe;
- acrescentar `import threading`, `import time`, `from unittest import mock` e `from source_switch import SourceSwitch`.

```python
class FakeLog:
    def __getattr__(self, _level):
        return lambda *a, **kw: None


class FakeReader:
    def close(self):
        pass


class SourceSwitchLoopTests(unittest.TestCase):
    def run_loop(self, switch, fake_eeg, fake_stream, **config_over):
        with mock.patch.object(acquisition_runner, "connect_broker_with_retry", return_value=FakeSio()), \
             mock.patch.object(acquisition_runner, "create_eeg_client", side_effect=fake_eeg), \
             mock.patch.object(acquisition_runner, "stream_packets", side_effect=fake_stream), \
             mock.patch.object(acquisition_runner, "close_connections"):
            acquisition_runner.run_acquisition_service(make_config(**config_over), FakeLog(), switch=switch)

    def test_switch_to_bot_during_thinkgear_backoff_happens_without_waiting(self):
        # ThinkGear fechado: a peca espera 10 s entre tentativas. A troca para Bot nao espera.
        switch, calls = SourceSwitch(), []

        def fake_eeg(config, sw):
            calls.append(sw.mode)
            if sw.mode == "neurosky":
                threading.Timer(0.05, lambda: sw.request("bot")).start()
                raise ConnectionRefusedError("ThinkGear fechado")
            return FakeReader()

        def fake_stream(*, client, sio, config, log):
            calls.append(("stream", config.source))
            raise KeyboardInterrupt  # encerra o laco do teste

        started = time.monotonic()
        self.run_loop(switch, fake_eeg, fake_stream, retry_base_delay_seconds=10, retry_max_delay_seconds=10)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(calls, ["neurosky", "bot", ("stream", "bot")])

    def test_switch_while_streaming_reopens_without_backoff(self):
        switch, modes, slept = SourceSwitch(), [], []

        def fake_eeg(config, sw):
            modes.append(sw.mode)
            return FakeReader()

        def fake_stream(*, client, sio, config, log):
            if len(modes) == 1:
                switch.request("bot")
                raise acquisition_runner.RecoverableAcquisitionError("A fonte de EEG fechou a conexao.")
            raise KeyboardInterrupt

        with mock.patch.object(switch, "wait", side_effect=lambda s: slept.append(s)):
            self.run_loop(switch, fake_eeg, fake_stream)
        self.assertEqual(modes, ["neurosky", "bot"])
        self.assertEqual(slept, [])

    def test_real_failure_still_backs_off(self):
        switch, slept, attempts = SourceSwitch(), [], []

        def fake_eeg(config, sw):
            attempts.append(1)
            if len(attempts) == 1:
                raise ConnectionRefusedError("ThinkGear fechado")
            raise KeyboardInterrupt

        with mock.patch.object(switch, "wait", side_effect=lambda s: slept.append(s)):
            self.run_loop(switch, fake_eeg, lambda **kw: None)
        self.assertEqual(sum(slept), 1)  # base 1 s na 1a falha, em fatias de 2 s


class SleepInterruptTests(unittest.TestCase):
    def test_sleep_returning_true_stops_the_wait(self):
        slept = []
        sleep_reporting_status(FakeSio(), make_config(), 10, None, sleep=lambda s: slept.append(s) or True)
        self.assertEqual(slept, [2])
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `$PY -m unittest tests.test_acquisition_runner -v`
Expected: FAIL/ERROR, `run_acquisition_service() got an unexpected keyword argument 'switch'`, e `SleepInterruptTests` com `[2, 2, 2, 2, 2]`

- [ ] **Step 7: Implementar (laço)**

Em `eeg_acquisition/acquisition_runner.py`:

1. Imports: `from acquisition_clients import close_connections, create_broker_client, create_eeg_client, source_handler` e `from source_switch import SourceSwitch`.
2. `sleep_reporting_status`: dentro do `while`, trocar `sleep(step)` por:

```python
        if sleep(step):
            return  # NEU-86: acordou por troca de fonte; o laco abre o leitor novo ja
```

3. `connect_broker_with_retry(config, log, sleep=time.sleep, on_set_source=None)`, com `sio = create_broker_client(config, on_set_source=on_set_source)`.
4. `run_acquisition_service(config, log, switch=None)`:

```python
def run_acquisition_service(config: AcquisitionConfig, log, switch=None):
    # NEU-86: a fonte (NeuroSky | Bot) vem do painel pelo setSource; comeca em NeuroSky.
    switch = switch or SourceSwitch()
    log.info(
        "acquisition_started",
        playerId=config.player_id,
        eegHost=config.eeg_host,
        acqPort=config.acq_port,
        brokerUrl=config.broker_url,
        source=config.source,
    )

    attempt = 0
    sio = None

    try:
        sio = connect_broker_with_retry(config, log, on_set_source=source_handler(switch, log))

        while True:
            client = None
            # Troca pedida durante a espera do backoff: a proxima tentativa e do leitor novo.
            if switch.take_switched():
                attempt = 0

            try:
                emit_eeg_status(sio, config, "connecting")
                log.info("connecting_eeg_source", attempt=attempt + 1, mode=switch.mode)
                client = create_eeg_client(config, switch)
                log.info("eeg_source_connected", mode=switch.mode, eegHost=config.eeg_host, acqPort=config.acq_port)
                emit_eeg_status(sio, config, "connected")

                attempt = 0
                stream_packets(client=client, sio=sio, config=switch.config_for(config), log=log)
            except (RecoverableAcquisitionError, socket.error) as exc:
                # NEU-86: a queda provocada pela troca de fonte nao e falha. Sem backoff.
                if switch.take_switched():
                    log.info("eeg_source_switched", mode=switch.mode)
                    attempt = 0
                    continue
                attempt += 1
                if should_stop_retrying(attempt, config):
                    raise

                delay_seconds = compute_retry_delay_seconds(
                    attempt,
                    base_delay_seconds=config.retry_base_delay_seconds,
                    max_delay_seconds=config.retry_max_delay_seconds,
                )
                log.warning(
                    "eeg_connection_failure",
                    error=str(exc),
                    nextRetryDelaySeconds=delay_seconds,
                    attempt=attempt,
                )
                # So o cliente do EEG cai aqui; o broker segue conectado, avisando.
                sleep_reporting_status(sio, config, delay_seconds, exc, sleep=switch.wait)
            finally:
                if client:
                    client.close()
```

Os blocos `except` externos e o `finally` do #30 continuam iguais.

- [ ] **Step 8: Rodar a suíte Python**

Run: `$PY -m unittest discover -s tests -p "test_*.py"`
Expected: `OK` (contar o número; nenhuma falha)

- [ ] **Step 9: Commit**

```bash
git add eeg_acquisition/acquisition_clients.py eeg_acquisition/acquisition_runner.py tests/test_acquisition_clients.py tests/test_acquisition_runner.py
git commit -m "feat(acquisition): troca NeuroSky/Bot pelo setSource do broker, sem backoff e sem cair do broker [NEU-86]"
```

---

### Task 3: detector de gesto troca de câmera pelo `setCamera`

**Files:**
- Create: `gesture_detector/camera_switch.py`
- Modify: `gesture_detector/broker_client.py`, `gesture_detector/hand_fist_detector.py`
- Test: `tests/test_camera_switch.py`, `tests/test_gesture_broker_client.py`

**Interfaces:**
- Produces:
  - `CAMERAS = (0, 1, 2)`
  - `CameraSwitch(initial_index, opener)`, com:
    - os atributos `.index`, `.capture` e `.error`
    - `.request(index) -> bool`
    - `.apply_pending() -> bool`
  - `set_camera_handler(switch) -> callable(data)`
  - `gesture_status_payload(player_id, hand_seen, now_ms, camera=None, camera_error=None)`
  - `WebSocketBrokerClient(..., handlers=None)`

- [ ] **Step 1: Escrever os testes**

`tests/test_camera_switch.py`:

```python
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gesture_detector"))

from camera_switch import CAMERAS, CameraSwitch, set_camera_handler  # noqa: E402


class FakeCap:
    def __init__(self, index, opened=True, reads=True):
        self.index, self.opened, self.reads, self.released = index, opened, reads, False

    def isOpened(self):
        return self.opened

    def read(self):
        return (self.reads, f"frame{self.index}" if self.reads else None)

    def release(self):
        self.released = True


def opener(bad=(), no_frame=(), raises=()):
    caps = []

    def open_(index):
        if index in raises:
            raise RuntimeError("driver da camera")
        cap = FakeCap(index, opened=index not in bad, reads=index not in no_frame)
        caps.append(cap)
        return cap
    return open_, caps


class CameraSwitchTests(unittest.TestCase):
    def test_opens_initial_camera(self):
        op, caps = opener()
        sw = CameraSwitch(0, op)
        self.assertEqual((sw.index, sw.capture, sw.error), (0, caps[0], None))
        self.assertEqual(CAMERAS, (0, 1, 2))

    def test_request_is_applied_between_frames_and_releases_old(self):
        op, caps = opener()
        sw = CameraSwitch(0, op)
        self.assertTrue(sw.request(2))
        self.assertEqual(sw.index, 0)  # nada muda ate o laco de video aplicar
        self.assertTrue(sw.apply_pending())
        self.assertEqual((sw.index, sw.capture), (2, caps[1]))
        self.assertTrue(caps[0].released)

    def test_camera_that_does_not_open_falls_back_with_error(self):
        # Indice que nao existe neste PC (Review Focus 4): o detector nao fecha.
        op, caps = opener(bad=(2,))
        sw = CameraSwitch(0, op)
        sw.request(2)
        self.assertFalse(sw.apply_pending())
        self.assertEqual((sw.index, sw.capture), (0, caps[0]))
        self.assertFalse(caps[0].released)
        self.assertTrue(caps[1].released)
        self.assertEqual(sw.error, "Câmera 3 não abriu; voltou para a Câmera 1")

    def test_camera_without_first_frame_or_raising_also_falls_back(self):
        for kwargs in ({"no_frame": (1,)}, {"raises": (1,)}):
            op, caps = opener(**kwargs)
            sw = CameraSwitch(0, op)
            sw.request(1)
            self.assertFalse(sw.apply_pending())
            self.assertEqual(sw.index, 0)
            self.assertEqual(sw.error, "Câmera 2 não abriu; voltou para a Câmera 1")

    def test_successful_switch_clears_previous_error(self):
        op, _ = opener(bad=(2,))
        sw = CameraSwitch(0, op)
        sw.request(2)
        sw.apply_pending()
        sw.request(1)
        self.assertTrue(sw.apply_pending())
        self.assertIsNone(sw.error)

    def test_invalid_or_same_requests_are_ignored(self):
        op, _ = opener()
        sw = CameraSwitch(0, op)
        for bad in (3, -1, "1", None, 1.5, True):
            self.assertFalse(sw.request(bad))
        self.assertFalse(sw.request(0))
        self.assertFalse(sw.apply_pending())

    def test_handler_reads_camera_from_payload(self):
        op, _ = opener()
        sw = CameraSwitch(0, op)
        handler = set_camera_handler(sw)
        handler({"camera": 1})
        handler("lixo")
        self.assertTrue(sw.apply_pending())
        self.assertEqual(sw.index, 1)


if __name__ == "__main__":
    unittest.main()
```

Acrescentar em `tests/test_gesture_broker_client.py` (na classe que já existe e no `FakeSio`):
- no `FakeSio.__init__`, `self.on_calls = []`;
- método novo: `def on(self, event, fn): self.on_calls.append(event)`.

```python
    def test_handlers_are_registered_on_the_client(self):
        sio = FakeSio(fail=False)
        WebSocketBrokerClient("http://x:3000", 1, handlers={"setCamera": lambda d: None},
                              client_factory=lambda: sio, spawn=lambda fn: fn())
        self.assertEqual(sio.on_calls, ["setCamera"])
        self.assertEqual(sio.connect_calls, [])  # registra antes de qualquer connect

    def test_gesture_status_payload_with_camera(self):
        self.assertEqual(gesture_status_payload(1, False, 5, camera=2, camera_error="Câmera 3 não abriu"),
                         {"player": 1, "handSeen": False, "timeStamp": 5, "camera": 2, "cameraError": "Câmera 3 não abriu"})
        self.assertEqual(gesture_status_payload(1, False, 5, camera=0),
                         {"player": 1, "handSeen": False, "timeStamp": 5, "camera": 0, "cameraError": None})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `$PY -m unittest tests.test_camera_switch tests.test_gesture_broker_client -v`
Expected: ERROR, `No module named 'camera_switch'`; FAIL/ERROR nos dois testes novos do broker_client (`unexpected keyword argument`)

- [ ] **Step 3: Implementar**

`gesture_detector/camera_switch.py`:

```python
# NEU-86: troca de camera pedida pelo painel. O pedido chega na thread do socket.io;
# o laco de video aplica entre dois frames. Sem cv2 aqui: o "abridor" e injetado
# (cv2.VideoCapture no detector, um falso nos testes).
import threading

CAMERAS = (0, 1, 2)


def _valid(index) -> bool:
    return isinstance(index, int) and not isinstance(index, bool) and index in CAMERAS


class CameraSwitch:
    def __init__(self, initial_index: int, opener):
        self._opener = opener
        self._lock = threading.Lock()
        self._pending = None
        self.index = initial_index
        self.capture = opener(initial_index)
        self.error = None

    def request(self, index) -> bool:
        if not _valid(index):
            return False
        with self._lock:
            if index == self.index and self._pending is None:
                return False
            self._pending = index
        return True

    def apply_pending(self) -> bool:
        """Chamado pelo laco de video. False sem pedido ou quando a camera nova nao abriu."""
        with self._lock:
            new, self._pending = self._pending, None
        if new is None or new == self.index:
            return False
        cap = None
        try:
            cap = self._opener(new)
            ok = cap is not None and cap.isOpened() and bool(cap.read()[0])
        except Exception:  # noqa: BLE001 - driver de camera falha de muitos jeitos
            ok = False
        if not ok:
            if cap is not None:
                try:
                    cap.release()
                except Exception:  # noqa: BLE001
                    pass
            self.error = f"Câmera {new + 1} não abriu; voltou para a Câmera {self.index + 1}"
            return False
        self.capture.release()
        self.capture, self.index, self.error = cap, new, None
        return True


def set_camera_handler(switch: CameraSwitch):
    def on_set_camera(data):
        switch.request(data.get("camera") if isinstance(data, dict) else None)
    return on_set_camera
```

Em `gesture_detector/broker_client.py`:

```python
def gesture_status_payload(player_id: int, hand_seen: bool, now_ms: int, camera=None, camera_error=None) -> dict:
    payload = {"player": player_id, "handSeen": bool(hand_seen), "timeStamp": now_ms}
    # NEU-86: camera em uso e o erro da ultima troca, para o painel.
    if camera is not None:
        payload["camera"] = camera
        payload["cameraError"] = camera_error
    return payload
```

No `WebSocketBrokerClient.__init__`, acrescentar o parâmetro `handlers=None` (depois de `spawn`). Logo depois de `self.sio = client_factory()`:

```python
        # NEU-86: comandos do broker (setCamera). Registrados antes de qualquer connect.
        for event, fn in (handlers or {}).items():
            self.sio.on(event, fn)
```

Em `gesture_detector/hand_fist_detector.py`:
- import: `from camera_switch import CameraSwitch, set_camera_handler`;
- trocar `cap = cv2.VideoCapture(CAMERA_INDEX)` por `cameras = CameraSwitch(CAMERA_INDEX, cv2.VideoCapture)`;
- o `with` passa a ser:

```python
    with WebSocketBrokerClient(BROKER_URL, PLAYER_ID, meta=meta, handlers={"setCamera": set_camera_handler(cameras)}) as broker:
        while True:
            # NEU-86: troca pedida pelo painel, aplicada entre dois frames.
            previous_error = cameras.error
            if cameras.apply_pending():
                print(f"Camera trocada para a Camera {cameras.index + 1}.")
            elif cameras.error and cameras.error != previous_error:
                print(f"[WARN] {cameras.error}")

            ret, frame = cameras.capture.read()
```

- o `gestureStatus` passa a levar a câmera:

```python
                broker.send_event("gestureStatus", gesture_status_payload(PLAYER_ID, detector.last_hand_seen, int(time.time() * 1000), camera=cameras.index, camera_error=cameras.error))
```

- depois do `cv2.putText` do estado, mostrar a câmera, que é como o operador confere qual aparelho é:

```python
            cv2.putText(frame, f"Camera {cameras.index + 1}", (10, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)
```

- no fim, trocar `cap.release()` por `cameras.capture.release()`.

- [ ] **Step 4: Rodar a suíte Python**

Run: `$PY -m unittest discover -s tests -p "test_*.py"`
Expected: `OK`

- [ ] **Step 5: Conferir a sintaxe do detector** (ele importa `cv2` e `mediapipe`, que não estão no venv)

Run: `$PY -m py_compile gesture_detector/hand_fist_detector.py`
Expected: sem saída

- [ ] **Step 6: Commit**

```bash
git add gesture_detector/camera_switch.py gesture_detector/broker_client.py gesture_detector/hand_fist_detector.py tests/test_camera_switch.py tests/test_gesture_broker_client.py
git commit -m "feat(gesto): troca de camera pelo setCamera do broker, com volta para a anterior se falhar [NEU-86]"
```

---

### Task 4: broker guarda a escolha e garante que bot nunca sobe (B2)

**Files:**
- Create: `data_broker/player_setup.js`
- Modify: `data_broker/session_manager.js`, `data_broker/public/ops_state.js` (só `RACE_LOCK_MS`)
- Test: `data_broker/tests/test_player_setup.test.js`, `data_broker/tests/test_player_setup_session.test.js`, `data_broker/tests/test_bot_never_uploads_integration.test.js`

**Interfaces:**
- Produces:
  - de `player_setup.js`:
    - `PLAYER_SETUP_KEY = 'players:setup'`
    - `createPlayerSetup(redis, { raceInProgress, onChange, log })`, com:
      - `load() -> Promise<setup>`
      - `get() -> { 1: { source, camera }, 2: { source, camera } }`
      - `setSource(player, source)` e `setCamera(player, camera)`, que devolvem `Promise<{ ok: true, setup } | { ok: false, error }>`
    - `onChange(field: 'source'|'camera', player)`
  - de `ops_state`: `RACE_LOCK_MS`
  - de `session_manager`: `session.raceInProgress(at?) -> Promise<boolean>`

- [ ] **Step 1: Escrever os testes**

`data_broker/tests/test_player_setup.test.js`:

```js
// NEU-86: escolha de fonte e camera por jogador, guardada no Redis do PC central.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createPlayerSetup, PLAYER_SETUP_KEY } = require('../player_setup');

const DEFAULT = { 1: { source: 'neurosky', camera: null }, 2: { source: 'neurosky', camera: null } };

test('padrao: NeuroSky nos dois e camera sem escolha', async () => {
  const setup = createPlayerSetup(new FakeRedis());
  assert.deepEqual(setup.get(), DEFAULT);
  assert.deepEqual(await setup.load(), DEFAULT);
});

test('grava no Redis e outro broker le de volta (sobrevive a reinicio)', async () => {
  const redis = new FakeRedis(); const changes = [];
  const a = createPlayerSetup(redis, { onChange: (field, player) => changes.push([field, player]) });
  assert.deepEqual(await a.setSource(2, 'bot'), { ok: true, setup: { 1: DEFAULT[1], 2: { source: 'bot', camera: null } } });
  assert.equal((await a.setCamera(1, 2)).ok, true);
  assert.deepEqual(changes, [['source', 2], ['camera', 1]]);
  const b = createPlayerSetup(redis);
  await b.load();
  assert.deepEqual(b.get(), { 1: { source: 'neurosky', camera: 2 }, 2: { source: 'bot', camera: null } });
});

test('valores invalidos sao recusados sem gravar nem avisar', async () => {
  const redis = new FakeRedis(); const changes = [];
  const setup = createPlayerSetup(redis, { onChange: () => changes.push(1) });
  for (const [p, s, error] of [[3, 'bot', 'invalid_player'], ['1', 'bot', 'invalid_player'], [1, 'real', 'invalid_source'], [1, 'BOT', 'invalid_source'], [1, undefined, 'invalid_source']]) {
    assert.deepEqual(await setup.setSource(p, s), { ok: false, error }, `${p}/${s}`);
  }
  for (const [p, c, error] of [[0, 1, 'invalid_player'], [1, 3, 'invalid_camera'], [1, -1, 'invalid_camera'], [1, '1', 'invalid_camera'], [1, 1.5, 'invalid_camera'], [1, true, 'invalid_camera']]) {
    assert.deepEqual(await setup.setCamera(p, c), { ok: false, error }, `${p}/${c}`);
  }
  assert.deepEqual(await redis.hgetall(PLAYER_SETUP_KEY), {});
  assert.deepEqual(changes, []);
});

test('durante a corrida nada muda', async () => {
  const setup = createPlayerSetup(new FakeRedis(), { raceInProgress: async () => true });
  assert.deepEqual(await setup.setSource(1, 'bot'), { ok: false, error: 'race_in_progress' });
  assert.deepEqual(await setup.setCamera(1, 1), { ok: false, error: 'race_in_progress' });
  assert.deepEqual(setup.get(), DEFAULT);
});

test('lixo no Redis vira o padrao', async () => {
  const redis = new FakeRedis();
  await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'xyz', 'p1Camera', '9', 'p2Camera', '');
  const setup = createPlayerSetup(redis);
  assert.deepEqual(await setup.load(), DEFAULT);
});

test('get devolve copia (quem chama nao muda o estado)', () => {
  const setup = createPlayerSetup(new FakeRedis());
  setup.get()[1].source = 'bot';
  assert.equal(setup.get()[1].source, 'neurosky');
});
```

`data_broker/tests/test_player_setup_session.test.js`:

```js
// NEU-86 (spec B2): quem decide que o jogador e bot e a escolha do painel, nao o rotulo do dado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { PLAYER_SETUP_KEY } = require('../player_setup');
const { RACE_LOCK_MS } = require('../public/ops_state');

const T = 1_700_000_000_000;
function make(redis = new FakeRedis()) {
  return { redis, session: createSessionManager(redis, {}, () => {}, { now: () => T }) };
}

test('lado em Bot: o registro ignora o e-mail e ele nao entra nos ultimos jogadores', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', 'b@x.com');
  const pending = await redis.hgetall('pending:players');
  assert.deepEqual([pending.player1Email, pending.player2Email], ['a@x.com', '']);
  assert.deepEqual((await session.getRecentPlayers()).map((p) => p.contact), ['a@x.com']);
});

test('largada: lado que virou Bot depois do registro corre como bot', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'bot');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.deepEqual([s.player1IsBot, s.player1Email, s.player2IsBot, s.player2Email], ['true', '', 'false', 'b@x.com']);
});

test('B2: NeuroSky cadastrado x Bot = 1 registro na fila, mesmo com o bot mandando dado "real"', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onEsense({ player: 1, source: 'real', attention: 50, timeStamp: 1 });
  await session.onEsense({ player: 2, source: 'real', attention: 60, timeStamp: 1 }); // perfil banca: simulador como real
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1);
  assert.equal(JSON.parse(queue[0]).playerId, 1);
});

test('B2: Bot x Bot = 0 registros', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'bot', 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onEsense({ player: 1, source: 'real', attention: 50, timeStamp: 1 });
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
});

async function activeSession(redis, fields) {
  await redis.hset('session:current', 'id', 's1', 'status', 'active', 'player1IsBot', 'false', 'player2IsBot', 'true', ...fields);
}

test('raceInProgress: sem sessao, nao', async () => {
  const { session } = make();
  assert.equal(await session.raceInProgress(), false);
});

test('raceInProgress: humano correndo ha 1 min, sim; depois que ele termina, nao', async () => {
  const { redis, session } = make();
  await activeSession(redis, ['startedAt', String(T - 60_000)]);
  assert.equal(await session.raceInProgress(), true);
  await redis.hset('session:current', 'player1Dispatched', 'true');
  assert.equal(await session.raceInProgress(), false);
});

test('raceInProgress: sessao esquecida (mais de 10 min) nao trava para sempre', async () => {
  const { redis, session } = make();
  await activeSession(redis, ['startedAt', String(T - RACE_LOCK_MS - 60_000)]);
  assert.equal(await session.raceInProgress(), false);
});

test('raceInProgress: bot contra bot nao trava', async () => {
  const { redis, session } = make();
  await activeSession(redis, ['startedAt', String(T - 60_000), 'player1IsBot', 'true']);
  assert.equal(await session.raceInProgress(), false);
});
```

> Nota para quem executa: o `FakeRedis.hset` grava os pares na ordem, então o `'player1IsBot', 'true'` repetido no último teste sobrescreve o `'false'` de `activeSession`. Se o `FakeRedis` não fizer isso, o teste acusa.

`data_broker/tests/test_bot_never_uploads_integration.test.js` (contra Redis real; pulado sem `REDIS_URL`):

```js
// NEU-86 (spec B2), CA contra Redis real: a escolha do painel decide quem vai para a fila.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionManager } = require('../session_manager');
const { PLAYER_SETUP_KEY } = require('../player_setup');

const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : 'REDIS_URL nao definido';
const KEYS = ['pending:players', 'session:current', 'dispatch:queue', PLAYER_SETUP_KEY];

async function withRedis(fn) {
  const Redis = require('ioredis');
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  await redis.del(...KEYS);
  try { await fn(redis, createSessionManager(redis, {}, () => {})); } finally {
    await redis.del(...KEYS);
    await redis.zrem('players:recent', 'humano-neu86@x.com', 'bot-neu86@x.com');
    await redis.quit();
  }
}

async function race(session, { p1, p2 }) {
  await session.registerPlayers('humano-neu86@x.com', 'bot-neu86@x.com');
  await session.onRaceStarted();
  if (p1) await session.onEsense({ player: 1, source: 'real', attention: 50, timeStamp: 1 });
  if (p2) await session.onEsense({ player: 2, source: 'real', attention: 50, timeStamp: 1 });
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
}

test('integracao B2: NeuroSky cadastrado x Bot = 1 registro, o do P1', { skip }, async () => {
  await withRedis(async (redis, session) => {
    await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
    await race(session, { p1: true, p2: true });
    const queue = await redis.lrange('dispatch:queue', 0, -1);
    assert.deepEqual(queue.map((r) => JSON.parse(r).playerId), [1]);
  });
});

test('integracao B2: Bot x Bot = 0 registros', { skip }, async () => {
  await withRedis(async (redis, session) => {
    await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'bot', 'p2Source', 'bot');
    await race(session, { p1: true, p2: true });
    assert.equal(await redis.llen('dispatch:queue'), 0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test data_broker/tests/test_player_setup.test.js data_broker/tests/test_player_setup_session.test.js`
Expected: FAIL, `Cannot find module '../player_setup'`

- [ ] **Step 3: Implementar**

Em `data_broker/public/ops_state.js`:
- no topo da factory, logo antes de `function normalizeEmail`:

```js
  // NEU-86: fonte e camera ficam travadas durante a corrida, mas so ate 10 min depois
  // da largada: a sessao nunca expira (L3), e uma corrida esquecida travaria para sempre.
  const RACE_LOCK_MS = 10 * 60 * 1000;
```

- acrescentar `RACE_LOCK_MS` no objeto do `return { ... }` final.

`data_broker/player_setup.js`:

```js
// data_broker/player_setup.js
// NEU-86: fonte (NeuroSky | Bot) e camera de cada jogador, escolhidas no painel. Fica no
// Redis do PC central (sobrevive a reinicio do broker) e numa copia em memoria, porque o
// /api/status e sincrono. Quem manda o comando para a peca e o piece_commands (onChange).
const PLAYER_SETUP_KEY = 'players:setup';
const SOURCES = new Set(['neurosky', 'bot']);
const CAMERAS = new Set([0, 1, 2]);

const validPlayer = (p) => p === 1 || p === 2;
const validCamera = (c) => typeof c === 'number' && Number.isInteger(c) && CAMERAS.has(c);

function parse(hash) {
  const h = hash || {};
  const out = {};
  for (const p of [1, 2]) {
    const source = SOURCES.has(h[`p${p}Source`]) ? h[`p${p}Source`] : 'neurosky';
    const raw = h[`p${p}Camera`];
    const camera = raw !== undefined && raw !== '' && validCamera(Number(raw)) ? Number(raw) : null;
    out[p] = { source, camera };
  }
  return out;
}

function createPlayerSetup(redis, { raceInProgress = async () => false, onChange = () => {}, log = () => {} } = {}) {
  let current = parse({});

  const get = () => ({ 1: { ...current[1] }, 2: { ...current[2] } });

  async function load() {
    current = parse(await redis.hgetall(PLAYER_SETUP_KEY));
    return get();
  }

  async function set(player, field, value) {
    if (await raceInProgress()) return { ok: false, error: 'race_in_progress' };
    await redis.hset(PLAYER_SETUP_KEY, `p${player}${field === 'source' ? 'Source' : 'Camera'}`, String(value));
    current[player][field] = value;
    log('info', 'player_setup_changed', { player, field, value });
    onChange(field, player);
    return { ok: true, setup: get() };
  }

  async function setSource(player, source) {
    if (!validPlayer(player)) return { ok: false, error: 'invalid_player' };
    if (!SOURCES.has(source)) return { ok: false, error: 'invalid_source' };
    return set(player, 'source', source);
  }

  async function setCamera(player, camera) {
    if (!validPlayer(player)) return { ok: false, error: 'invalid_player' };
    if (!validCamera(camera)) return { ok: false, error: 'invalid_camera' };
    return set(player, 'camera', camera);
  }

  return { load, get, setSource, setCamera };
}

module.exports = { createPlayerSetup, PLAYER_SETUP_KEY };
```

Em `data_broker/session_manager.js`:
- `const { normalizeEmail, validateEmail, RACE_LOCK_MS } = require('./public/ops_state');`
- `const { PLAYER_SETUP_KEY } = require('./player_setup');`
- função dentro de `createSessionManager`:

```js
  // NEU-86 (spec B2): lado escolhido como Bot no painel nunca e cadastrado nem enviado.
  async function botSlots() {
    const setup = (await redis.hgetall(PLAYER_SETUP_KEY)) || {};
    return { 1: setup.p1Source === 'bot', 2: setup.p2Source === 'bot' };
  }
```

- em `registerPlayers`, logo no começo:

```js
    const bots = await botSlots();
    const player1Email = bots[1] ? '' : checkEmail(rawPlayer1Email, 'player1Email');
    const player2Email = bots[2] ? '' : checkEmail(rawPlayer2Email, 'player2Email');
```

Isso substitui as duas linhas `checkEmail` atuais.
- em `onRaceStarted`, depois de ler o `pending`:

```js
    const bots = await botSlots();
    const player1Email = bots[1] ? '' : pending?.player1Email || '';
    const player1Uuid = bots[1] ? '' : pending?.player1Uuid || '';
    const player2Email = bots[2] ? '' : pending?.player2Email || '';
    const player2Uuid = bots[2] ? '' : pending?.player2Uuid || '';
```

Isso substitui as 4 linhas atuais. O `IsBot` continua `email === ''`, que agora inclui o lado Bot.
- função nova, devolvida no objeto:

```js
  // NEU-86: ha corrida de gente em andamento? Trava a troca de fonte e camera.
  async function raceInProgress(at = now()) {
    const s = await redis.hgetall('session:current');
    if (!s || s.status !== 'active') return false;
    if (!(at - Number(s.startedAt) < RACE_LOCK_MS)) return false;
    return [1, 2].some((n) => s[`player${n}IsBot`] !== 'true' && s[`player${n}Dispatched`] !== 'true');
  }
```

- `return { registerPlayers, onRaceStarted, onEsense, onHasFinished, getCurrentSession, getDispatchHistory, getRecentPlayers, clearRecentPlayers, raceInProgress };`

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test data_broker/tests/test_player_setup.test.js data_broker/tests/test_player_setup_session.test.js`
Expected: PASS, 14 testes

- [ ] **Step 5: Integração contra Redis real**

Run (bash):

```bash
docker run -d --rm -p 127.0.0.1:6399:6379 --name neu86-redis redis:7-alpine
REDIS_URL=redis://127.0.0.1:6399 node --test --test-concurrency=1 data_broker/tests/test_bot_never_uploads_integration.test.js data_broker/tests/test_session_integration.test.js
docker stop neu86-redis
```

Expected: PASS em todos, 0 skip

- [ ] **Step 6: Suíte Node**

Run: `npm --prefix data_broker run validate`
Expected: `fail 0`

- [ ] **Step 7: Commit**

```bash
git add data_broker/player_setup.js data_broker/session_manager.js data_broker/public/ops_state.js data_broker/tests/test_player_setup.test.js data_broker/tests/test_player_setup_session.test.js data_broker/tests/test_bot_never_uploads_integration.test.js
git commit -m "feat(broker): escolha de fonte/camera por jogador no Redis e bot pelo painel nunca vai para a fila [NEU-86]"
```

---

### Task 5: broker manda `setSource` e `setCamera` e expõe as rotas

**Files:**
- Create: `data_broker/piece_commands.js`
- Modify: `data_broker/socket_handlers.js`, `data_broker/presence.js`, `data_broker/event_contracts.js`, `data_broker/http_server.js`, `data_broker/index.js`
- Test: `data_broker/tests/test_piece_commands.test.js`, `data_broker/tests/test_player_setup_routes.test.js`, `data_broker/tests/test_presence.test.js`, `data_broker/tests/test_presence_wiring.test.js`

**Interfaces:**
- Consumes: `createPlayerSetup(...).get()`, `setSource` e `setCamera` (Task 4).
- Produces:
  - `createPieceCommands(playerSetup, log)`, com `attach(socket, pieceKey)`, `pushSource(player)`, `pushCamera(player)` e `pushAll()`
  - `registerSocketHandlers(io, log, runtimeState, session, presence = null, now = Date.now, hooks = {})`, com `hooks.onPieceConnect(socket, pieceKey)`
  - `createHttpServer(getHealthSnapshot, session, log, dispatchAdmin, getStatus, playerSetup = null)`
  - `buildStatus({ ..., setup })`, que devolve `setup`
  - a peça na `presence` ganha `camera` e `cameraError`

- [ ] **Step 1: Escrever os testes**

`data_broker/tests/test_piece_commands.test.js`:

```js
// NEU-86: o broker manda a escolha do painel so para a peca certa.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPieceCommands } = require('../piece_commands');

function fakeSetup(state) { return { get: () => JSON.parse(JSON.stringify(state)) }; }
function fakeSocket() {
  return { sent: [], handlers: {}, emit(event, payload) { this.sent.push([event, payload]); }, on(event, fn) { this.handlers[event] = fn; } };
}
const STATE = { 1: { source: 'bot', camera: null }, 2: { source: 'neurosky', camera: 2 } };

test('acquisition recebe a fonte guardada assim que conecta', () => {
  const cmds = createPieceCommands(fakeSetup(STATE));
  const a1 = fakeSocket(); const a2 = fakeSocket();
  cmds.attach(a1, 'acquisition-p1'); cmds.attach(a2, 'acquisition-p2');
  assert.deepEqual(a1.sent, [['setSource', { source: 'bot' }]]);
  assert.deepEqual(a2.sent, [['setSource', { source: 'neurosky' }]]);
});

test('gesto so recebe camera quando ha escolha guardada', () => {
  const cmds = createPieceCommands(fakeSetup(STATE));
  const g1 = fakeSocket(); const g2 = fakeSocket();
  cmds.attach(g1, 'gesture-p1'); cmds.attach(g2, 'gesture-p2');
  assert.deepEqual(g1.sent, []);
  assert.deepEqual(g2.sent, [['setCamera', { camera: 2 }]]);
});

test('pushSource vai so para a acquisition daquele jogador', () => {
  const state = JSON.parse(JSON.stringify(STATE));
  const cmds = createPieceCommands({ get: () => state });
  const s = { a1: fakeSocket(), a1b: fakeSocket(), a2: fakeSocket(), g1: fakeSocket(), panel: fakeSocket() };
  cmds.attach(s.a1, 'acquisition-p1'); cmds.attach(s.a1b, 'acquisition-p1'); cmds.attach(s.a2, 'acquisition-p2');
  cmds.attach(s.g1, 'gesture-p1'); cmds.attach(s.panel, 'panel');
  for (const x of Object.values(s)) x.sent = [];
  state[1].source = 'neurosky';
  cmds.pushSource(1);
  assert.deepEqual(s.a1.sent, [['setSource', { source: 'neurosky' }]]);
  assert.deepEqual(s.a1b.sent, [['setSource', { source: 'neurosky' }]]); // reconexao com socket velho aberto
  for (const k of ['a2', 'g1', 'panel']) assert.deepEqual(s[k].sent, [], k);
});

test('socket desconectado nao recebe mais', () => {
  const cmds = createPieceCommands(fakeSetup(STATE));
  const g2 = fakeSocket();
  cmds.attach(g2, 'gesture-p2');
  g2.handlers.disconnect();
  g2.sent = [];
  cmds.pushCamera(2);
  assert.deepEqual(g2.sent, []);
});

test('pushAll reenvia tudo (broker leu a escolha do Redis depois que as pecas conectaram)', () => {
  const state = { 1: { source: 'neurosky', camera: null }, 2: { source: 'neurosky', camera: null } };
  const cmds = createPieceCommands({ get: () => state });
  const a2 = fakeSocket(); const g1 = fakeSocket();
  cmds.attach(a2, 'acquisition-p2'); cmds.attach(g1, 'gesture-p1');
  state[2].source = 'bot'; state[1].camera = 1;
  cmds.pushAll();
  assert.deepEqual(a2.sent.at(-1), ['setSource', { source: 'bot' }]);
  assert.deepEqual(g1.sent, [['setCamera', { camera: 1 }]]);
});
```

`data_broker/tests/test_player_setup_routes.test.js`:

```js
// NEU-86: rotas de troca de fonte e camera.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpServer } = require('../http_server');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function request(port, { method = 'POST', path, body, json = true }) {
  return new Promise((resolve, reject) => {
    const headers = json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded' };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  });
}
function stub(result) {
  return {
    calls: [],
    async setSource(p, s) { this.calls.push(['source', p, s]); return result; },
    async setCamera(p, c) { this.calls.push(['camera', p, c]); return result; },
  };
}
async function withServer(playerSetup, fn) {
  const server = createHttpServer(() => ({ status: 'ok' }), null, () => {}, null, null, playerSetup);
  const port = await listen(server);
  try { await fn(port); } finally { server.close(); }
}

test('POST /api/players/source repassa jogador e fonte; 200 com o setup', async () => {
  const setup = stub({ ok: true, setup: { 1: { source: 'bot', camera: null } } });
  await withServer(setup, async (port) => {
    const res = await request(port, { path: '/api/players/source', body: JSON.stringify({ player: 1, source: 'bot' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, setup: { 1: { source: 'bot', camera: null } } });
    assert.deepEqual(setup.calls, [['source', 1, 'bot']]);
  });
});

test('POST /api/players/camera repassa jogador e camera', async () => {
  const setup = stub({ ok: true, setup: {} });
  await withServer(setup, async (port) => {
    const res = await request(port, { path: '/api/players/camera', body: JSON.stringify({ player: 2, camera: 1 }) });
    assert.equal(res.status, 200);
    assert.deepEqual(setup.calls, [['camera', 2, 1]]);
  });
});

test('erros: 400 para valor invalido, 409 durante a corrida', async () => {
  for (const [error, status] of [['invalid_player', 400], ['invalid_source', 400], ['invalid_camera', 400], ['race_in_progress', 409]]) {
    await withServer(stub({ ok: false, error }), async (port) => {
      const res = await request(port, { path: '/api/players/source', body: JSON.stringify({ player: 1, source: 'x' }) });
      assert.equal(res.status, status, error);
      assert.deepEqual(JSON.parse(res.body), { ok: false, error });
    });
  }
});

test('sem JSON = 415 (CSRF por formulario), JSON quebrado = 400, corpo grande = 413', async () => {
  const setup = stub({ ok: true, setup: {} });
  await withServer(setup, async (port) => {
    assert.equal((await request(port, { path: '/api/players/source', body: 'player=1&source=bot', json: false })).status, 415);
    assert.equal((await request(port, { path: '/api/players/source', body: '{nao' })).status, 400);
    assert.equal((await request(port, { path: '/api/players/camera', body: JSON.stringify({ x: 'y'.repeat(5000) }) })).status, 413);
    assert.deepEqual(setup.calls, []);
  });
});

test('sem playerSetup as rotas nao existem', async () => {
  await withServer(null, async (port) => {
    assert.equal((await request(port, { path: '/api/players/source', body: '{}' })).status, 404);
  });
});
```

Em `data_broker/tests/test_presence.test.js`, nos dois `deepEqual` de `acquisition-p2` (linhas 21 e 32), acrescentar `camera: null, cameraError: null` antes de `meta`. Também acrescentar:

```js
test('gestureStatus guarda a camera em uso e o erro da ultima troca (NEU-86)', () => {
  const p = createPresence();
  p.onConnect('g1', { role: 'gesture', player: 1 }, 100);
  p.onEvent('g1', 'gestureStatus', { player: 1, handSeen: true, timeStamp: 1, camera: 2, cameraError: 'x'.repeat(500) }, 200);
  const g = p.snapshot().pieces['gesture-p1'];
  assert.equal(g.camera, 2);
  assert.equal(g.cameraError.length, 200);
  p.onEvent('g1', 'gestureStatus', { player: 1, handSeen: true, timeStamp: 2 }, 300); // detector antigo, sem camera
  assert.equal(p.snapshot().pieces['gesture-p1'].camera, 2);
});

test('buildStatus inclui o setup dos jogadores (NEU-86)', () => {
  const setup = { 1: { source: 'bot', camera: null }, 2: { source: 'neurosky', camera: 1 } };
  const s = buildStatus({ presence: createPresence(), redisStatus: 'ready', brokerVersion: 'abc1234', startedAt: 0, now: 1000, setup });
  assert.deepEqual(s.setup, setup);
});
```

Acrescentar `buildStatus` ao `require('../presence')` do arquivo, que hoje importa só `createPresence`, `keyFromAuth` e `PIECES`.

Em `data_broker/tests/test_presence_wiring.test.js`, acrescentar:

```js
test('onPieceConnect recebe o socket e a chave da peca; jogo anonimo tambem passa', () => {
  const { io, connect } = fakeIo();
  const seen = [];
  registerSocketHandlers(io, () => {}, createRuntimeState(), null, createPresence(), () => 1, { onPieceConnect: (socket, key) => seen.push([socket.id, key]) });
  connect('a1', { role: 'acquisition', player: 1 });
  connect('game', undefined);
  assert.deepEqual(seen, [['a1', 'acquisition-p1'], ['game', 'unidentified']]);
});

test('validateEventPayload gestureStatus com camera (NEU-86)', () => {
  const base = { player: 1, handSeen: true, timeStamp: 1 };
  assert.equal(validateEventPayload('gestureStatus', { ...base, camera: 2, cameraError: null }), null);
  assert.equal(validateEventPayload('gestureStatus', { ...base, camera: 0, cameraError: 'Câmera 3 não abriu' }), null);
  assert.equal(validateEventPayload('gestureStatus', { ...base, camera: 'um' }), 'camera_must_be_number');
  assert.equal(validateEventPayload('gestureStatus', { ...base, camera: 1, cameraError: 5 }), 'cameraError_must_be_string_or_null');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test data_broker/tests/test_piece_commands.test.js data_broker/tests/test_player_setup_routes.test.js data_broker/tests/test_presence.test.js data_broker/tests/test_presence_wiring.test.js`
Expected: FAIL, `Cannot find module '../piece_commands'`; 404 nas rotas; camera `undefined` na presence; `seen` vazio

- [ ] **Step 3: Implementar**

`data_broker/piece_commands.js`:

```js
// data_broker/piece_commands.js
// NEU-86: comandos do broker para as pecas. A acquisition recebe `setSource` (NeuroSky |
// Bot) e o detector recebe `setCamera`, na conexao (escolha guardada) e quando o operador
// troca. So a peca daquele jogador recebe. Peca antiga sem handler ignora em silencio.
const KEY_RE = /^(acquisition|gesture)-p([12])$/;

function createPieceCommands(playerSetup, log = () => {}) {
  const sockets = new Map(); // pieceKey -> Set(socket)

  function sendTo(socket, key) {
    const m = KEY_RE.exec(key);
    if (!m) return;
    const setup = playerSetup.get()[Number(m[2])];
    if (m[1] === 'acquisition') socket.emit('setSource', { source: setup.source });
    else if (setup.camera !== null) socket.emit('setCamera', { camera: setup.camera });
  }

  function attach(socket, key) {
    if (!KEY_RE.test(key)) return;
    if (!sockets.has(key)) sockets.set(key, new Set());
    sockets.get(key).add(socket);
    socket.on('disconnect', () => sockets.get(key).delete(socket));
    sendTo(socket, key);
  }

  function push(key) {
    const set = sockets.get(key);
    for (const socket of set || []) sendTo(socket, key);
    log('info', 'piece_command_pushed', { piece: key, sockets: set ? set.size : 0 });
  }

  return {
    attach,
    pushSource: (player) => push(`acquisition-p${player}`),
    pushCamera: (player) => push(`gesture-p${player}`),
    pushAll: () => { for (const p of [1, 2]) { push(`acquisition-p${p}`); push(`gesture-p${p}`); } },
  };
}

module.exports = { createPieceCommands };
```

Em `data_broker/socket_handlers.js`:
- assinatura `function registerSocketHandlers(io, log, runtimeState, session, presence = null, now = Date.now, hooks = {})`;
- logo depois do `log('info', 'client_connected', ...)`:

```js
    // NEU-86: o broker manda a escolha do painel (fonte/camera) para a peca que chegou.
    if (piece && typeof hooks.onPieceConnect === 'function') hooks.onPieceConnect(socket, piece);
```

Em `data_broker/event_contracts.js`, no `validateGestureStatusPayload`, antes do `return null`:

```js
  // NEU-86: camera em uso e erro da ultima troca (opcionais: detector antigo nao manda).
  if (payload.camera !== undefined && !isFiniteNumber(payload.camera)) return 'camera_must_be_number';
  const camErr = payload.cameraError;
  if (camErr !== undefined && camErr !== null && typeof camErr !== 'string') return 'cameraError_must_be_string_or_null';
```

Em `data_broker/presence.js`:
- `emptyPiece()` ganha `camera: null, cameraError: null` (antes de `meta`);
- no ramo `gestureStatus` do `onEvent`:

```js
    } else if (event === 'gestureStatus') {
      s.data.handSeen = p.handSeen === true;
      // NEU-86: detector antigo nao manda camera; mantem a ultima conhecida.
      if (typeof p.camera === 'number' && Number.isFinite(p.camera)) s.data.camera = p.camera;
      if (p.camera !== undefined) s.data.cameraError = typeof p.cameraError === 'string' ? p.cameraError.slice(0, 200) : null;
```

- `buildStatus({ presence, redisStatus, brokerVersion, startedAt, now, setup = null })`, com `setup` no objeto devolvido.

Em `data_broker/http_server.js`, antes de `createHttpServer`:

```js
const SETUP_STATUS = { invalid_player: 400, invalid_source: 400, invalid_camera: 400, race_in_progress: 409 };

// NEU-86: POST /api/players/source e /api/players/camera. JSON obrigatorio (CSRF, como o requeue).
function handleSetup(req, res, log, apply) {
  if (!isJsonRequest(req)) {
    sendJson(res, 415, { error: 'unsupported_media_type' });
    req.resume();
    return;
  }
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { error: 'payload_too_large' });
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (aborted) return;
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'invalid_json' }); return; }
    try {
      const result = await apply(data || {});
      sendJson(res, result.ok ? 200 : SETUP_STATUS[result.error] || 500, result);
    } catch (err) {
      log('error', 'api_player_setup_error', { error: err?.message ?? String(err) });
      sendJson(res, 500, { error: 'internal_error' });
    }
  });
}
```

- assinatura `function createHttpServer(getHealthSnapshot, session, log = () => {}, dispatchAdmin = null, getStatus = null, playerSetup = null)`. Atualizar também o comentário de cabeçalho com uma linha sobre `playerSetup` (NEU-86);
- antes do `if (session && req.method === 'POST' && req.url === '/api/players')`:

```js
    if (playerSetup && req.method === 'POST' && req.url === '/api/players/source') {
      handleSetup(req, res, log, (d) => playerSetup.setSource(d.player, d.source));
      return;
    }
    if (playerSetup && req.method === 'POST' && req.url === '/api/players/camera') {
      handleSetup(req, res, log, (d) => playerSetup.setCamera(d.player, d.camera));
      return;
    }
```

Em `data_broker/index.js`:
- requires: `const { createPlayerSetup } = require('./player_setup');` e `const { createPieceCommands } = require('./piece_commands');`;
- depois de `const presence = createPresence();`:

```js
// NEU-86: fonte e camera de cada jogador (painel -> Redis -> comando para a peca).
let pieceCommands = null;
const playerSetup = createPlayerSetup(redis, {
  raceInProgress: () => session.raceInProgress(),
  onChange: (field, player) => (field === 'source' ? pieceCommands.pushSource(player) : pieceCommands.pushCamera(player)),
  log,
});
pieceCommands = createPieceCommands(playerSetup, log);
// Pecas que conectarem antes do load recebem o padrao; o pushAll corrige com o que estava guardado.
playerSetup.load()
  .then(() => pieceCommands.pushAll())
  .catch((err) => log('error', 'player_setup_load_error', { error: err?.message ?? String(err) }));
```

- `getStatus` passa `setup: playerSetup.get()` para o `buildStatus`;
- `createHttpServer(..., getStatus, playerSetup)`;
- `registerSocketHandlers(io, log, runtimeState, session, presence, Date.now, { onPieceConnect: (socket, key) => pieceCommands.attach(socket, key) });`

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test data_broker/tests/test_piece_commands.test.js data_broker/tests/test_player_setup_routes.test.js data_broker/tests/test_presence.test.js data_broker/tests/test_presence_wiring.test.js`
Expected: PASS

- [ ] **Step 5: Suíte Node**

Run: `npm --prefix data_broker run validate`
Expected: `fail 0` (o `node --check index.js` também precisa passar)

- [ ] **Step 6: Commit**

```bash
git add data_broker/piece_commands.js data_broker/socket_handlers.js data_broker/presence.js data_broker/event_contracts.js data_broker/http_server.js data_broker/index.js data_broker/tests/test_piece_commands.test.js data_broker/tests/test_player_setup_routes.test.js data_broker/tests/test_presence.test.js data_broker/tests/test_presence_wiring.test.js
git commit -m "feat(broker): rotas de fonte/camera, setSource/setCamera para a peca certa e camera na presenca [NEU-86]"
```

---

### Task 6: painel com NeuroSky | Bot e câmera em cada card

**Files:**
- Modify: `data_broker/public/ops_state.js`, `data_broker/public/index.html`, `data_broker/public/ops.js`, `data_broker/public/ops.css`
- Test: `data_broker/tests/test_ops_state.test.js`, `data_broker/tests/test_diagnostics.test.js`, `data_broker/tests/test_ops_screen.test.js`

**Interfaces:**
- Consumes:
  - `/api/status` com `setup` e `pieces['gesture-pN'].camera` e `.cameraError` (Task 5);
  - as rotas `POST /api/players/source` e `POST /api/players/camera` (Task 5);
  - `RACE_LOCK_MS` (Task 4).
- Produces:
  - `OpsState.setupLocked({ session, raceEvents, history, now }) -> boolean`
  - `OpsState.cameraText({ chosen, inUse, error }) -> string`

- [ ] **Step 1: Escrever os testes**

Acrescentar em `data_broker/tests/test_ops_state.test.js`. Se o arquivo não usa destructuring, usar `S.setupLocked` conforme o import que já existe.

```js
test('setupLocked: trava enquanto alguem corre, ate 10 min da largada (NEU-86)', () => {
  const { setupLocked, RACE_LOCK_MS } = require('../public/ops_state');
  const now = 1_000_000_000;
  const racing = { status: 'active', sessionId: 's1', startedAt: now - 60_000, player1Email: 'a@x.com', player2Email: '', player1IsBot: false, player2IsBot: true };
  assert.equal(setupLocked({ session: { status: 'none' }, raceEvents: {}, history: [], now }), false);
  assert.equal(setupLocked({ session: racing, raceEvents: { 1: false, 2: false }, history: [], now }), true);
  assert.equal(setupLocked({ session: { ...racing, player1Finished: true }, raceEvents: {}, history: [], now }), false);
  assert.equal(setupLocked({ session: { ...racing, startedAt: now - RACE_LOCK_MS - 1 }, raceEvents: {}, history: [], now }), false, 'sessao esquecida nao trava');
  assert.equal(setupLocked({ session: { ...racing, player1IsBot: true }, raceEvents: {}, history: [], now }), false, 'bot x bot nao trava');
  assert.equal(setupLocked({ session: { ...racing, pending: { player1Email: 'b@x.com', player2Email: '' } }, raceEvents: {}, history: [], now }), true, 'proxima dupla registrada nao destrava');
});

test('cameraText: erro, troca em andamento ou nada (NEU-86)', () => {
  const { cameraText } = require('../public/ops_state');
  assert.equal(cameraText({ chosen: 2, inUse: 0, error: 'Câmera 3 não abriu; voltou para a Câmera 1' }), 'Câmera 3 não abriu; voltou para a Câmera 1');
  assert.equal(cameraText({ chosen: 2, inUse: 0, error: null }), 'trocando para a Câmera 3…');
  assert.equal(cameraText({ chosen: 1, inUse: 1, error: null }), '');
  assert.equal(cameraText({ chosen: null, inUse: 0, error: null }), '');
  assert.equal(cameraText({ chosen: 1, inUse: null, error: null }), '');
});
```

Acrescentar em `data_broker/tests/test_diagnostics.test.js`. O teste usa os helpers `piece`, `off` e `T` que já existem e o módulo como `S`:

```js
test('Diagnostico: fonte do ultimo pacote e camera do ultimo gestureStatus vencem o auth (NEU-86)', () => {
  const status = {
    now: T,
    pieces: {
      'acquisition-p1': piece({ source: 'bot', meta: { version: 'aaaaaaa', source: 'real' } }),
      'gesture-p1': piece({ camera: 2, meta: { version: 'bbbbbbb', camera: 0 } }),
      'acquisition-p2': off(), 'gesture-p2': { ...off(), connected: true, lastEventAt: T - 1000, meta: { camera: 1 } },
    },
    game: { connections: 0, recentEvents: [] }, connections: {}, redis: { status: 'ready' }, broker: { version: 'c', uptimeSeconds: 60 },
  };
  const all = Object.fromEntries(S.diagnostics({ status }).pcs.flatMap((pc) => pc.pieces).map((p) => [p.key, Object.fromEntries(p.details)]));
  assert.equal(all['acquisition-p1'].fonte, 'bot');
  assert.equal(all['gesture-p1']['câmera'], 'Câmera 3');
  assert.equal(all['gesture-p2']['câmera'], 'Câmera 2', 'sem gestureStatus com camera, vale o auth');
});
```

Em `data_broker/tests/test_ops_screen.test.js`, no primeiro teste (antes do `} finally`):

```js
    // NEU-86: fonte NeuroSky | Bot e camera em cada card.
    for (const slot of [1, 2]) {
      assert.match(res.body, new RegExp(`data-source-btn="${slot}" data-source="neurosky"`));
      assert.match(res.body, new RegExp(`data-source-btn="${slot}" data-source="bot"`));
      assert.match(res.body, new RegExp(`data-camera="${slot}"`));
      assert.match(res.body, new RegExp(`data-setup-msg="${slot}"`));
    }
    assert.match(res.body, /<option value="2">Câmera 3<\/option>/);
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test data_broker/tests/test_ops_state.test.js data_broker/tests/test_diagnostics.test.js data_broker/tests/test_ops_screen.test.js`
Expected: FAIL, `setupLocked is not a function`, `cameraText is not a function`, fonte `real` em vez de `bot` e `data-source-btn` ausente

- [ ] **Step 3: Implementar a lógica (`ops_state.js`)**

Depois de `cardState`:

```js
  // NEU-86 (spec C5): fonte e camera travadas enquanto alguem corre. Mesma janela do
  // broker (RACE_LOCK_MS): uma sessao esquecida de outro dia nao trava para sempre.
  // `pending` fica de fora: registrar a proxima dupla nao destrava a corrida atual.
  function setupLocked({ session, raceEvents, history, now }) {
    if (!session || session.status !== 'active') return false;
    if (!(now - Number(session.startedAt) < RACE_LOCK_MS)) return false;
    return [1, 2].some((slot) => cardState({ slot, session, pending: null, raceEvents, history }) === 'racing');
  }

  // Linha embaixo do seletor de camera: erro da ultima troca ou troca ainda chegando.
  function cameraText({ chosen, inUse, error }) {
    if (error) return String(error);
    const known = (v) => v !== null && v !== undefined;
    if (known(chosen) && known(inUse) && chosen !== inUse) return `trocando para a Câmera ${Number(chosen) + 1}…`;
    return '';
  }
```

Em `diagnostics`, trocar:
- `['fonte', dash(meta.source)]` por `['fonte', dash(p.source ?? meta.source)]`;
- o detalhe de câmera por:

```js
        : [['câmera', (p.camera ?? meta.camera) === undefined || (p.camera ?? meta.camera) === null ? '—' : `Câmera ${Number(p.camera ?? meta.camera) + 1}`], ['mão vista', p.handSeen === null || p.handSeen === undefined ? '—' : p.handSeen ? 'sim' : 'não'], ['última notícia', ago(age)]];
```

Por fim, acrescentar `setupLocked` e `cameraText` no `return { ... }` final.

- [ ] **Step 4: Implementar a tela**

Em `data_broker/public/index.html`, em cada card, logo depois da `<div class="card-head">…</div>` (trocar `N` por `1` e por `2`):

```html
          <div class="setup-row">
            <div class="seg" role="group" aria-label="Fonte do jogador N">
              <button type="button" class="seg-btn" data-source-btn="N" data-source="neurosky" aria-pressed="true">NeuroSky</button>
              <button type="button" class="seg-btn" data-source-btn="N" data-source="bot" aria-pressed="false">Bot</button>
            </div>
            <label class="camera-pick"><span class="label">Câmera</span>
              <select data-camera="N" aria-label="Câmera do jogador N"><option value="0">Câmera 1</option><option value="1">Câmera 2</option><option value="2">Câmera 3</option></select>
            </label>
          </div>
          <div class="setup-msg mono" data-setup-msg="N" hidden></div>
```

Em `data_broker/public/ops.css`, antes de `@media (max-width: 720px)`:

```css
/* Fonte e camera por jogador (NEU-86) */
.setup-row { display: flex; gap: 0.8rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.6rem; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; }
.seg-btn { font: inherit; font-size: 0.8rem; padding: 0.3rem 0.8rem; border: 0; background: transparent; color: var(--fg-muted); cursor: pointer; }
.seg-btn[aria-pressed="true"] { background: var(--fg-strong); color: var(--bg); }
.seg-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.camera-pick { display: inline-flex; gap: 0.4rem; align-items: center; }
.camera-pick select { font: inherit; font-size: 0.8rem; background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 0.4rem; padding: 0.2rem 0.4rem; }
.setup-msg { font-size: 0.75rem; color: var(--warn); margin: -0.2rem 0 0.6rem; }
```

Em `data_broker/public/ops.js`, antes de `// ---------- NEU-142: abas e Diagnostico ----------`:

```js
  // ---------- NEU-86: fonte (NeuroSky | Bot) e camera por jogador ----------
  const setupMsg = { 1: '', 2: '' };
  const setupOf = (slot) => (st.status && st.status.setup && st.status.setup[slot]) || null;
  async function postSetup(path, body) {
    const slot = body.player;
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setupMsg[slot] = res.ok ? '' : res.status === 409 ? 'Corrida em andamento: troque quando ela terminar.' : `Falha ao trocar (${res.status}). Tente de novo.`;
      return res.ok;
    } catch (e) {
      setupMsg[slot] = 'Sem resposta do broker. Ele está de pé?';
      return false;
    } finally { await refresh(); }
  }
  document.querySelectorAll('[data-source-btn]').forEach((btn) => btn.addEventListener('click', () => {
    const slot = Number(btn.dataset.sourceBtn); const cur = setupOf(slot);
    if (btn.disabled || (cur && cur.source === btn.dataset.source)) return;
    postSetup('/api/players/source', { player: slot, source: btn.dataset.source });
  }));
  document.querySelectorAll('[data-camera]').forEach((sel) => sel.addEventListener('change', () => {
    postSetup('/api/players/camera', { player: Number(sel.dataset.camera), camera: Number(sel.value) });
  }));
  function renderSetup() {
    const locked = S.setupLocked({ session: st.session, raceEvents: st.raceEvents, history: st.history, now: Date.now() });
    for (const slot of [1, 2]) {
      const setup = setupOf(slot); const source = setup ? setup.source : null;
      document.querySelectorAll(`[data-source-btn="${slot}"]`).forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.source === source));
        b.disabled = !setup || locked;
        b.title = locked ? 'Travado durante a corrida' : !setup ? 'Sem resposta do broker' : '';
      });
      // Bot desliga o campo de contato (spec B2): nada a cadastrar, nada vai para a nuvem.
      const input = $(`#email${slot}`);
      if (source === 'bot' && !input.disabled) { input.value = ''; input.disabled = true; input.placeholder = 'Bot: não vai para a nuvem'; }
      else if (source !== 'bot' && input.disabled) { input.disabled = false; input.placeholder = 'jogador@exemplo.com'; }
      const piece = st.status && st.status.pieces && st.status.pieces[`gesture-p${slot}`];
      const inUse = piece && piece.connected ? (piece.camera ?? (piece.meta && piece.meta.camera) ?? null) : null;
      const chosen = setup ? setup.camera : null;
      const sel = $(`[data-camera="${slot}"]`);
      sel.disabled = !setup || locked;
      sel.title = locked ? 'Travado durante a corrida' : '';
      // Nao troca o valor enquanto o operador esta com o seletor aberto.
      if (document.activeElement !== sel) sel.value = String(chosen ?? inUse ?? 0);
      const msg = $(`[data-setup-msg="${slot}"]`);
      const text = setupMsg[slot] || S.cameraText({ chosen, inUse, error: piece && piece.cameraError });
      msg.textContent = text; msg.hidden = !text;
    }
  }
```

No handler de clique dos últimos jogadores (`$('[data-recent-list]').addEventListener('click', ...)`):
- o callback passa a ser `async (ev) =>`;
- logo depois do `if (!btn || btn.disabled) return;`:

```js
    // NEU-86 (spec D2): preencher um lado em Bot volta esse lado para NeuroSky.
    const cur = setupOf(Number(btn.dataset.fillSlot));
    if (cur && cur.source === 'bot' && !(await postSetup('/api/players/source', { player: Number(btn.dataset.fillSlot), source: 'neurosky' }))) return;
```

Em `render()`, acrescentar `renderSetup();` logo depois de `renderCards();`.

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test data_broker/tests/test_ops_state.test.js data_broker/tests/test_diagnostics.test.js data_broker/tests/test_ops_screen.test.js`
Expected: PASS

- [ ] **Step 6: Suíte Node e sintaxe do painel**

Run: `node --check data_broker/public/ops.js` e `npm --prefix data_broker run validate`
Expected: sem erro de sintaxe; `fail 0`

- [ ] **Step 7: Commit**

```bash
git add data_broker/public/ops_state.js data_broker/public/index.html data_broker/public/ops.js data_broker/public/ops.css data_broker/tests/test_ops_state.test.js data_broker/tests/test_diagnostics.test.js data_broker/tests/test_ops_screen.test.js
git commit -m "feat(ops): NeuroSky | Bot e camera em cada card, travados durante a corrida [NEU-86]"
```

---

### Task 7: contratos, README e E2E

**Files:**
- Modify: `docs/event-contracts.md`, `README.md`
- E2E: scripts no scratchpad (`fake_gesture.py` atualizado), sem arquivo novo no repo

- [ ] **Step 1: Documentar o contrato**

Em `docs/event-contracts.md`, acrescentar uma seção "Comandos do broker para as peças (NEU-86)":
- `setSource { source: 'neurosky' | 'bot' }` → `acquisition-pN`, na conexão e quando o operador troca;
- `setCamera { camera: 0 | 1 | 2 }` → `gesture-pN`, na conexão (só com escolha guardada) e quando o operador troca;
- `gestureStatus` ganha `camera` (número) e `cameraError` (string ou `null`), os dois opcionais;
- rotas `POST /api/players/source` e `POST /api/players/camera`, com corpo, códigos (200/400/409/415/413) e o `setup` no `GET /api/status`;
- regra B2: o lado em Bot é decidido pelo `players:setup` na largada, nunca pelo `source` do pacote.

No `README.md`, onde descreve os perfis ou o `SOURCE`, acrescentar uma linha:
- o `SOURCE` do env é o rótulo do leitor configurado (modo NeuroSky);
- Bot e NeuroSky são escolhidos no painel, sem recriar container (NEU-86).

- [ ] **Step 2: Commit da documentação**

```bash
git add docs/event-contracts.md README.md
git commit -m "docs: setSource/setCamera, rotas de fonte e camera e regra do bot [NEU-86]"
```

- [ ] **Step 3: Subir o E2E sem nuvem** (bash; **nunca** `down -v`)

```bash
API_URL= EDGE_INGEST_TOKEN= docker compose --profile banca up -d --build redis broker simulator-a simulator-b acquisition-a-sim acquisition-b-sim
curl -s http://127.0.0.1:3000/health
```

Expected: `"dispatcher":{"enabled":false,...}`. Se `enabled` vier `true`, parar com `docker compose --profile banca stop` e investigar antes de qualquer outro passo.

- [ ] **Step 4: Trocar o P1 para Bot e voltar, medindo**

```bash
curl -s http://127.0.0.1:3000/api/status | node -e "const s=JSON.parse(require('fs').readFileSync(0));console.log(s.setup, s.pieces['acquisition-p1'].source)"
date +%s; curl -s -X POST -H 'Content-Type: application/json' -d '{"player":1,"source":"bot"}' http://127.0.0.1:3000/api/players/source
for i in $(seq 1 12); do sleep 1; echo "$i $(curl -s http://127.0.0.1:3000/api/status | node -e "const s=JSON.parse(require('fs').readFileSync(0));console.log(s.pieces['acquisition-p1'].source)")"; done
curl -s -X POST -H 'Content-Type: application/json' -d '{"player":1,"source":"neurosky"}' http://127.0.0.1:3000/api/players/source
# repetir o laco de 12 s
```

Expected:
- `source` do P1 vira `bot` em até 10 s e volta a `real` em até 10 s;
- o P2 não muda;
- `docker compose logs acquisition-a-sim` mostra `eeg_source_switched` e nenhum `broker_connected` novo (o broker não caiu).

O `sleep` do bash pode ser bloqueado no harness. Nesse caso, usar a mesma medição com um script Node no scratchpad que faça o polling.

- [ ] **Step 5: Trocar para Bot com o "ThinkGear" fora**

```bash
docker compose --profile banca stop simulator-a
# esperar o acquisition-a-sim logar eeg_connection_failure
curl -s -X POST -H 'Content-Type: application/json' -d '{"player":1,"source":"bot"}' http://127.0.0.1:3000/api/players/source
# polling de 12 s como no passo 4
docker compose --profile banca start simulator-a
curl -s -X POST -H 'Content-Type: application/json' -d '{"player":1,"source":"neurosky"}' http://127.0.0.1:3000/api/players/source
```

Expected: `source` do P1 = `bot` em até 10 s, mesmo com o simulador parado.

- [ ] **Step 6: Câmera pelo painel com detector falso**

Atualizar `scratchpad/fake_gesture.py`:
- usar `CameraSwitch(0, FakeOpener)`, em que o abridor falso aceita 0 e 1 e recusa 2;
- passar `handlers={"setCamera": set_camera_handler(cameras)}`;
- chamar `apply_pending()` a cada volta do laço;
- mandar `camera` e `cameraError` no `gestureStatus`.

Rodar `$PY scratchpad/fake_gesture.py . 1 http://127.0.0.1:3000` em background e então:

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"player":1,"camera":1}' http://127.0.0.1:3000/api/players/camera
# depois de 3 s: /api/status -> pieces['gesture-p1'].camera == 1, cameraError null
curl -s -X POST -H 'Content-Type: application/json' -d '{"player":1,"camera":2}' http://127.0.0.1:3000/api/players/camera
# depois de 3 s: camera == 1, cameraError == "Câmera 3 não abriu; voltou para a Câmera 2"
```

Expected: como nos comentários. Os punhos do falso continuam chegando (`handGesture` no log do broker).

- [ ] **Step 7: Tela**

Abrir `http://127.0.0.1:3000/` no Playwright e conferir:
- o P1 em Bot aparece com o botão pressionado, o e-mail desabilitado com "Bot: não vai para a nuvem" e o Poor Signal "simulado";
- o seletor de câmera do P1 mostra "Câmera 2" e a mensagem de erro aparece embaixo;
- uma captura de tela fica no scratchpad;
- clicar em P1 nos "Últimos jogadores" (se houver contato) volta o P1 para NeuroSky.

- [ ] **Step 8: Limpar**
- voltar o setup para o padrão: `POST source neurosky` nos dois. A escolha de câmera fica guardada no `players:setup`; apagar só esse hash com `docker compose exec redis redis-cli DEL players:setup`;
- parar o detector falso;
- `docker compose --profile banca stop` (**nunca** `down -v`);
- conferir que a dead-letter continua com 6: `docker compose run --rm redis redis-cli -h redis LLEN dispatch:deadletter`, ou o mesmo com `exec` antes do `stop`.

- [ ] **Step 9: Suítes finais**

Run:
- `$PY -m unittest discover -s tests -p "test_*.py"`;
- `npm --prefix data_broker run validate`;
- integração com Redis descartável na porta 6399 (`REDIS_URL=redis://127.0.0.1:6399 node --test --test-concurrency=1 data_broker/tests/*integration*.test.js`).

Expected: tudo verde, 0 skip na integração.
