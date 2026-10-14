import socket
import socketio

from acquisition_config import AcquisitionConfig
from bot_source import BotReader
from code_version import code_version
from source_switch import MODES


def create_eeg_client(config: AcquisitionConfig, switch=None):
    # NEU-86: com o painel em Bot, o leitor e o gerador interno (nao abre socket).
    mode = switch.mode if switch is not None else "neurosky"
    if mode == "bot":
        client = BotReader()
    else:
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(config.eeg_connect_timeout_seconds)
        client.connect((config.eeg_host, config.acq_port))
        client.sendall(b'{"enableRawOutput": false, "format": "Json"}')
        client.settimeout(config.eeg_read_timeout_seconds)
    if switch is not None:
        switch.attach(client, mode)
    return client


def source_handler(switch, log):
    """Handler do `setSource` vindo do broker (roda na thread do socket.io)."""
    def on_set_source(data):
        source = data.get("source") if isinstance(data, dict) else None
        if not isinstance(source, str) or source not in MODES:
            log.warning("set_source_ignored", source=str(source)[:32])
        elif switch.request(source):
            log.info("eeg_source_switch_requested", source=source)
    return on_set_source


def broker_auth(config: AcquisitionConfig):
    # NEU-139/142: o broker reconhece a peca e mostra versao e ThinkGear no Diagnostico.
    return {"role": "acquisition", "player": config.player_id, "version": code_version(),
            "source": config.source, "eegHost": config.eeg_host, "acqPort": config.acq_port}


def create_broker_client(config: AcquisitionConfig, on_set_source=None):
    sio = socketio.Client(
        logger=True,
        engineio_logger=False,
        reconnection=True,
        reconnection_attempts=0,
        reconnection_delay=config.retry_base_delay_seconds,
        reconnection_delay_max=config.retry_max_delay_seconds,
    )
    # NEU-86: antes do connect, porque o broker manda o setSource logo na conexao.
    if on_set_source is not None:
        sio.on("setSource", on_set_source)
    sio.connect(config.broker_url, auth=broker_auth(config), wait_timeout=config.broker_connect_timeout_seconds)
    return sio


def close_connections(client, sio):
    if client:
        client.close()
    if sio and sio.connected:
        sio.disconnect()
