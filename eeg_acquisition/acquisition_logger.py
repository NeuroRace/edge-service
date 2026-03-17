import json
import sys
from datetime import datetime, timezone


class StructuredLogger:
    def __init__(self, service: str):
        self.service = service

    def _log(self, level: str, message: str, **metadata):
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "service": self.service,
            "message": message,
        }
        payload.update(metadata)
        print(json.dumps(payload), file=sys.stdout, flush=True)

    def debug(self, message: str, **metadata):
        self._log("debug", message, **metadata)

    def info(self, message: str, **metadata):
        self._log("info", message, **metadata)

    def warning(self, message: str, **metadata):
        self._log("warning", message, **metadata)

    def critical(self, message: str, **metadata):
        self._log("critical", message, **metadata)
