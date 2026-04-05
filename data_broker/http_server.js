// data_broker/http_server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

function createHttpServer(session) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'broker' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      const dashboardPath = path.join(__dirname, 'dashboard.html');
      fs.readFile(dashboardPath, 'utf-8', (err, html) => {
        if (err) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'dashboard_not_found' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdn.socket.io 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        });
        res.end(html);
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/session/current') {
      if (!session) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_not_configured' }));
        return;
      }
      session.getCurrentSession()
        .then((data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        })
        .catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/players') {
      if (!session) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_not_configured' }));
        return;
      }

      let body = '';
      let bodySize = 0;
      const MAX_BODY_BYTES = 4096;
      req.on('data', (chunk) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload_too_large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', async () => {
        if (bodySize > MAX_BODY_BYTES) return;
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
