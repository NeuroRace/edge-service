import json
from typing import Any


def signal_status(psl: int | None, threshold: int) -> str:
    if psl is None:
        return "unknown"
    if psl >= 200:
        return "no-signal"
    return "ok" if psl <= threshold else "poor"


def extract_json_messages(buffer: str) -> tuple[list[str], str]:
    messages: list[str] = []

    while "\r" in buffer:
        raw, buffer = buffer.split("\r", 1)
        raw = raw.strip()
        if raw:
            messages.append(raw)

    return messages, buffer


def parse_packet(raw: str) -> dict[str, Any] | None:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def build_esense_payload(
    packet: dict[str, Any],
    *,
    player_id: int,
    source: str,
    threshold: int,
    now_ms: int,
) -> dict[str, Any] | None:
    e_sense = packet.get("eSense")
    eeg_power = packet.get("eegPower")

    if not isinstance(e_sense, dict) or eeg_power is None:
        return None

    psl = packet.get("poorSignalLevel")

    return {
        "player": player_id,
        "attention": e_sense["attention"],
        "meditation": e_sense["meditation"],
        "eegPower": eeg_power,
        "poorSignalLevel": psl,
        "status": signal_status(psl, threshold),
        "source": source,
        "timeStamp": now_ms,
    }
