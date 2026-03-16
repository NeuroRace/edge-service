import logging
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class AcquisitionConfig:
    player_id: int
    acq_port: int
    eeg_host: str
    broker_url: str
    source: str
    buffer_size: int
    poor_signal_level_threshold: int
    eeg_connect_timeout_seconds: float
    eeg_read_timeout_seconds: float
    broker_connect_timeout_seconds: float
    retry_base_delay_seconds: float
    retry_max_delay_seconds: float
    max_reconnect_attempts: int


def configure_logging() -> logging.Logger:
    log_format = '%(asctime)s - %(levelname)s - [%(name)s] - %(message)s'
    logging.basicConfig(level=logging.INFO, format=log_format)
    return logging.getLogger(__name__)


def load_config(env: dict[str, str] | None = None) -> AcquisitionConfig:
    source = env or os.environ

    return AcquisitionConfig(
        player_id=int(source.get('PLAYER_ID', '1')),
        acq_port=int(source.get('ACQ_PORT', '13854')),
        eeg_host=source.get('EEG_HOST', '127.0.0.1'),
        broker_url=source.get('BROKER_URL', 'http://broker:3000'),
        source=source.get('SOURCE', 'real'),
        buffer_size=4096,
        poor_signal_level_threshold=int(source.get('POOR_SIGNAL_LEVEL_THRESHOLD', '0')),
        eeg_connect_timeout_seconds=float(source.get('EEG_CONNECT_TIMEOUT_SECONDS', '5')),
        eeg_read_timeout_seconds=float(source.get('EEG_READ_TIMEOUT_SECONDS', '10')),
        broker_connect_timeout_seconds=float(source.get('BROKER_CONNECT_TIMEOUT_SECONDS', '5')),
        retry_base_delay_seconds=float(source.get('ACQ_RETRY_BASE_DELAY_SECONDS', '1')),
        retry_max_delay_seconds=float(source.get('ACQ_RETRY_MAX_DELAY_SECONDS', '10')),
        max_reconnect_attempts=int(source.get('ACQ_MAX_RECONNECT_ATTEMPTS', '0')),
    )
