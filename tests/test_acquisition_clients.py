import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg_acquisition"))

import acquisition_clients  # noqa: E402
from acquisition_config import AcquisitionConfig  # noqa: E402
from bot_source import BotReader  # noqa: E402
from source_switch import SourceSwitch  # noqa: E402


def make_config(player_id=2):
    return AcquisitionConfig(
        player_id=player_id, acq_port=13854, eeg_host="127.0.0.1", broker_url="http://broker:3000",
        source="real", buffer_size=4096, poor_signal_level_threshold=0, eeg_connect_timeout_seconds=5,
        eeg_read_timeout_seconds=10, broker_connect_timeout_seconds=5, retry_base_delay_seconds=1,
        retry_max_delay_seconds=10, max_reconnect_attempts=0,
    )


class BrokerAuthTests(unittest.TestCase):
    def test_broker_auth_identifies_acquisition_player_and_metadata(self):
        auth = acquisition_clients.broker_auth(make_config(2))
        self.assertEqual({k: auth[k] for k in ("role", "player", "source", "eegHost", "acqPort")},
                         {"role": "acquisition", "player": 2, "source": "real", "eegHost": "127.0.0.1", "acqPort": 13854})
        self.assertRegex(auth["version"], r"^[0-9a-f]{7}$")

    def test_create_broker_client_sends_auth_on_connect(self):
        with mock.patch.object(acquisition_clients.socketio, "Client") as client_cls:
            acquisition_clients.create_broker_client(make_config(1))
        _, kwargs = client_cls.return_value.connect.call_args
        self.assertEqual((kwargs["auth"]["role"], kwargs["auth"]["player"]), ("acquisition", 1))


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


if __name__ == "__main__":
    unittest.main()
