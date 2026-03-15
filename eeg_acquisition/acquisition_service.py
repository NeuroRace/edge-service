import os
import socket
import socketio
import time
import logging

from acquisition_core import (
    build_esense_payload,
    compute_retry_delay_seconds,
    extract_json_messages,
    parse_packet,
)

# ==============================================================================
# SECAO DE CONFIGURACAO DO LOGGING
# ==============================================================================
log_format = '%(asctime)s - %(levelname)s - [%(name)s] - %(message)s'
logging.basicConfig(level=logging.INFO, format=log_format)
log = logging.getLogger(__name__)

# ==============================================================================
# SECAO DE CONFIGURACAO DO SERVICO
# ==============================================================================
PLAYER_ID = int(os.getenv('PLAYER_ID', '1'))
ACQ_PORT = int(os.getenv('ACQ_PORT', '13854'))
HOST = os.getenv('EEG_HOST', '127.0.0.1')
BROKER_URL = os.getenv('BROKER_URL', 'http://broker:3000')
SOURCE = os.getenv('SOURCE', 'real')

log.info(f"Servico de Aquisição para Player {PLAYER_ID} iniciado.")
log.info(f"Conectando a fonte de EEG em {HOST}:{ACQ_PORT}")
log.info(f"Enviando dados para o Broker em {BROKER_URL}")

BUFFER_SIZE = 4096
POOR_SIGNAL_LEVEL_THRESHOLD = int(os.getenv('POOR_SIGNAL_LEVEL_THRESHOLD', '0'))
EEG_CONNECT_TIMEOUT_SECONDS = float(os.getenv('EEG_CONNECT_TIMEOUT_SECONDS', '5'))
EEG_READ_TIMEOUT_SECONDS = float(os.getenv('EEG_READ_TIMEOUT_SECONDS', '10'))
BROKER_CONNECT_TIMEOUT_SECONDS = float(os.getenv('BROKER_CONNECT_TIMEOUT_SECONDS', '5'))
RETRY_BASE_DELAY_SECONDS = float(os.getenv('ACQ_RETRY_BASE_DELAY_SECONDS', '1'))
RETRY_MAX_DELAY_SECONDS = float(os.getenv('ACQ_RETRY_MAX_DELAY_SECONDS', '10'))
MAX_RECONNECT_ATTEMPTS = int(os.getenv('ACQ_MAX_RECONNECT_ATTEMPTS', '0'))


class RecoverableAcquisitionError(Exception):
    pass


def create_eeg_client():
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.settimeout(EEG_CONNECT_TIMEOUT_SECONDS)
    client.connect((HOST, ACQ_PORT))
    client.sendall(b'{"enableRawOutput": false, "format": "Json"}')
    client.settimeout(EEG_READ_TIMEOUT_SECONDS)
    return client


def create_broker_client():
    sio = socketio.Client(
        logger=True,
        engineio_logger=False,
        reconnection=True,
        reconnection_attempts=0,
        reconnection_delay=RETRY_BASE_DELAY_SECONDS,
        reconnection_delay_max=RETRY_MAX_DELAY_SECONDS,
    )
    sio.connect(BROKER_URL, wait_timeout=BROKER_CONNECT_TIMEOUT_SECONDS)
    return sio


def close_connections(client, sio):
    if client:
        client.close()
    if sio and sio.connected:
        sio.disconnect()


def should_stop_retrying(attempt: int) -> bool:
    return MAX_RECONNECT_ATTEMPTS > 0 and attempt >= MAX_RECONNECT_ATTEMPTS


def stream_packets(client, sio):
    buffer = ''

    while True:
        try:
            data = client.recv(BUFFER_SIZE)
        except socket.timeout as exc:
            raise RecoverableAcquisitionError(
                f"Timeout lendo dados da fonte EEG apos {EEG_READ_TIMEOUT_SECONDS}s."
            ) from exc

        if not data:
            raise RecoverableAcquisitionError("A fonte de EEG fechou a conexao.")

        buffer += data.decode('utf-8')
        raw_messages, buffer = extract_json_messages(buffer)

        for raw in raw_messages:
            packet = parse_packet(raw)
            if packet is None:
                log.warning(f"Falha ao decodificar JSON. Dados brutos: '{raw}'")
                continue

            log.debug(f"Pacote de dados recebido: {packet}")
            now_ms = int(time.time() * 1000)

            if 'eSense' in packet:
                e_sense_payload = build_esense_payload(
                    packet,
                    player_id=PLAYER_ID,
                    source=SOURCE,
                    threshold=POOR_SIGNAL_LEVEL_THRESHOLD,
                    now_ms=now_ms,
                )

                if e_sense_payload is None:
                    log.warning(f"Pacote eSense incompleto recebido: {packet}")
                    continue

                if not sio.connected:
                    raise RecoverableAcquisitionError(
                        "Conexao com broker indisponivel durante envio."
                    )

                sio.emit('eSense', e_sense_payload)
                log.debug("Pacote eSense enviado para o Broker.")


def start_acquisition_service():
    attempt = 0

    try:
        while True:
            client = None
            sio = None

            try:
                log.info("Tentando conectar a fonte de EEG...")
                client = create_eeg_client()
                log.info("Conectado a fonte de EEG com sucesso.")

                log.info("Tentando conectar ao Broker...")
                sio = create_broker_client()
                log.info("Conectado ao Broker com sucesso.")

                attempt = 0
                stream_packets(client, sio)
            except RecoverableAcquisitionError as exc:
                attempt += 1
                if should_stop_retrying(attempt):
                    raise

                delay_seconds = compute_retry_delay_seconds(
                    attempt,
                    base_delay_seconds=RETRY_BASE_DELAY_SECONDS,
                    max_delay_seconds=RETRY_MAX_DELAY_SECONDS,
                )
                log.warning(
                    f"Falha recuperavel no acquisition: {exc}. "
                    f"Nova tentativa em {delay_seconds:.1f}s (tentativa {attempt})."
                )
                time.sleep(delay_seconds)
            except (socket.error, socketio.exceptions.ConnectionError) as exc:
                attempt += 1
                if should_stop_retrying(attempt):
                    raise

                delay_seconds = compute_retry_delay_seconds(
                    attempt,
                    base_delay_seconds=RETRY_BASE_DELAY_SECONDS,
                    max_delay_seconds=RETRY_MAX_DELAY_SECONDS,
                )
                log.warning(
                    f"Erro de conexao no acquisition: {exc}. "
                    f"Nova tentativa em {delay_seconds:.1f}s (tentativa {attempt})."
                )
                time.sleep(delay_seconds)
            finally:
                close_connections(client, sio)

    except KeyboardInterrupt:
        log.info("Encerrando servico de aquisicao por solicitacao do usuario.")
    except socket.error as e:
        log.critical(
            f"Erro de conexao com a fonte de EEG em {HOST}:{ACQ_PORT}. "
            f"Verifique se o simulador ou dispositivo esta rodando. Erro: {e}"
        )
    except socketio.exceptions.ConnectionError as e:
        log.critical(
            f"Nao foi possivel conectar ao Broker em {BROKER_URL}. "
            f"Verifique se o broker esta rodando. Erro: {e}"
        )
    except Exception:
        log.critical("Uma excecao nao tratada ocorreu no loop de aquisicao.", exc_info=True)
    finally:
        log.info("Conexoes encerradas.")


if __name__ == '__main__':
    start_acquisition_service()
