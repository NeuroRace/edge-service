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

function validateEventPayload(event, payload) {
  switch (event) {
    case 'eSense':
      return validateEsensePayload(payload);
    case 'handGesture':
      return validateHandGesturePayload(payload);
    default:
      return null;
  }
}

module.exports = {
  ENFORCED_EVENTS,
  validateEventPayload,
};
