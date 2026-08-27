// data_broker/public/ops.js — DOM + Socket.IO + polling da tela de operacao (NEU-68).
// Toda regra de estado/alerta vive em ops_state.js (puro, testado em Node).
(function () {
  'use strict';
  const S = window.OpsState;
  const $ = (sel) => document.querySelector(sel);
  const SPARK_MS = 60000;

  const st = {
    session: { status: 'none', pending: null },
    health: null,
    history: [],
    raceEvents: { 1: false, 2: false },
    packets: { 1: null, 2: null },          // { at, psl, attention }
    series: { 1: [], 2: [] },               // [{ t, a }]
    queueSince: null,
    prevDiscarded: null,                    // baseline na 1a leitura do /health
    socketOk: false,
  };

  // ---------- rede ----------
  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }
  async function refresh() {
    const [health, session, history] = await Promise.allSettled([getJson('/health'), getJson('/api/session/current'), getJson('/api/dispatch/history')]);
    if (health.status === 'fulfilled') {
      st.health = health.value;
      if (st.prevDiscarded === null) st.prevDiscarded = Number(st.health.discardedRaces || 0);
      const q = Number((st.health.dispatcher && st.health.dispatcher.counts && st.health.dispatcher.counts.queue) || 0);
      if (q > 0 && st.queueSince === null) st.queueSince = Date.now();
      if (q === 0) st.queueSince = null;
    }
    if (session.status === 'fulfilled') st.session = session.value;
    if (history.status === 'fulfilled') st.history = history.value;
    render();
  }

  const socket = window.io ? window.io({ transports: ['websocket', 'polling'] }) : null;
  if (socket) {
    socket.on('connect', () => { st.socketOk = true; render(); });
    socket.on('disconnect', () => { st.socketOk = false; render(); });
    socket.on('eSense', (p) => {
      const slot = Number(p && p.player);
      if (slot !== 1 && slot !== 2) return;
      const now = Date.now();
      st.packets[slot] = { at: now, psl: p.poorSignalLevel, attention: Number(p.attention) };
      const s = st.series[slot]; s.push({ t: now, a: Number(p.attention) });
      while (s.length && now - s[0].t > SPARK_MS) s.shift();
      renderSignal(slot);
    });
    socket.on('raceStarted', () => { st.raceEvents = { 1: false, 2: false }; setTimeout(refresh, 300); });
    socket.on('hasFinished', (p) => { const slot = Number(p && p.playerId); if (slot === 1 || slot === 2) st.raceEvents[slot] = true; setTimeout(refresh, 400); setTimeout(refresh, 3000); });
  }

  // ---------- registrar ----------
  const form = $('#register-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#register-btn');
    const emails = { 1: S.normalizeEmail($('#email1').value), 2: S.normalizeEmail($('#email2').value) };
    let bad = false;
    for (const slot of [1, 2]) {
      const input = $(`#email${slot}`); const err = $(`[data-error="${slot}"]`);
      input.value = emails[slot];
      if (!S.validateEmail(emails[slot])) { bad = true; input.setAttribute('aria-invalid', 'true'); err.textContent = 'E-mail inválido. Corrija ou deixe em branco para anônimo.'; err.hidden = false; }
      else { input.removeAttribute('aria-invalid'); err.hidden = true; err.textContent = ''; }
    }
    if (bad) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/players', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player1Email: emails[1], player2Email: emails[2] }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 400 && body.error === 'invalid_email') {
        const slot = body.field === 'player2Email' ? 2 : 1;
        $(`#email${slot}`).setAttribute('aria-invalid', 'true'); const err = $(`[data-error="${slot}"]`); err.textContent = 'O broker recusou este e-mail.'; err.hidden = false;
      } else if (!res.ok) {
        $('#register-hint').textContent = `Falha ao registrar (${res.status}). Tente de novo.`;
      } else {
        $('#register-hint').textContent = 'Registrados. Pode dar a largada — o registro vale por 1 hora.';
        st.raceEvents = { 1: false, 2: false };
        // Registrar a proxima dupla "reconhece" descartes anteriores: o alerta some.
        st.prevDiscarded = Number((st.health && st.health.discardedRaces) || 0);
      }
      await refresh();
    } catch (e) {
      $('#register-hint').textContent = 'Sem resposta do broker. Ele está de pé?';
    } finally { btn.disabled = false; }
  });

  // ---------- render ----------
  const STATE_LABEL = { waiting: 'Aguardando', registered: 'Registrado', anonymous: 'Anônimo — não vai para a nuvem', racing: 'Correndo', finished: 'Finalizada — enviando…', sent: 'Enviada ✓', rejected: 'Falhou ao enviar' };
  const STEP_ORDER = ['registered', 'racing', 'finished', 'sent'];
  const HINT_DEFAULT = 'Registre antes da largada. O registro vale por 1 hora.';
  function renderCards() {
    // Sem dupla registrada para a proxima corrida, a dica volta ao padrao (nao fica "pode dar a largada" apos o envio).
    if (!st.session.pending && $('#register-hint').textContent.startsWith('Registrados')) $('#register-hint').textContent = HINT_DEFAULT;
    for (const slot of [1, 2]) {
      const state = S.cardState({ slot, session: st.session, pending: st.session.pending || null, raceEvents: st.raceEvents, history: st.history });
      const card = $(`.card[data-slot="${slot}"]`);
      card.dataset.state = state;
      $(`[data-state-chip="${slot}"]`).textContent = STATE_LABEL[state];
      const idx = state === 'rejected' ? 3 : STEP_ORDER.indexOf(state);
      card.querySelectorAll('.steps li').forEach((li, i) => { li.dataset.done = String(i < idx); li.dataset.current = String(i === idx); });
      // Durante a corrida (ate o envio) o campo mostra o e-mail em uso e fica travado;
      // depois libera para a proxima dupla.
      const input = $(`#email${slot}`);
      const locked = (state === 'racing' || state === 'finished') && !st.session.pending;
      if (locked) { input.value = st.session[`player${slot}Email`] || ''; input.readOnly = true; }
      else if (input.readOnly) { input.readOnly = false; input.value = ''; }
      else input.readOnly = false;
    }
  }
  function sparkPath(points) {
    if (points.length < 2) return '';
    const t0 = points[0].t, t1 = points[points.length - 1].t, span = Math.max(t1 - t0, 1000);
    return points.map((p, i) => `${i ? 'L' : 'M'}${((p.t - t0) / span * 240).toFixed(1)},${(48 - (Math.max(0, Math.min(100, p.a)) / 100) * 44 - 2).toFixed(1)}`).join(' ');
  }
  function renderSignal(slot) {
    const pk = st.packets[slot]; const now = Date.now();
    const sig = S.signalStatus({ lastPacketAt: pk && pk.at, now, poorSignalLevel: pk && pk.psl });
    const link = $(`[data-link="${slot}"]`); link.dataset.linkState = sig.link;
    const age = pk ? Math.round((now - pk.at) / 1000) : null;
    link.innerHTML = `<i class="dot"></i> ${pk ? (sig.link === 'ok' ? 'conectado' : `último pacote há ${age} s`) : 'sem pacotes'}`;
    $(`[data-attn="${slot}"]`).textContent = pk && sig.link !== 'lost' ? String(pk.attention) : '—';
    const q = $(`[data-quality="${slot}"]`); q.dataset.q = sig.quality;
    q.textContent = `contato: ${sig.quality === 'good' ? 'bom' : sig.quality === 'weak' ? 'fraco' : sig.link === 'lost' ? '—' : 'sem contato'}`;
    $(`[data-spark="${slot}"]`).setAttribute('d', sparkPath(st.series[slot]));
  }
  function renderCloud() {
    const h = st.health; const chip = $('[data-cloud-chip]'); const counts = $('[data-counts]');
    if (!h) { chip.textContent = 'Nuvem: sem resposta do broker'; chip.dataset.on = 'false'; return; }
    const d = h.dispatcher || { enabled: false };
    chip.dataset.on = String(!!d.enabled);
    chip.textContent = d.enabled ? `Nuvem: ligada → ${d.target || '?'}` : 'Nuvem: DESLIGADA';
    const c = d.counts || {};
    counts.textContent = `fila ${c.queue ?? '—'} · enviando ${c.processing ?? '—'} · falhas ${c.deadletter ?? '—'} · descartadas ${h.discardedRaces ?? 0}`;
    const tbody = $('[data-history]'); const rows = (st.history || []).slice(0, 10);
    tbody.innerHTML = rows.length ? rows.map((r) => `<tr><td class="mono">${new Date(r.at).toLocaleTimeString('pt-BR')}</td><td>Jogador ${r.playerId}</td><td class="mono">${r.email || '—'}</td><td class="result" data-r="${r.status}">${r.status === 'sent' ? `Enviada ✓ (${r.result || 'ok'})` : `Falhou: ${r.reason || 'erro'}`}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="4">Nenhuma corrida enviada ainda nesta sessão do broker.</td></tr>';
  }
  function renderBanner() {
    const now = Date.now();
    const signals = { 1: S.signalStatus({ lastPacketAt: st.packets[1] && st.packets[1].at, now, poorSignalLevel: null }), 2: S.signalStatus({ lastPacketAt: st.packets[2] && st.packets[2].at, now, poorSignalLevel: null }) };
    const list = S.alerts({ session: st.session, health: st.health, signals, now, queueSince: st.queueSince, prevDiscarded: st.prevDiscarded });
    if (socket && !st.socketOk) list.unshift({ level: 'error', code: 'socket_down', text: 'Sem conexão em tempo real com o broker (a tela não vê a corrida).' });
    const banner = $('[data-banner]');
    banner.hidden = list.length === 0;
    banner.dataset.level = list.some((a) => a.level === 'error') ? 'error' : 'warn';
    $('#banner-list').innerHTML = list.map((a) => `<li data-level="${a.level}" data-code="${a.code}">${a.text}</li>`).join('');
  }
  function render() { renderCards(); renderSignal(1); renderSignal(2); renderCloud(); renderBanner(); }

  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR'); renderSignal(1); renderSignal(2); renderBanner(); }, 1000);
  setInterval(refresh, 2000);
  refresh();
}());
