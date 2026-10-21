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

    def test_wake_is_set_inside_the_lock(self):
        # Fora da trava, um take_switched entre marcar a troca e o set deixava o evento
        # ligado sem troca pendente, e o backoff seguinte do EEG sumia (revisao do PR #31).
        sw = SourceSwitch()
        seen = []

        class Probe(threading.Event):
            def set(self):
                seen.append(sw._lock.locked())
                super().set()

        sw._wake = Probe()
        sw.request("bot")
        self.assertEqual(seen, [True])

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
