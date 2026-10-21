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
