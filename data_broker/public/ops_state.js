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

  // Um banner so quando ha problema. Ordem = gravidade para o operador.
  function alerts({ session, health, signals, now, queueSince, prevDiscarded }) {
    const out = [];
    const disp = (health && health.dispatcher) || { enabled: false };
    const counts = disp.counts || {};
    if (session && session.status === 'active' && session.player1IsBot && session.player2IsBot) {
      out.push({ level: 'error', code: 'race_without_players', text: 'Corrida iniciada sem jogadores registrados — NÃO será salva. Registre os e-mails antes da largada.' });
    }
    if (health && Number(health.discardedRaces) > Number(prevDiscarded || 0)) {
      out.push({ level: 'error', code: 'race_discarded', text: 'Uma corrida foi descartada por falta de e-mail registrado. Ela não foi para a nuvem.' });
    }
    if (!disp.enabled) {
      const why = disp.reason === 'api_url_missing' ? 'API_URL não definido (.env da raiz)'
        : disp.reason === 'token_missing' ? 'EDGE_INGEST_TOKEN vazio'
          : disp.reason === 'dispatcher_fatal' ? 'o envio parou por erro fatal' : (disp.reason || 'motivo desconhecido');
      out.push({ level: 'error', code: 'cloud_disabled', text: `Nuvem DESLIGADA — corridas ficam na fila e não aparecem no site (${why}).` });
    }
    if (Number(counts.queue) > 0 && queueSince != null && now - queueSince > QUEUE_STUCK_MS) {
      out.push({ level: 'warn', code: 'queue_stuck', text: `${counts.queue} corrida(s) na fila há mais de 30 s — internet ou nuvem lenta. Nada se perde; elas sobem quando voltar.` });
    }
    // Leitor sem pacotes ha >10 s: alerta sempre que ja houve sinal daquele jogador
    // (signals[slot] presente). Sem sinal nunca visto = tela recem-aberta, nao alerta.
    for (const slot of [1, 2]) {
      const sig = signals && signals[slot];
      if (sig && sig.link === 'lost') {
        out.push({ level: 'warn', code: 'signal_lost', text: `Leitor do jogador ${slot} sem sinal há mais de 10 s.` });
      }
    }
    return out;
  }

  return { normalizeEmail, validateEmail, cardState, signalStatus, alerts, QUEUE_STUCK_MS };
}));
