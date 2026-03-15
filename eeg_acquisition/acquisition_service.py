import os
import socket
import socketio
import time
import logging

from acquisition_core import build_esense_payload, extract_json_messages, parse_packet

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


def start_acquisition_service():
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sio = socketio.Client(logger=True, engineio_logger=False)

    try:
        log.info("Tentando conectar a fonte de EEG...")
        client.connect((HOST, ACQ_PORT))
        log.info("Conectado a fonte de EEG com sucesso.")

        log.info("Enviando handshake para a fonte de EEG...")
        client.sendall(b'{"enableRawOutput": false, "format": "Json"}')

        log.info("Tentando conectar ao Broker...")
        sio.connect(BROKER_URL)
        log.info("Conectado ao Broker com sucesso.")

        buffer = ''
        while True:
            data = client.recv(BUFFER_SIZE)
            if not data:
                log.warning("A fonte de EEG fechou a conexao.")
                break

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

                    sio.emit('eSense', e_sense_payload)
                    log.debug("Pacote eSense enviado para o Broker.")

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
        if client:
            client.close()
        if sio and sio.connected:
            sio.disconnect()
        log.info("Conexoes encerradas.")


if __name__ == '__main__':
    start_acquisition_service()
