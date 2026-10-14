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
