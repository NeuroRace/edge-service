import socket
import socketio
import time

from acquisition_clients import close_connections, create_broker_client, create_eeg_client
from acquisition_config import AcquisitionConfig
from acquisition_core import compute_retry_delay_seconds
from acquisition_pipeline import RecoverableAcquisitionError, stream_packets


def should_stop_retrying(attempt: int, config: AcquisitionConfig) -> bool:
    return config.max_reconnect_attempts > 0 and attempt >= config.max_reconnect_attempts


def run_acquisition_service(config: AcquisitionConfig, log):
    log.info(f"Servico de Aquisição para Player {config.player_id} iniciado.")
    log.info(f"Conectando a fonte de EEG em {config.eeg_host}:{config.acq_port}")
    log.info(f"Enviando dados para o Broker em {config.broker_url}")

    attempt = 0

    try:
        while True:
            client = None
            sio = None

            try:
                log.info("Tentando conectar a fonte de EEG...")
                client = create_eeg_client(config)
                log.info("Conectado a fonte de EEG com sucesso.")

                log.info("Tentando conectar ao Broker...")
                sio = create_broker_client(config)
                log.info("Conectado ao Broker com sucesso.")

                attempt = 0
                stream_packets(client=client, sio=sio, config=config, log=log)
            except RecoverableAcquisitionError as exc:
                attempt += 1
                if should_stop_retrying(attempt, config):
                    raise

                delay_seconds = compute_retry_delay_seconds(
                    attempt,
                    base_delay_seconds=config.retry_base_delay_seconds,
                    max_delay_seconds=config.retry_max_delay_seconds,
                )
                log.warning(
                    f"Falha recuperavel no acquisition: {exc}. "
                    f"Nova tentativa em {delay_seconds:.1f}s (tentativa {attempt})."
                )
                time.sleep(delay_seconds)
            except (socket.error, socketio.exceptions.ConnectionError) as exc:
                attempt += 1
                if should_stop_retrying(attempt, config):
                    raise

                delay_seconds = compute_retry_delay_seconds(
                    attempt,
                    base_delay_seconds=config.retry_base_delay_seconds,
                    max_delay_seconds=config.retry_max_delay_seconds,
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
    except socket.error as exc:
        log.critical(
            f"Erro de conexao com a fonte de EEG em {config.eeg_host}:{config.acq_port}. "
            f"Verifique se o simulador ou dispositivo esta rodando. Erro: {exc}"
        )
    except socketio.exceptions.ConnectionError as exc:
        log.critical(
            f"Nao foi possivel conectar ao Broker em {config.broker_url}. "
            f"Verifique se o broker esta rodando. Erro: {exc}"
        )
    except Exception:
        log.critical("Uma excecao nao tratada ocorreu no loop de aquisicao.", exc_info=True)
    finally:
        log.info("Conexoes encerradas.")
