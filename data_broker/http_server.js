const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_BODY_BYTES = 4096;

// Tela de operacao (NEU-68): arquivos estaticos por ALLOWLIST (nunca resolve caminho do
// request no disco -> sem path traversal). Servidos com CSP estrita, same-origin.
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/ops.js': ['ops.js', 'application/javascript; charset=utf-8'],
  '/ops_state.js': ['ops_state.js', 'application/javascript; charset=utf-8'],
  '/ops.css': ['ops.css', 'text/css; charset=utf-8'],
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const REQUEUE_STATUS = { not_found: 404, not_retryable: 409 };

// POST /api/dispatch/requeue (NEU-143). Exige Content-Type JSON: um formulario de outra
// pagina aberta no navegador do operador nao consegue mandar isso sem preflight de CORS,
// que o broker nao responde. Sem isso, qualquer site poderia disparar reenvios (CSRF).
function isJsonRequest(req) {
  return String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
}

function handleRequeue(req, res, dispatchAdmin, log) {
  if (!isJsonRequest(req)) {
    sendJson(res, 415, { error: 'unsupported_media_type' });
    req.resume();
    return;
  }
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { error: 'payload_too_large' });
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (aborted) return;
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'invalid_json' }); return; }
    const jobId = data && data.jobId;
    if (typeof jobId !== 'string' || jobId === '' || jobId.length > 200) {
      sendJson(res, 400, { error: 'invalid_job_id' });
      return;
    }
    try {
      const result = await dispatchAdmin.requeue(jobId);
      sendJson(res, result.ok ? 200 : REQUEUE_STATUS[result.error] || 500, result);
    } catch (err) {
      log('error', 'api_dispatch_requeue_error', { jobId, error: err?.message ?? String(err) });
      sendJson(res, 500, { error: 'internal_error' });
    }
  });
}

const SETUP_STATUS = { invalid_player: 400, invalid_source: 400, invalid_camera: 400, race_in_progress: 409 };

const SESSION_STATUS = { invalid_player: 400, invalid_email: 400, no_active_session: 409, not_missing: 409, already_finished: 409 };

// NEU-86: POST /api/players/source e /api/players/camera; NEU-140: /api/session/link e /stop.
// JSON obrigatorio (CSRF, como o requeue). `statusMap` traduz o `error` do resultado em HTTP.
function handleJsonPost(req, res, log, apply, statusMap, errorTag) {
  if (!isJsonRequest(req)) {
    sendJson(res, 415, { error: 'unsupported_media_type' });
    req.resume();
    return;
  }
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { error: 'payload_too_large' });
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (aborted) return;
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'invalid_json' }); return; }
    try {
      const result = await apply(data || {});
      sendJson(res, result.ok ? 200 : statusMap[result.error] || 500, result);
    } catch (err) {
      log('error', errorTag, { error: err?.message ?? String(err) });
      sendJson(res, 500, { error: 'internal_error' });
    }
  });
}

// `getHealthSnapshot` (obrigatorio) alimenta GET /health.
// `session` e `log` sao opcionais: quando `session` esta presente, expoe os
// endpoints de persistencia (POST /api/players, GET /api/session/current,
// GET /api/dispatch/history).
// `dispatchAdmin` (opcional, NEU-143): GET /api/dispatch/overview e POST /api/dispatch/requeue.
// `getStatus` (opcional, NEU-139): GET /api/status, presenca das pecas para a faixa do painel.
// `playerSetup` (opcional, NEU-86): POST /api/players/source e /api/players/camera.
function createHttpServer(getHealthSnapshot, session, log = () => {}, dispatchAdmin = null, getStatus = null, playerSetup = null) {
  return http.createServer((req, res) => {
    const urlPath = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC, urlPath)) {
      const [file, type] = STATIC[urlPath];
      fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
        if (err) {
          log('error', 'static_read_error', { file, error: err.message });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getHealthSnapshot()));
      return;
    }

    // NEU-139: presenca das pecas para a faixa de status (relogio do broker em `now`).
    if (getStatus && req.method === 'GET' && req.url === '/api/status') {
      sendJson(res, 200, getStatus());
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

    // Historico curto do dispatcher (NEU-68): ultimas corridas enviadas/rejeitadas.
    if (session && req.method === 'GET' && req.url === '/api/dispatch/history') {
      session
        .getDispatchHistory()
        .then((data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        })
        .catch((err) => {
          log('error', 'api_dispatch_history_error', { error: err?.message ?? String(err) });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        });
      return;
    }

    if (dispatchAdmin && req.method === 'GET' && req.url === '/api/dispatch/overview') {
      dispatchAdmin
        .overview()
        .then((data) => sendJson(res, 200, data))
        .catch((err) => {
          log('error', 'api_dispatch_overview_error', { error: err?.message ?? String(err) });
          sendJson(res, 500, { error: 'internal_error' });
        });
      return;
    }

    if (dispatchAdmin && req.method === 'POST' && req.url === '/api/dispatch/requeue') {
      handleRequeue(req, res, dispatchAdmin, log);
      return;
    }

    // NEU-141: ultimos jogadores cadastrados (contato completo: o painel so abre no PC central).
    if (session && req.method === 'GET' && req.url === '/api/players/recent') {
      session
        .getRecentPlayers()
        .then((data) => sendJson(res, 200, data))
        .catch((err) => {
          log('error', 'api_recent_players_error', { error: err?.message ?? String(err) });
          sendJson(res, 500, { error: 'internal_error' });
        });
      return;
    }

    // "Limpar lista" (NEU-141). Exige JSON pelo mesmo motivo do requeue (CSRF por formulario).
    if (session && req.method === 'POST' && req.url === '/api/players/recent/clear') {
      req.resume();
      if (!isJsonRequest(req)) {
        sendJson(res, 415, { error: 'unsupported_media_type' });
        return;
      }
      session
        .clearRecentPlayers()
        .then(() => sendJson(res, 200, { ok: true }))
        .catch((err) => {
          log('error', 'api_recent_players_clear_error', { error: err?.message ?? String(err) });
          sendJson(res, 500, { error: 'internal_error' });
        });
      return;
    }

    if (playerSetup && req.method === 'POST' && req.url === '/api/players/source') {
      handleJsonPost(req, res, log, (d) => playerSetup.setSource(d.player, d.source), SETUP_STATUS, 'api_player_setup_error');
      return;
    }
    if (playerSetup && req.method === 'POST' && req.url === '/api/players/camera') {
      handleJsonPost(req, res, log, (d) => playerSetup.setCamera(d.player, d.camera), SETUP_STATUS, 'api_player_setup_error');
      return;
    }

    // NEU-140: vincular o contato a uma corrida largada sem registro, e Parar.
    if (session && req.method === 'POST' && req.url === '/api/session/link') {
      handleJsonPost(req, res, log, (data) => session.linkPlayer(data.player, data.email), SESSION_STATUS, 'api_session_link_error');
      return;
    }
    if (session && req.method === 'POST' && req.url === '/api/session/stop') {
      handleJsonPost(req, res, log, () => session.stopRace(), SESSION_STATUS, 'api_session_stop_error');
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
          const result = await session.registerPlayers(player1Email, player2Email, {
            p1NoSignup: data.player1NoSignup === true,
            p2NoSignup: data.player2NoSignup === true,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          if (err && (err.code === 'invalid_email' || err.code === 'missing_contact')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.code, field: err.field }));
            return;
          }
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
