# broker_client.py
# Cliente do broker para o detector de gesto. NEU-139: se apresenta (auth), nunca
# morre com o broker fora (tenta de novo no maximo a cada 2 s) e manda sinal de vida.
# A tentativa de conexao roda numa thread: com o broker inalcancavel (cabo puxado) o
# connect pode travar segundos, e o loop de video da camera nao pode congelar.
import threading
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


def _spawn_daemon(fn):
    threading.Thread(target=fn, daemon=True).start()


class WebSocketBrokerClient:
    def __init__(self, broker_url: str, player_id: int,
                 client_factory=lambda: socketio.Client(reconnection=False), clock=time.monotonic,
                 spawn=_spawn_daemon):
        """broker_url: ex. 'http://localhost:3000' (central) ou 'http://192.168.50.1:3000' (coletor)."""
        self.broker_url = broker_url
        self.auth = {"role": "gesture", "player": player_id}
        # Reconexao automatica do socketio desligada: quem reconecta e connect_to_broker,
        # para nao haver duas tentativas concorrentes.
        self.sio = client_factory()
        self._clock = clock
        self._spawn = spawn
        self._last_attempt = None
        self._connecting = threading.Event()

    def _try_connect(self):
        try:
            self.sio.connect(self.broker_url, auth=self.auth, wait_timeout=1)
            print(f"Conectado ao Broker em {self.broker_url}.")
        except Exception as e:  # socketio.exceptions.ConnectionError, rede, etc.
            print(f"Broker fora ({self.broker_url}): {e}. Tento de novo em {RECONNECT_INTERVAL_S:.0f} s.")
        finally:
            self._connecting.clear()

    def connect_to_broker(self) -> bool:
        """Nunca bloqueia nem levanta excecao. True so quando ja esta conectado."""
        if self.sio.connected:
            return True
        if self._connecting.is_set():
            return False
        now = self._clock()
        if self._last_attempt is not None and now - self._last_attempt < RECONNECT_INTERVAL_S:
            return False
        self._last_attempt = now
        self._connecting.set()
        self._spawn(self._try_connect)
        return self.sio.connected

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
