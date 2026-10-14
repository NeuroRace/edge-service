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
