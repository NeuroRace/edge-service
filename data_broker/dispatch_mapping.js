// data_broker/dispatch_mapping.js
// Funcao pura: traduz o registro interno (camelCase) produzido pelo
// session_manager para o body canonico (snake_case) da Edge Function ingest-race.
// Ver docs/cloud-sync-contract.md §6 e o spec do dispatcher §3.

const SCHEMA_VERSION = '1.0';

function toCanonicalBody(record) {
  const { payload } = record;
  return {
    schema_version: SCHEMA_VERSION,
    idempotency_key: record.jobId,
    race_id: record.sessionId,
    player_slot: record.playerId,
    player_email: payload.email,
    player_uuid: payload.playerUuid ?? null,
    source: 'real',
    started_at: payload.startedAt,
    finished_at: payload.finishedAt,
    telemetry_points: payload.packets.map((p) => ({
      t: p.timeStamp,
      attention: p.attention,
      meditation: p.meditation,
      poor_signal_level: p.poorSignalLevel ?? null,
      signal_status: p.status,
      eeg_power: p.eegPower,
    })),
  };
}

module.exports = { toCanonicalBody, SCHEMA_VERSION };
