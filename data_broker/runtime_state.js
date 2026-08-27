function createRuntimeState(startedAt = Date.now(), now = Date.now) {
  let activeConnections = 0;
  let validatedEvents = 0;
  let rejectedEvents = 0;
  // NEU-73: corridas consolidadas e descartadas por falta de e-mail registrado.
  let discardedRaces = 0;
  let lastDiscardedAt = null;
  // D11 / NEU-69: o dispatcher informa seu estado via funcao (nunca muda `status`).
  let dispatcherState = () => ({ enabled: false });

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
    markRaceDiscarded() {
      discardedRaces += 1;
      lastDiscardedAt = now();
    },
    setDispatcherState(fn) {
      dispatcherState = typeof fn === 'function' ? fn : () => fn;
    },
    snapshot() {
      let dispatcher;
      try { dispatcher = dispatcherState(); } catch { dispatcher = { enabled: false, error: 'state_unavailable' }; }
      return {
        status: 'ok',
        service: 'broker',
        uptimeSeconds: Math.floor((now() - startedAt) / 1000),
        connections: activeConnections,
        validatedEvents,
        rejectedEvents,
        discardedRaces,
        lastDiscardedAt,
        dispatcher,
      };
    },
  };
}

module.exports = {
  createRuntimeState,
};
