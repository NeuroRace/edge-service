import socket
import socketio

from acquisition_config import AcquisitionConfig
from code_version import code_version


def create_eeg_client(config: AcquisitionConfig):
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.settimeout(config.eeg_connect_timeout_seconds)
    client.connect((config.eeg_host, config.acq_port))
    client.sendall(b'{"enableRawOutput": false, "format": "Json"}')
    client.settimeout(config.eeg_read_timeout_seconds)
    return client


def broker_auth(config: AcquisitionConfig):
    # NEU-139/142: o broker reconhece a peca e mostra versao e ThinkGear no Diagnostico.
    return {"role": "acquisition", "player": config.player_id, "version": code_version(),
            "source": config.source, "eegHost": config.eeg_host, "acqPort": config.acq_port}


def create_broker_client(config: AcquisitionConfig):
    sio = socketio.Client(
        logger=True,
        engineio_logger=False,
        reconnection=True,
        reconnection_attempts=0,
        reconnection_delay=config.retry_base_delay_seconds,
        reconnection_delay_max=config.retry_max_delay_seconds,
    )
    sio.connect(config.broker_url, auth=broker_auth(config), wait_timeout=config.broker_connect_timeout_seconds)
    return sio


def close_connections(client, sio):
    if client:
        client.close()
    if sio and sio.connected:
        sio.disconnect()
