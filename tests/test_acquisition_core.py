import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg_acquisition"))

from acquisition_core import (  # noqa: E402
    build_esense_payload,
    compute_retry_delay_seconds,
    extract_json_messages,
    parse_packet,
    signal_status,
)
from acquisition_config import load_config  # noqa: E402


class SignalStatusTests(unittest.TestCase):
    def test_returns_unknown_when_signal_missing(self):
        self.assertEqual(signal_status(None, 0), "unknown")

    def test_returns_no_signal_for_disconnected_threshold(self):
        self.assertEqual(signal_status(200, 0), "no-signal")

    def test_returns_ok_when_signal_is_within_threshold(self):
        self.assertEqual(signal_status(0, 0), "ok")

    def test_returns_poor_when_signal_exceeds_threshold(self):
        self.assertEqual(signal_status(50, 0), "poor")


class MessageParsingTests(unittest.TestCase):
    def test_extracts_complete_messages_and_keeps_partial_tail(self):
        messages, remainder = extract_json_messages(
            '{"a": 1}\r {"b": 2}\r{"partial":'
        )

        self.assertEqual(messages, ['{"a": 1}', '{"b": 2}'])
        self.assertEqual(remainder, '{"partial":')

    def test_parse_packet_returns_none_for_invalid_json(self):
        self.assertIsNone(parse_packet('{"broken":'))

    def test_parse_packet_returns_dict_for_valid_json(self):
        self.assertEqual(parse_packet('{"player": 1}'), {"player": 1})


class EsensePayloadTests(unittest.TestCase):
    def test_builds_payload_with_expected_contract(self):
        payload = build_esense_payload(
            {
                "poorSignalLevel": 0,
                "eSense": {"attention": 88, "meditation": 42},
                "eegPower": {"delta": 123},
            },
            player_id=2,
            source="bot",
            threshold=0,
            now_ms=123456,
        )

        self.assertEqual(
            payload,
            {
                "player": 2,
                "attention": 88,
                "meditation": 42,
                "eegPower": {"delta": 123},
                "poorSignalLevel": 0,
                "status": "ok",
                "source": "bot",
                "timeStamp": 123456,
            },
        )

    def test_returns_none_when_esense_contract_is_incomplete(self):
        payload = build_esense_payload(
            {"poorSignalLevel": 1},
            player_id=1,
            source="real",
            threshold=0,
            now_ms=999,
        )

        self.assertIsNone(payload)

    def test_returns_none_when_required_esense_fields_are_missing(self):
        payload = build_esense_payload(
            {
                "poorSignalLevel": 1,
                "eSense": {"attention": 10},
                "eegPower": {"delta": 99},
            },
            player_id=1,
            source="real",
            threshold=0,
            now_ms=999,
        )

        self.assertIsNone(payload)


class RetryDelayTests(unittest.TestCase):
    def test_returns_zero_when_attempt_is_not_positive(self):
        self.assertEqual(
            compute_retry_delay_seconds(
                0,
                base_delay_seconds=1,
                max_delay_seconds=10,
            ),
            0.0,
        )

    def test_applies_exponential_backoff(self):
        self.assertEqual(
            compute_retry_delay_seconds(
                3,
                base_delay_seconds=1,
                max_delay_seconds=10,
            ),
            4.0,
        )

    def test_caps_retry_delay_at_maximum(self):
        self.assertEqual(
            compute_retry_delay_seconds(
                10,
                base_delay_seconds=1,
                max_delay_seconds=5,
            ),
            5,
        )


class ConfigTests(unittest.TestCase):
    def test_load_config_reads_expected_runtime_keys(self):
        config = load_config(
            {
                "PLAYER_ID": "2",
                "ACQ_PORT": "13855",
                "EEG_HOST": "simulator-b",
                "BROKER_URL": "http://broker:3000",
                "SOURCE": "bot",
                "POOR_SIGNAL_LEVEL_THRESHOLD": "5",
                "EEG_CONNECT_TIMEOUT_SECONDS": "3",
                "EEG_READ_TIMEOUT_SECONDS": "7",
                "BROKER_CONNECT_TIMEOUT_SECONDS": "4",
                "ACQ_RETRY_BASE_DELAY_SECONDS": "2",
                "ACQ_RETRY_MAX_DELAY_SECONDS": "12",
                "ACQ_MAX_RECONNECT_ATTEMPTS": "8",
            }
        )

        self.assertEqual(config.player_id, 2)
        self.assertEqual(config.acq_port, 13855)
        self.assertEqual(config.eeg_host, "simulator-b")
        self.assertEqual(config.broker_url, "http://broker:3000")
        self.assertEqual(config.source, "bot")
        self.assertEqual(config.poor_signal_level_threshold, 5)
        self.assertEqual(config.eeg_connect_timeout_seconds, 3)
        self.assertEqual(config.eeg_read_timeout_seconds, 7)
        self.assertEqual(config.broker_connect_timeout_seconds, 4)
        self.assertEqual(config.retry_base_delay_seconds, 2)
        self.assertEqual(config.retry_max_delay_seconds, 12)
        self.assertEqual(config.max_reconnect_attempts, 8)


if __name__ == "__main__":
    unittest.main()
