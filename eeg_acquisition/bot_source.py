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
