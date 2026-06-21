import socket
import socketio
import time
import traceback

from acquisition_clients import close_connections, create_broker_client, create_eeg_client
from acquisition_config import AcquisitionConfig
from acquisition_core import compute_retry_delay_seconds
from acquisition_pipeline import RecoverableAcquisitionError, stream_packets


def should_stop_retrying(attempt: int, config: AcquisitionConfig) -> bool:
    return config.max_reconnect_attempts > 0 and attempt >= config.max_reconnect_attempts


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

    try:
        while True:
            client = None
            sio = None

            try:
                log.info("connecting_eeg_source", attempt=attempt + 1)
                client = create_eeg_client(config)
                log.info("eeg_source_connected", eegHost=config.eeg_host, acqPort=config.acq_port)

                log.info("connecting_broker", attempt=attempt + 1, brokerUrl=config.broker_url)
                sio = create_broker_client(config)
                log.info("broker_connected", brokerUrl=config.broker_url)

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
                    "recoverable_acquisition_failure",
                    error=str(exc),
                    nextRetryDelaySeconds=delay_seconds,
                    attempt=attempt,
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
                    "connection_failure",
                    error=str(exc),
                    nextRetryDelaySeconds=delay_seconds,
                    attempt=attempt,
                )
                time.sleep(delay_seconds)
            finally:
                close_connections(client, sio)

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
        log.info("acquisition_stopped")
