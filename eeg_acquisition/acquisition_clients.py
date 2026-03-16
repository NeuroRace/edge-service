import socket
import socketio

from acquisition_config import AcquisitionConfig


def create_eeg_client(config: AcquisitionConfig):
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.settimeout(config.eeg_connect_timeout_seconds)
    client.connect((config.eeg_host, config.acq_port))
    client.sendall(b'{"enableRawOutput": false, "format": "Json"}')
    client.settimeout(config.eeg_read_timeout_seconds)
    return client


def create_broker_client(config: AcquisitionConfig):
    sio = socketio.Client(
        logger=True,
        engineio_logger=False,
        reconnection=True,
        reconnection_attempts=0,
        reconnection_delay=config.retry_base_delay_seconds,
        reconnection_delay_max=config.retry_max_delay_seconds,
    )
    sio.connect(config.broker_url, wait_timeout=config.broker_connect_timeout_seconds)
    return sio


def close_connections(client, sio):
    if client:
        client.close()
    if sio and sio.connected:
        sio.disconnect()
