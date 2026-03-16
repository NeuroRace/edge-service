function createBrokerLogger(service = 'broker') {
  return function log(level, message, metadata = {}) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service,
      message,
      ...metadata,
    }));
  };
}

module.exports = {
  createBrokerLogger,
};
