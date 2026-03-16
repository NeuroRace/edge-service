import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg_acquisition"))

from acquisition_config import AcquisitionConfig  # noqa: E402
from acquisition_runner import should_stop_retrying  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
