import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg_acquisition"))

from acquisition_logger import StructuredLogger  # noqa: E402


class StructuredLoggerTests(unittest.TestCase):
    def _emit(self, call):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            call()
        line = buffer.getvalue().strip()
        return json.loads(line)

    def test_emits_required_fields_as_json(self):
        logger = StructuredLogger("acquisition")
        record = self._emit(lambda: logger.info("acquisition_started", attempt=1))

        self.assertEqual(record["level"], "info")
        self.assertEqual(record["service"], "acquisition")
        self.assertEqual(record["message"], "acquisition_started")
        self.assertEqual(record["attempt"], 1)
        self.assertIn("timestamp", record)

    def test_supports_error_level(self):
        logger = StructuredLogger("acquisition")
        record = self._emit(lambda: logger.error("connection_failure", error="boom"))

        self.assertEqual(record["level"], "error")
        self.assertEqual(record["error"], "boom")

    def test_metadata_can_carry_traceback(self):
        logger = StructuredLogger("acquisition")
        record = self._emit(
            lambda: logger.critical(
                "unexpected_acquisition_error",
                error="x",
                traceback="Traceback (most recent call last): ...",
            )
        )

        self.assertEqual(record["level"], "critical")
        self.assertEqual(record["traceback"], "Traceback (most recent call last): ...")


if __name__ == "__main__":
    unittest.main()
