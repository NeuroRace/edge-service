import socket
import time

from acquisition_config import AcquisitionConfig
from acquisition_core import build_esense_payload, extract_json_messages, parse_packet


class RecoverableAcquisitionError(Exception):
    pass


def stream_packets(*, client, sio, config: AcquisitionConfig, log):
    buffer = ''

    while True:
        try:
            data = client.recv(config.buffer_size)
        except socket.timeout as exc:
            raise RecoverableAcquisitionError(
                f"Timeout lendo dados da fonte EEG apos {config.eeg_read_timeout_seconds}s."
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

            if 'eSense' not in packet:
                continue

            e_sense_payload = build_esense_payload(
                packet,
                player_id=config.player_id,
                source=config.source,
                threshold=config.poor_signal_level_threshold,
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
