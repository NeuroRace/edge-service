function createRuntimeState(startedAt = Date.now()) {
  let activeConnections = 0;
  let validatedEvents = 0;
  let rejectedEvents = 0;

  return {
    markClientConnected() {
      activeConnections += 1;
    },
    markClientDisconnected() {
      activeConnections = Math.max(0, activeConnections - 1);
    },
    markEventValidated() {
      validatedEvents += 1;
    },
    markEventRejected() {
      rejectedEvents += 1;
    },
    snapshot() {
      return {
        status: 'ok',
        service: 'broker',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        connections: activeConnections,
        validatedEvents,
        rejectedEvents,
      };
    },
  };
}

module.exports = {
  createRuntimeState,
};
