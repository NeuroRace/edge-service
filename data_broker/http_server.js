// data_broker/http_server.js
const http = require('http');

function createHttpServer(session) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'broker' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/players') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
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
        const result = await session.registerPlayers(player1Email, player2Email);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
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
