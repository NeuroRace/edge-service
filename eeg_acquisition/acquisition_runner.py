import socket
import socketio
import time
import traceback

from acquisition_clients import close_connections, create_broker_client, create_eeg_client
from acquisition_config import AcquisitionConfig
from acquisition_core import compute_retry_delay_seconds
from acquisition_pipeline import RecoverableAcquisitionError, stream_packets


# NEU-151: de quanto em quanto tempo a peca diz ao broker como esta o EEG. Mesmo
# ritmo do `gestureStatus`, para a faixa do painel reagir dentro dos 10 s do criterio.
EEG_STATUS_INTERVAL_SECONDS = 2
# O erro vai para a tela do operador: corta para nao virar paredao de texto.
MAX_LAST_ERROR_CHARS = 200


def should_stop_retrying(attempt: int, config: AcquisitionConfig) -> bool:
    return config.max_reconnect_attempts > 0 and attempt >= config.max_reconnect_attempts


def eeg_status_payload(config: AcquisitionConfig, eeg: str, last_error=None) -> dict:
    """Corpo do `acquisitionStatus` (NEU-151). `eeg`: 'connected' | 'connecting'."""
    return {
        "player": config.player_id,
        "eeg": eeg,
        "lastError": str(last_error)[:MAX_LAST_ERROR_CHARS] if last_error else None,
    }


def emit_eeg_status(sio, config: AcquisitionConfig, eeg: str, last_error=None) -> None:
    """Sinal de vida do EEG. Nunca derruba a aquisicao: falhar aqui e so nao avisar."""
    if sio is None or not getattr(sio, "connected", False):
        return
    try:
        sio.emit("acquisitionStatus", eeg_status_payload(config, eeg, last_error))
    except Exception:  # noqa: BLE001 - heartbeat e best-effort, por definicao
        pass


def sleep_reporting_status(sio, config: AcquisitionConfig, delay_seconds, last_error, sleep=time.sleep) -> None:
    """Espera entre tentativas de EEG sem ficar muda: avisa a cada EEG_STATUS_INTERVAL_SECONDS.

    Dormir o backoff inteiro de uma vez deixaria o painel sem noticia por ate
    `retry_max_delay_seconds`, e a peca apareceria como 'sem noticia' em vez de
    'ThinkGear fechado'.
    """
    remaining = delay_seconds
    while remaining > 0:
        emit_eeg_status(sio, config, "connecting", last_error)
        step = min(EEG_STATUS_INTERVAL_SECONDS, remaining)
        sleep(step)
        remaining -= step


def connect_broker_with_retry(config: AcquisitionConfig, log, sleep=time.sleep):
    """O broker e a primeira conexao e nao depende do EEG (NEU-151)."""
    attempt = 0
    while True:
        try:
            log.info("connecting_broker", attempt=attempt + 1, brokerUrl=config.broker_url)
            sio = create_broker_client(config)
            log.info("broker_connected", brokerUrl=config.broker_url)
            return sio
        except socketio.exceptions.ConnectionError as exc:
            attempt += 1
            if should_stop_retrying(attempt, config):
                raise
            delay_seconds = compute_retry_delay_seconds(
                attempt,
                base_delay_seconds=config.retry_base_delay_seconds,
                max_delay_seconds=config.retry_max_delay_seconds,
            )
            log.warning(
                "broker_connection_failure",
                error=str(exc),
                nextRetryDelaySeconds=delay_seconds,
                attempt=attempt,
            )
            sleep(delay_seconds)


def run_acquisition_service(config: AcquisitionConfig, log):
    log.info(
        "acquisition_started",
        playerId=config.player_id,
        eegHost=config.eeg_host,
        acqPort=config.acq_port,
        brokerUrl=config.broker_url,
        source=config.source,
    )

    attempt = 0
    sio = None

    try:
        # NEU-151: o broker vem PRIMEIRO e fica de pe pelo resto da vida do processo.
        # Antes o EEG vinha antes, e com o ThinkGear fechado a peca nem chegava a
        # aparecer no /api/status — indistinguivel, para o operador, de container
        # parado. A reconexao do proprio socket.io cuida de quedas do broker.
        sio = connect_broker_with_retry(config, log)

        while True:
            client = None

            try:
                emit_eeg_status(sio, config, "connecting")
                log.info("connecting_eeg_source", attempt=attempt + 1)
                client = create_eeg_client(config)
                log.info("eeg_source_connected", eegHost=config.eeg_host, acqPort=config.acq_port)
                emit_eeg_status(sio, config, "connected")

                attempt = 0
                stream_packets(client=client, sio=sio, config=config, log=log)
            except (RecoverableAcquisitionError, socket.error) as exc:
                attempt += 1
                if should_stop_retrying(attempt, config):
                    raise

                delay_seconds = compute_retry_delay_seconds(
                    attempt,
                    base_delay_seconds=config.retry_base_delay_seconds,
                    max_delay_seconds=config.retry_max_delay_seconds,
                )
                log.warning(
                    "eeg_connection_failure",
                    error=str(exc),
                    nextRetryDelaySeconds=delay_seconds,
                    attempt=attempt,
                )
                # So o cliente do EEG cai aqui; o broker segue conectado, avisando.
                sleep_reporting_status(sio, config, delay_seconds, exc)
            finally:
                if client:
                    client.close()

    except KeyboardInterrupt:
        log.info("acquisition_shutdown_requested")
    except RecoverableAcquisitionError as exc:
        log.critical(
            "acquisition_retries_exhausted",
            error=str(exc),
            maxReconnectAttempts=config.max_reconnect_attempts,
        )
    except socket.error as exc:
        log.critical(
            "eeg_connection_error",
            eegHost=config.eeg_host,
            acqPort=config.acq_port,
            error=str(exc),
        )
    except socketio.exceptions.ConnectionError as exc:
        log.critical(
            "broker_connection_error",
            brokerUrl=config.broker_url,
            error=str(exc),
        )
    except Exception as exc:
        log.critical(
            "unexpected_acquisition_error",
            error=str(exc),
            traceback=traceback.format_exc(),
        )
    finally:
        # O broker agora vive fora do laco (NEU-151), entao e aqui que ele fecha.
        close_connections(None, sio)
        log.info("acquisition_stopped")
