const http = require('http');

const MAX_BODY_BYTES = 4096;

// `getHealthSnapshot` (obrigatorio) alimenta GET /health.
// `session` e `log` sao opcionais: quando `session` esta presente, expoe os
// endpoints de persistencia (POST /api/players, GET /api/session/current).
function createHttpServer(getHealthSnapshot, session, log = () => {}) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getHealthSnapshot()));
      return;
    }

    if (session && req.method === 'GET' && req.url === '/api/session/current') {
      session
        .getCurrentSession()
        .then((data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        })
        .catch((err) => {
          log('error', 'api_session_current_error', { error: err?.message ?? String(err) });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        });
      return;
    }

    if (session && req.method === 'POST' && req.url === '/api/players') {
      let body = '';
      let bodySize = 0;
      let aborted = false;

      req.on('data', (chunk) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload_too_large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });

      req.on('end', async () => {
        if (aborted) return;

        let data;
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_json' }));
          return;
        }

        const player1Email = String(data.player1Email || '');
        const player2Email = String(data.player2Email || '');

        try {
          const result = await session.registerPlayers(player1Email, player2Email);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          log('error', 'api_players_error', { error: err?.message ?? String(err) });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

module.exports = {
  createHttpServer,
};
