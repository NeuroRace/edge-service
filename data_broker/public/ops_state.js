// data_broker/public/ops_state.js — logica PURA da tela de operacao (NEU-68).
// Carregado no browser (window.OpsState) E no Node (session_manager usa a mesma regra
// de e-mail; os testes rodam sem DOM). Sem clock: `now` e sempre injetado.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsState = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function normalizeEmail(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  // Vazio = jogador anonimo (permitido, nao vai para a nuvem). Qualquer outra coisa
  // precisa ter formato basico de e-mail (D15: validar no edge, sem consultar a nuvem).
  function validateEmail(value) {
    if (value === '') return true;
    return EMAIL_RE.test(value);
  }

  // Estado do cartao do jogador, na ordem do trabalho do operador:
  // waiting -> registered|anonymous -> racing -> finished -> sent|rejected
  function cardState({ slot, session, pending, raceEvents, history }) {
    const key = `player${slot}`;
    if (pending && pending[`${key}Email`] !== undefined) {
      return pending[`${key}Email`] ? 'registered' : 'anonymous';
    }
    if (session && session.status === 'active') {
      if (session[`${key}IsBot`]) return 'anonymous';
      // Historico da sessao atual manda (a pagina pode ter sido aberta DEPOIS do hasFinished).
      // Correlacao por sessionId — um envio atrasado da corrida anterior nao pode "fechar" a atual.
      // Entradas antigas sem sessionId (broker anterior) caem no criterio de tempo.
      const startedAt = Number(session.startedAt) || 0;
      const mine = (history || []).filter((h) => h.playerId === slot
        && (h.sessionId ? h.sessionId === session.sessionId : Number(h.at) >= startedAt));
      if (mine.length > 0) return mine[0].status === 'sent' ? 'sent' : 'rejected';
      // Flag persistida no Redis (hasFinished ja consolidou) ou evento visto por esta pagina.
      if (session[`${key}Finished`] || (raceEvents && raceEvents[slot])) return 'finished';
      return 'racing';
    }
    return 'waiting';
  }

  // Leitor/sinal: link pela idade do ultimo pacote; qualidade pelo poorSignalLevel
  // do NeuroSky (0 = contato perfeito, 200 = sem contato).
  function signalStatus({ lastPacketAt, now, poorSignalLevel }) {
    if (lastPacketAt == null) return { link: 'lost', quality: 'none' };
    const age = now - lastPacketAt;
    const link = age < 3000 ? 'ok' : age < 10000 ? 'slow' : 'lost';
    if (link === 'lost' || poorSignalLevel == null) return { link, quality: 'none' };
    const psl = Number(poorSignalLevel);
    const quality = psl === 0 ? 'good' : psl < 200 ? 'weak' : 'none';
    return { link, quality };
  }

  const QUEUE_STUCK_MS = 30000;

  // Corridas aguardando envio: na fila + reagendadas apos falha temporaria (NEU-92).
  // Durante uma queda da nuvem elas ficam em `retrying`, nao em `queue`.
  function pendingCount(counts) {
    return Number((counts && counts.queue) || 0) + Number((counts && counts.retrying) || 0);
  }

  // NEU-143: motivo de uma corrida que nao subiu (entrada de /api/dispatch/overview).
  function failureText(f) {
    const e = f || {};
    if (e.reason === 'exhausted') {
      return `a nuvem não respondeu após ${e.attempts ?? '?'} tentativas (${e.httpStatus ? `último HTTP ${e.httpStatus}` : 'sem internet?'})`;
    }
    if (e.reason === 'permanent') {
      if (Number(e.httpStatus) === 401) return 'a nuvem recusou a chave do estande (HTTP 401) · confira o EDGE_INGEST_TOKEN';
      return `a nuvem recusou (HTTP ${e.httpStatus ?? '?'}${e.errorCode ? `: ${e.errorCode}` : ''})`;
    }
    if (e.reason === 'mapping_failed') return `erro ao montar o envio${e.error ? `: ${e.error}` : ''}`;
    if (e.reason === 'malformed_record' || e.reason === 'malformed_entry') return 'registro corrompido, não dá para reenviar';
    return e.reason || 'motivo desconhecido';
  }

  // Regra da bolinha "Nuvem" (NEU-139): pede atencao com corrida que falhou ou que espera
  // ha mais de QUEUE_STUCK_MS. `waitingSince` = desde quando ha corrida esperando.
  function cloudNeedsAttention({ overview, waitingSince, now }) {
    const c = (overview && overview.counts) || {};
    if (Number(c.failed) > 0) return true;
    return Number(c.waiting) > 0 && waitingSince != null && now - waitingSince > QUEUE_STUCK_MS;
  }

  // Um banner so quando ha problema. Ordem = gravidade para o operador.
  function alerts({ session, health, signals, now, queueSince, prevDiscarded, overview }) {
    const out = [];
    const disp = (health && health.dispatcher) || { enabled: false };
    const counts = disp.counts || {};
    if (session && session.status === 'active' && session.player1IsBot && session.player2IsBot) {
      out.push({ level: 'error', code: 'race_without_players', text: 'Corrida iniciada sem jogadores registrados — NÃO será salva. Registre os e-mails antes da largada.' });
    }
    if (health && Number(health.discardedRaces) > Number(prevDiscarded || 0)) {
      const text = health.lastDiscardReason === 'no_eeg_signal'
        ? 'Uma corrida foi descartada porque o leitor ficou sem sinal de EEG (fone desconectado ou sem contato). Ela não foi para a nuvem — peça para a pessoa correr de novo.'
        : 'Uma corrida foi descartada por falta de e-mail registrado. Ela não foi para a nuvem.';
      out.push({ level: 'error', code: 'race_discarded', text });
    }
    if (!disp.enabled) {
      const why = disp.reason === 'api_url_missing' ? 'API_URL não definido (.env da raiz)'
        : disp.reason === 'token_missing' ? 'EDGE_INGEST_TOKEN vazio'
          : disp.reason === 'dispatcher_fatal' ? 'o envio parou por erro fatal' : (disp.reason || 'motivo desconhecido');
      out.push({ level: 'error', code: 'cloud_disabled', text: `Nuvem DESLIGADA — corridas ficam na fila e não aparecem no site (${why}).` });
    }
    const pendingRaces = pendingCount(counts);
    if (pendingRaces > 0 && queueSince != null && now - queueSince > QUEUE_STUCK_MS) {
      out.push({ level: 'warn', code: 'queue_stuck', text: `${pendingRaces} corrida(s) aguardando envio há mais de 30 s — internet ou nuvem lenta. Nada se perde; elas sobem quando voltar.` });
    }
    const failed = Number(overview && overview.counts && overview.counts.failed) || 0;
    if (failed > 0) {
      out.push({ level: 'warn', code: 'cloud_failed', text: `${failed} corrida(s) não subiram para a nuvem. Veja "Não subiram" no bloco Nuvem e use Reenviar.` });
    }
    // NEU-104: jogador com e-mail registrado para a proxima corrida e leitor sem sinal —
    // se largar assim, a corrida dele sera descartada. Erro (nao aviso) e substitui o
    // signal_lost daquele jogador para nao repetir o banner.
    const pending = session && session.pending;
    const blocked = {};
    for (const slot of [1, 2]) {
      const sig = signals && signals[slot];
      if (pending && pending[`player${slot}Email`] && sig && sig.link === 'lost') {
        blocked[slot] = true;
        out.push({ level: 'error', code: 'registered_without_signal', text: `Jogador ${slot} registrado, mas o leitor está sem sinal — não dê a largada: sem EEG a corrida será descartada.` });
      }
    }
    // Leitor sem pacotes ha >10 s: alerta sempre que ja houve sinal daquele jogador
    // (signals[slot] presente). Sem sinal nunca visto = tela recem-aberta, nao alerta.
    for (const slot of [1, 2]) {
      const sig = signals && signals[slot];
      if (sig && sig.link === 'lost' && !blocked[slot]) {
        out.push({ level: 'warn', code: 'signal_lost', text: `Leitor do jogador ${slot} sem sinal há mais de 10 s.` });
      }
    }
    return out;
  }

  // ---------- NEU-139: faixa de status ----------
  const STALE_MS = 10000;
  const PIECE_PC = { 'acquisition-p1': 'PC central', 'gesture-p1': 'PC central', 'acquisition-p2': 'PC coletor', 'gesture-p2': 'PC coletor' };

  // Poor Signal do NeuroSky: 0 contato perfeito, 200 sem contato.
  function pslLevel(psl) {
    if (psl === null || psl === undefined || !Number.isFinite(Number(psl))) return 'none';
    const n = Number(psl);
    return n === 0 ? 'good' : n < 200 ? 'weak' : 'bad';
  }

  // Sem noticia ha mais de STALE_MS (ou nunca) nao e 'ok'. `now` = relogio do broker.
  function pieceState(piece, now) {
    if (!piece || !piece.connected) return 'down';
    if (piece.lastEventAt === null || piece.lastEventAt === undefined || now - piece.lastEventAt > STALE_MS) return 'stale';
    return 'ok';
  }

  function pieceLine(key, state) {
    const pc = PIECE_PC[key];
    const player = key.slice(-2).toUpperCase();
    if (key.startsWith('acquisition')) {
      // A acquisition so conecta no broker depois de conectar no EEG (acquisition_runner): sem
      // conexao pode ser ThinkGear/fone fora OU a peca caida. A mais provavel vem primeiro.
      return state === 'down'
        ? `${key} sem conexão · confira o ThinkGear e o fone do ${player} no ${pc} (ou suba as peças)`
        : `${key} sem dados · confira o fone do ${player} no ${pc}`;
    }
    return state === 'down' ? `${key} desligado · abra o detector de gesto no ${pc}` : `${key} sem notícia · reinicie o detector de gesto no ${pc}`;
  }

  function groupLevel(states) {
    if (states.every((s) => s === 'ok')) return 'ok';
    if (states.every((s) => s === 'down')) return 'down';
    return 'warn';
  }

  function statusStrip({ status, health, overview, waitingSince, now }) {
    if (!status) {
      return { groups: { central: 'unknown', coletor: 'unknown', jogo: 'unknown', nuvem: 'unknown' }, lines: ['broker sem resposta · confira o PC central'] };
    }
    const t = Number.isFinite(Number(status.now)) ? Number(status.now) : now;
    const pieces = status.pieces || {};
    const lines = [];
    // NEU-142: central e coletor com codigos diferentes vem primeiro (causa de muita coisa).
    lines.push(...versionWarnings(pieces));
    const states = (keys) => keys.map((k) => [k, pieceState(pieces[k], t)]);

    const redisState = status.redis && status.redis.status === 'ready' ? 'ok' : 'down';
    const centralPieces = states(['acquisition-p1', 'gesture-p1']);
    const central = groupLevel([redisState, ...centralPieces.map(([, s]) => s)]);
    if (redisState === 'down') lines.push('redis fora · reinicie o redis no PC central (a fila fica guardada)');
    for (const [k, s] of centralPieces) if (s !== 'ok') lines.push(pieceLine(k, s));

    const coletorPieces = states(['acquisition-p2', 'gesture-p2']);
    const coletor = groupLevel(coletorPieces.map(([, s]) => s));
    if (coletor === 'down') lines.push('Coletor sem resposta · confira se o PC coletor está ligado e o cabo plugado');
    else for (const [k, s] of coletorPieces) if (s !== 'ok') lines.push(pieceLine(k, s));

    const jogo = status.game && Number(status.game.connections) > 0 ? 'ok' : 'down';
    if (jogo === 'down') lines.push('jogo não conectado · abra o jogo no PC central');

    let nuvem = 'unknown';
    const disp = health && health.dispatcher;
    if (health && (!disp || !disp.enabled)) {
      nuvem = 'down';
      lines.push('nuvem desligada · corridas ficam guardadas no PC central');
    } else if (health && cloudNeedsAttention({ overview, waitingSince, now })) {
      nuvem = 'warn';
      const failed = Number(overview && overview.counts && overview.counts.failed) || 0;
      lines.push(failed > 0 ? `${failed} corrida(s) não subiram · use Reenviar no bloco Nuvem` : 'corridas esperando há mais de 30 s · internet do evento?');
    } else if (health) {
      nuvem = 'ok';
    }
    return { groups: { central, coletor, jogo, nuvem }, lines };
  }

  // ---------- NEU-142: Diagnostico ----------
  const DIAG_WORD = { ok: 'OK', stale: 'Sem notícia', down: 'Fora' };
  const CONN_LABEL = [['acquisition-p1', 'acquisition-p1'], ['gesture-p1', 'gesture-p1'], ['acquisition-p2', 'acquisition-p2'], ['gesture-p2', 'gesture-p2'], ['panel', 'painel'], ['test-client', 'test-client'], ['unidentified', 'não identificado (jogo)']];

  function ago(ms) {
    return ms === null || ms === undefined || !Number.isFinite(ms) ? '—' : `há ${Math.max(0, Math.round(ms / 1000))} s`;
  }

  function versionLabel(key, meta) {
    if (key.startsWith('gesture') && meta.commit) return `${meta.branch || '?'} · ${meta.commit}`;
    return meta.version ? `código ${meta.version}` : 'versão desconhecida';
  }

  function versionWarnings(pieces) {
    const out = [];
    for (const role of ['acquisition', 'gesture']) {
      const v1 = pieces[`${role}-p1`] && pieces[`${role}-p1`].meta && pieces[`${role}-p1`].meta.version;
      const v2 = pieces[`${role}-p2`] && pieces[`${role}-p2`].meta && pieces[`${role}-p2`].meta.version;
      if (v1 && v2 && v1 !== v2) out.push(`versões diferentes entre central e coletor: ${role} (central ${v1} · coletor ${v2}) · atualize o coletor (git pull) e reabra as peças`);
    }
    return out;
  }

  function diagnostics({ status }) {
    if (!status) return { pcs: [], versionWarnings: [] };
    const t = Number(status.now);
    const pieces = status.pieces || {};
    const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
    function ourPiece(key) {
      const p = pieces[key] || {}; const meta = p.meta || {};
      const st = pieceState(p, t);
      const age = p.lastEventAt === null || p.lastEventAt === undefined ? null : t - p.lastEventAt;
      const details = key.startsWith('acquisition')
        ? [['fonte', dash(meta.source)], ['ThinkGear', meta.eegHost ? `${meta.eegHost}:${dash(meta.acqPort)}` : '—'], ['Poor Signal', dash(p.poorSignalLevel)], ['atenção', dash(p.attention)], ['último dado', ago(age)]]
        : [['câmera', meta.camera === undefined ? '—' : `Câmera ${Number(meta.camera) + 1}`], ['mão vista', p.handSeen === null || p.handSeen === undefined ? '—' : p.handSeen ? 'sim' : 'não'], ['última notícia', ago(age)]];
      return { key, level: st, word: DIAG_WORD[st], version: versionLabel(key, meta), line: st === 'ok' ? null : pieceLine(key, st), details };
    }
    const conns = status.connections || {};
    const connText = CONN_LABEL.filter(([k]) => conns[k]).map(([k, label]) => `${label} ×${conns[k]}`).join(' · ') || 'ninguém';
    const uptime = status.broker && Number(status.broker.uptimeSeconds);
    const broker = {
      key: 'broker', level: 'ok', word: DIAG_WORD.ok, line: null,
      version: status.broker && status.broker.version ? `código ${status.broker.version}` : 'versão desconhecida',
      details: [['conectados', connText], ['no ar há', Number.isFinite(uptime) ? `${Math.floor(uptime / 60)} min` : '—']],
    };
    const redisOk = status.redis && status.redis.status === 'ready';
    const redis = {
      key: 'redis', level: redisOk ? 'ok' : 'down', word: redisOk ? DIAG_WORD.ok : DIAG_WORD.down, version: '—',
      line: redisOk ? null : 'redis fora · reinicie o redis no PC central (a fila fica guardada)',
      details: [['estado', dash(status.redis && status.redis.status)]],
    };
    const game = status.game || {};
    const gameOk = Number(game.connections) > 0;
    const jogo = {
      key: 'jogo', level: gameOk ? 'ok' : 'down', word: gameOk ? DIAG_WORD.ok : DIAG_WORD.down, version: '—',
      line: gameOk ? null : 'jogo não conectado · abra o jogo no PC central',
      details: [['conexões', String(Number(game.connections) || 0)], ['últimos eventos', (game.recentEvents || []).map((e) => `${e.event} ${ago(t - e.at)}`).join(' · ') || '—']],
    };
    return {
      pcs: [
        { name: 'PC CENTRAL', pieces: [broker, redis, ourPiece('acquisition-p1'), ourPiece('gesture-p1'), jogo] },
        { name: 'PC COLETOR', pieces: [ourPiece('acquisition-p2'), ourPiece('gesture-p2')] },
      ],
      versionWarnings: versionWarnings(pieces),
    };
  }

  // NEU-141: busca na lista de ultimos jogadores (parte do contato, sem caixa).
  function filterRecentPlayers(list, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const items = Array.isArray(list) ? list : [];
    return q ? items.filter((p) => String(p.contact || '').toLowerCase().includes(q)) : items;
  }

  return { normalizeEmail, validateEmail, cardState, signalStatus, alerts, failureText, cloudNeedsAttention, pendingCount, statusStrip, pslLevel, filterRecentPlayers, diagnostics, versionWarnings, QUEUE_STUCK_MS, STALE_MS };
}));
