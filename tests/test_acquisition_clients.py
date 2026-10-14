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
