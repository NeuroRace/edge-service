const ENFORCED_EVENTS = new Set(['eSense', 'handGesture']);
const ALLOWED_STATUS = new Set(['ok', 'poor', 'no-signal', 'unknown']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateEsensePayload(payload) {
  if (!isPlainObject(payload)) {
    return 'payload_must_be_object';
  }
  if (!isFiniteNumber(payload.player)) {
    return 'player_must_be_number';
  }
  if (!isFiniteNumber(payload.attention)) {
    return 'attention_must_be_number';
  }
  if (!isFiniteNumber(payload.meditation)) {
    return 'meditation_must_be_number';
  }
  if (!isPlainObject(payload.eegPower)) {
    return 'eegPower_must_be_object';
  }
  if (
    payload.poorSignalLevel !== null &&
    payload.poorSignalLevel !== undefined &&
    !isFiniteNumber(payload.poorSignalLevel)
  ) {
    return 'poorSignalLevel_must_be_number_or_null';
  }
  if (typeof payload.source !== 'string' || payload.source.length === 0) {
    return 'source_must_be_non_empty_string';
  }
  if (!isFiniteNumber(payload.timeStamp)) {
    return 'timeStamp_must_be_number';
  }
  if (typeof payload.status !== 'string' || !ALLOWED_STATUS.has(payload.status)) {
    return 'status_must_be_known_value';
  }

  return null;
}

function validateHandGesturePayload(payload) {
  if (!isPlainObject(payload)) {
    return 'payload_must_be_object';
  }
  if (!isFiniteNumber(payload.player)) {
    return 'player_must_be_number';
  }
  if (!isFiniteNumber(payload.timeStamp)) {
    return 'timeStamp_must_be_number';
  }

  return null;
}

// NEU-139: sinal de vida do detector de gesto (a cada 2 s). So alimenta a presenca.
function validateGestureStatusPayload(payload) {
  if (!isPlainObject(payload)) return 'payload_must_be_object';
  if (!isFiniteNumber(payload.player)) return 'player_must_be_number';
  if (typeof payload.handSeen !== 'boolean') return 'handSeen_must_be_boolean';
  // NEU-86: camera em uso e erro da ultima troca (opcionais: detector antigo nao manda).
  if (payload.camera !== undefined && !isFiniteNumber(payload.camera)) return 'camera_must_be_number';
  const camErr = payload.cameraError;
  if (camErr !== undefined && camErr !== null && typeof camErr !== 'string') return 'cameraError_must_be_string_or_null';
  return null;
}

// NEU-151: estado do EEG da acquisition (a cada 2 s). A peca segue conectada ao
// broker quando o ThinkGear ou o fone caem, e e este evento que diz qual dos dois e.
const EEG_STATES = new Set(['connected', 'connecting']);

function validateAcquisitionStatusPayload(payload) {
  if (!isPlainObject(payload)) return 'payload_must_be_object';
  if (!isFiniteNumber(payload.player)) return 'player_must_be_number';
  if (!EEG_STATES.has(payload.eeg)) return 'eeg_must_be_connected_or_connecting';
  const err = payload.lastError;
  if (err !== null && err !== undefined && typeof err !== 'string') return 'lastError_must_be_string_or_null';
  return null;
}

function validateEventPayload(event, payload) {
  switch (event) {
    case 'eSense':
      return validateEsensePayload(payload);
    case 'handGesture':
      return validateHandGesturePayload(payload);
    case 'gestureStatus':
      return validateGestureStatusPayload(payload);
    case 'acquisitionStatus':
      return validateAcquisitionStatusPayload(payload);
    default:
      return null;
  }
}

module.exports = {
  ENFORCED_EVENTS,
  validateEventPayload,
};
