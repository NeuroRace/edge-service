import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg_acquisition"))

from acquisition_config import AcquisitionConfig  # noqa: E402
from acquisition_runner import (  # noqa: E402
    MAX_LAST_ERROR_CHARS,
    eeg_status_payload,
    emit_eeg_status,
    should_stop_retrying,
    sleep_reporting_status,
)


def make_config(**over):
    base = dict(
        player_id=1,
        acq_port=13854,
        eeg_host="127.0.0.1",
        broker_url="http://broker:3000",
        source="real",
        buffer_size=4096,
        poor_signal_level_threshold=0,
        eeg_connect_timeout_seconds=5,
        eeg_read_timeout_seconds=10,
        broker_connect_timeout_seconds=5,
        retry_base_delay_seconds=1,
        retry_max_delay_seconds=10,
        max_reconnect_attempts=0,
    )
    base.update(over)
    return AcquisitionConfig(**base)


class FakeSio:
    """Dublê do cliente socket.io: guarda o que foi emitido."""

    def __init__(self, connected=True, raises=False):
        self.connected = connected
        self.raises = raises
        self.emitted = []

    def emit(self, event, payload):
        if self.raises:
            raise RuntimeError("socket caiu no meio do emit")
        self.emitted.append((event, payload))


class RetryPolicyTests(unittest.TestCase):
    def test_stops_when_max_reconnect_attempts_is_reached(self):
        config = AcquisitionConfig(
            player_id=1,
            acq_port=13854,
            eeg_host="127.0.0.1",
            broker_url="http://broker:3000",
            source="real",
            buffer_size=4096,
            poor_signal_level_threshold=0,
            eeg_connect_timeout_seconds=5,
            eeg_read_timeout_seconds=10,
            broker_connect_timeout_seconds=5,
            retry_base_delay_seconds=1,
            retry_max_delay_seconds=10,
            max_reconnect_attempts=3,
        )

        self.assertFalse(should_stop_retrying(2, config))
        self.assertTrue(should_stop_retrying(3, config))

    def test_keeps_retrying_when_limit_is_zero(self):
        config = AcquisitionConfig(
            player_id=1,
            acq_port=13854,
            eeg_host="127.0.0.1",
            broker_url="http://broker:3000",
            source="real",
            buffer_size=4096,
            poor_signal_level_threshold=0,
            eeg_connect_timeout_seconds=5,
            eeg_read_timeout_seconds=10,
            broker_connect_timeout_seconds=5,
            retry_base_delay_seconds=1,
            retry_max_delay_seconds=10,
            max_reconnect_attempts=0,
        )

        self.assertFalse(should_stop_retrying(999, config))


# NEU-151: a peca fica conectada ao broker quando o EEG cai e avisa o estado do EEG,
# para o painel dizer "abra o ThinkGear" em vez de "suba as pecas".
class EegStatusPayloadTests(unittest.TestCase):
    def test_carries_player_and_state(self):
        self.assertEqual(
            eeg_status_payload(make_config(player_id=2), "connected"),
            {"player": 2, "eeg": "connected", "lastError": None},
        )

    def test_error_is_stringified_and_capped(self):
        payload = eeg_status_payload(make_config(), "connecting", OSError("x" * 500))
        self.assertEqual(len(payload["lastError"]), MAX_LAST_ERROR_CHARS)

    def test_no_error_is_null_not_empty_string(self):
        # O painel mostra '—' para null; string vazia viraria uma linha em branco.
        self.assertIsNone(eeg_status_payload(make_config(), "connecting", "")["lastError"])


class EmitEegStatusTests(unittest.TestCase):
    def test_emits_when_connected(self):
        sio = FakeSio()
        emit_eeg_status(sio, make_config(), "connected")
        self.assertEqual(sio.emitted, [("acquisitionStatus", {"player": 1, "eeg": "connected", "lastError": None})])

    def test_silent_when_broker_is_absent_or_down(self):
        emit_eeg_status(None, make_config(), "connecting")  # nao levanta
        sio = FakeSio(connected=False)
        emit_eeg_status(sio, make_config(), "connecting")
        self.assertEqual(sio.emitted, [])

    def test_emit_failure_never_breaks_acquisition(self):
        # O sinal de vida e best-effort: perder um aviso nao pode derrubar a captura.
        emit_eeg_status(FakeSio(raises=True), make_config(), "connecting")


class SleepReportingStatusTests(unittest.TestCase):
    def test_reports_every_two_seconds_instead_of_going_quiet(self):
        sio = FakeSio()
        slept = []
        sleep_reporting_status(sio, make_config(), 6, OSError("recusado"), sleep=slept.append)

        self.assertEqual(slept, [2, 2, 2])
        self.assertEqual(len(sio.emitted), 3)
        for event, payload in sio.emitted:
            self.assertEqual(event, "acquisitionStatus")
            self.assertEqual(payload["eeg"], "connecting")
            self.assertEqual(payload["lastError"], "recusado")

    def test_last_slice_is_shorter_than_the_interval(self):
        slept = []
        sleep_reporting_status(FakeSio(), make_config(), 5, None, sleep=slept.append)
        self.assertEqual(slept, [2, 2, 1])

    def test_zero_delay_does_not_sleep(self):
        slept = []
        sleep_reporting_status(FakeSio(), make_config(), 0, None, sleep=slept.append)
        self.assertEqual(slept, [])


if __name__ == "__main__":
    unittest.main()
