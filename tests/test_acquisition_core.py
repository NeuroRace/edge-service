import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg_acquisition"))

from acquisition_core import (  # noqa: E402
    build_esense_payload,
    extract_json_messages,
    parse_packet,
    signal_status,
)


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


if __name__ == "__main__":
    unittest.main()
