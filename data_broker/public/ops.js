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
    overview: null,                         // NEU-143: /api/dispatch/overview
    status: null,                           // NEU-139: /api/status (presenca das pecas)
    waitingSince: null,                     // desde quando ha corrida esperando envio
    pslSeries: { 1: [], 2: [] },            // [{ t, a }] Poor Signal escalado 0..100
    fists: { 1: [], 2: [] },                // horarios dos punhos (ultimo minuto)
    recent: [],                             // NEU-141: /api/players/recent
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
    const [health, session, history, overview, status, recent] = await Promise.allSettled([getJson('/health'), getJson('/api/session/current'), getJson('/api/dispatch/history'), getJson('/api/dispatch/overview'), getJson('/api/status'), getJson('/api/players/recent')]);
    if (health.status === 'fulfilled') {
      st.health = health.value;
      if (st.prevDiscarded === null) st.prevDiscarded = Number(st.health.discardedRaces || 0);
      const q = S.pendingCount(st.health.dispatcher && st.health.dispatcher.counts);
      if (q > 0 && st.queueSince === null) st.queueSince = Date.now();
      if (q === 0) st.queueSince = null;
    }
    if (session.status === 'fulfilled') st.session = session.value;
    if (history.status === 'fulfilled') st.history = history.value;
    st.overview = overview.status === 'fulfilled' ? overview.value : null;
    st.status = status.status === 'fulfilled' ? status.value : null;
    if (recent.status === 'fulfilled') st.recent = recent.value;
    const waiting = Number(st.overview && st.overview.counts && st.overview.counts.waiting) || 0;
    if (waiting > 0 && st.waitingSince === null) st.waitingSince = Date.now();
    if (waiting === 0) st.waitingSince = null;
    render();
  }

  // NEU-139: o painel se apresenta, senao o broker o contaria como o jogo (conexao anonima).
  const socket = window.io ? window.io({ transports: ['websocket', 'polling'], auth: { role: 'panel' } }) : null;
  if (socket) {
    socket.on('connect', () => { st.socketOk = true; render(); });
    socket.on('disconnect', () => { st.socketOk = false; render(); });
    socket.on('eSense', (p) => {
      const slot = Number(p && p.player);
      if (slot !== 1 && slot !== 2) return;
      const now = Date.now();
      st.packets[slot] = { at: now, psl: p.poorSignalLevel, attention: Number(p.attention), source: p.source };
      const s = st.series[slot]; s.push({ t: now, a: Number(p.attention) });
      while (s.length && now - s[0].t > SPARK_MS) s.shift();
      if (p.poorSignalLevel !== null && p.poorSignalLevel !== undefined) {
        const ps = st.pslSeries[slot]; ps.push({ t: now, a: Math.min(100, Number(p.poorSignalLevel) / 2) });
        while (ps.length && now - ps[0].t > SPARK_MS) ps.shift();
      }
      renderSignal(slot);
    });
    socket.on('handGesture', (p) => {
      const slot = Number(p && p.player);
      if (slot !== 1 && slot !== 2) return;
      st.fists[slot].push(Date.now());
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
  // NEU-139 (spec B9): o envio a nuvem nao aparece no card; "Terminou" ja libera a proxima.
  const STATE_LABEL = { waiting: 'Aguardando', registered: 'Registrado', anonymous: 'Anônimo — não vai para a nuvem', racing: 'Correndo', finished: 'Terminou', sent: 'Terminou', rejected: 'Terminou' };
  const STEP_ORDER = ['registered', 'racing', 'finished'];
  const HINT_DEFAULT = 'Registre antes da largada. O registro vale por 1 hora.';
  function renderCards() {
    // Sem dupla registrada para a proxima corrida, a dica volta ao padrao (nao fica "pode dar a largada" apos o envio).
    if (!st.session.pending && $('#register-hint').textContent.startsWith('Registrados')) $('#register-hint').textContent = HINT_DEFAULT;
    for (const slot of [1, 2]) {
      const state = S.cardState({ slot, session: st.session, pending: st.session.pending || null, raceEvents: st.raceEvents, history: st.history });
      const card = $(`.card[data-slot="${slot}"]`);
      card.dataset.state = state;
      $(`[data-state-chip="${slot}"]`).textContent = STATE_LABEL[state];
      const idx = state === 'sent' || state === 'rejected' ? 2 : STEP_ORDER.indexOf(state);
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
    link.replaceChildren(Object.assign(document.createElement('i'), { className: 'dot' }), document.createTextNode(' ' + (pk ? (sig.link === 'ok' ? 'conectado' : `último pacote há ${age} s`) : 'sem pacotes')));
    // NEU-139 (spec B5): sem dados ha mais de 10 s -> "Sem dados" em vermelho, nunca numero congelado.
    const attn = $(`[data-attn="${slot}"]`); const psl = $(`[data-psl="${slot}"]`);
    if (!pk || now - pk.at > S.STALE_MS) {
      attn.textContent = 'Sem dados'; attn.dataset.level = 'bad';
      psl.textContent = 'Sem dados'; psl.dataset.level = 'bad';
      $(`[data-spark="${slot}"]`).setAttribute('d', '');
      $(`[data-spark-psl="${slot}"]`).setAttribute('d', '');
    } else {
      attn.textContent = String(pk.attention); attn.dataset.level = 'none';
      if (pk.source === 'bot') { psl.textContent = 'simulado'; psl.dataset.level = 'none'; }
      else { psl.textContent = pk.psl === null || pk.psl === undefined ? '—' : String(pk.psl); psl.dataset.level = S.pslLevel(pk.psl); }
      $(`[data-spark="${slot}"]`).setAttribute('d', sparkPath(st.series[slot]));
      $(`[data-spark-psl="${slot}"]`).setAttribute('d', pk.source === 'bot' ? '' : sparkPath(st.pslSeries[slot]));
    }
    // Gesto: um traco por punho no ultimo minuto + a contagem.
    const fists = st.fists[slot]; while (fists.length && now - fists[0] > SPARK_MS) fists.shift();
    $(`[data-fists="${slot}"]`).textContent = String(fists.length);
    const g = $(`[data-gesture="${slot}"]`);
    g.replaceChildren(...fists.map((t) => {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', ((SPARK_MS - (now - t)) / SPARK_MS * 238).toFixed(1)); r.setAttribute('y', '0');
      r.setAttribute('width', '2'); r.setAttribute('height', '24');
      return r;
    }));
  }
  // NEU-139: faixa de status (Central, Coletor, Jogo, Nuvem) com o que fazer.
  const LEVEL_WORD = { ok: 'OK', warn: 'Atenção', down: 'Fora', unknown: '—' };
  function renderStrip() {
    const r = S.statusStrip({ status: st.status, health: st.health, overview: st.overview, waitingSince: st.waitingSince, now: Date.now() });
    for (const [g, level] of Object.entries(r.groups)) {
      const ball = $(`[data-ball="${g}"]`); ball.dataset.level = level;
      ball.querySelector('[data-ball-word]').textContent = LEVEL_WORD[level];
    }
    const ul = $('[data-strip-lines]'); ul.replaceChildren();
    for (const line of r.lines) { const li = document.createElement('li'); li.textContent = line; ul.appendChild(li); }
  }
  function renderCloud() {
    const h = st.health; const chip = $('[data-cloud-chip]'); const counts = $('[data-counts]');
    if (!h) { chip.textContent = 'Nuvem: sem resposta do broker'; chip.dataset.on = 'false'; return; }
    const d = h.dispatcher || { enabled: false };
    chip.dataset.on = String(!!d.enabled);
    chip.textContent = d.enabled ? `Nuvem: ligada → ${d.target || '?'}` : 'Nuvem: DESLIGADA';
    const o = st.overview && st.overview.counts;
    if (o) {
      const last = st.overview.lastSentAt ? new Date(Number(st.overview.lastSentAt)).toLocaleTimeString('pt-BR') : '—';
      counts.textContent = `esperando ${o.waiting} · enviando ${o.sending} · falharam ${o.failed} · último envio ok ${last} · descartadas ${h.discardedRaces ?? 0}`;
    } else {
      const c = d.counts || {};
      counts.textContent = `fila ${c.queue ?? '—'} · nova tentativa ${c.retrying ?? '—'} · enviando ${c.processing ?? '—'} · falhas ${c.deadletter ?? '—'} · descartadas ${h.discardedRaces ?? 0}`;
    }
    renderFailed();

    // Dados do Redis/nuvem NUNCA entram como HTML (achado do critico codex): so textContent.
    const tbody = $('[data-history]'); const rows = (st.history || []).slice(0, 10);
    tbody.replaceChildren();
    if (rows.length === 0) {
      const tr = document.createElement('tr'); tr.className = 'empty';
      const td = document.createElement('td'); td.colSpan = 4; td.textContent = 'Nenhuma corrida enviada ainda nesta sessão do broker.';
      tr.appendChild(td); tbody.appendChild(tr); return;
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      const cell = (text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text; tr.appendChild(td); return td; };
      cell(new Date(Number(r.at)).toLocaleTimeString('pt-BR'), 'mono');
      cell(`Jogador ${Number(r.playerId) || '?'}`);
      cell(String(r.email || '—'), 'mono');
      const ok = r.status === 'sent';
      const res = cell(ok ? `Enviada ✓ (${String(r.result || 'ok')})` : `Falhou: ${String(r.reason || 'erro')}`, 'result');
      res.dataset.r = ok ? 'sent' : 'deadletter';
      tbody.appendChild(tr);
    }
  }
  // NEU-143: corridas da dead-letter, com Reenviar. Sem apagar (fica guardada ate reenviar).
  function renderFailed() {
    const tbody = $('[data-failed]'); const rows = (st.overview && st.overview.failed) || [];
    tbody.replaceChildren();
    if (rows.length === 0) {
      const tr = document.createElement('tr'); tr.className = 'empty';
      const td = document.createElement('td'); td.colSpan = 5; td.textContent = st.overview ? 'Nenhuma corrida falhou.' : 'Sem resposta do broker.';
      tr.appendChild(td); tbody.appendChild(tr); return;
    }
    for (const f of rows) {
      const tr = document.createElement('tr');
      const cell = (text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text; tr.appendChild(td); return td; };
      cell(f.failedAt ? new Date(Number(f.failedAt)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—', 'mono');
      cell(`Jogador ${Number(f.playerId) || '?'}`);
      cell(String(f.email || '—'), 'mono');
      cell(S.failureText(f), 'result').dataset.r = 'deadletter';
      const td = cell('');
      if (f.retryable && f.jobId) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn-small'; btn.textContent = 'Reenviar';
        btn.dataset.jobId = String(f.jobId);
        btn.dataset.label = `Jogador ${Number(f.playerId) || '?'} (${String(f.email || 'sem e-mail')})`;
        td.appendChild(btn);
      } else {
        td.className = 'mono'; td.textContent = 'não dá para reenviar';
      }
      tbody.appendChild(tr);
    }
  }
  $('[data-failed]').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-job-id]');
    if (!btn) return;
    const msg = $('[data-requeue-msg]');
    if (!window.confirm(`Reenviar a corrida do ${btn.dataset.label}? Ela volta para a fila de envio.`)) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/dispatch/requeue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: btn.dataset.jobId }) });
      msg.textContent = res.ok ? `Reenviada: ${btn.dataset.label} voltou para a fila.`
        : res.status === 404 ? 'Essa corrida já tinha sido reenviada.'
          : res.status === 409 ? 'Essa corrida não dá para reenviar (registro sem dados originais).'
            : `Falha ao reenviar (${res.status}). Tente de novo.`;
    } catch (e) {
      msg.textContent = 'Sem resposta do broker. Ele está de pé?';
    }
    await refresh();
  });
  function renderBanner() {
    const now = Date.now();
    const signals = { 1: S.signalStatus({ lastPacketAt: st.packets[1] && st.packets[1].at, now, poorSignalLevel: null }), 2: S.signalStatus({ lastPacketAt: st.packets[2] && st.packets[2].at, now, poorSignalLevel: null }) };
    // A faixa de status cobre leitor sem sinal e nuvem atrasada/com falha (NEU-139): fora do banner.
    const list = S.alerts({ session: st.session, health: st.health, signals, now, queueSince: st.queueSince, prevDiscarded: st.prevDiscarded, overview: st.overview })
      .filter((a) => !['signal_lost', 'queue_stuck', 'cloud_failed'].includes(a.code));
    if (socket && !st.socketOk) list.unshift({ level: 'error', code: 'socket_down', text: 'Sem conexão em tempo real com o broker (a tela não vê a corrida).' });
    const banner = $('[data-banner]');
    banner.hidden = list.length === 0;
    banner.dataset.level = list.some((a) => a.level === 'error') ? 'error' : 'warn';
    const ul = $('#banner-list'); ul.replaceChildren();
    for (const a of list) { const li = document.createElement('li'); li.dataset.level = a.level; li.dataset.code = a.code; li.textContent = a.text; ul.appendChild(li); }
  }
  // NEU-141: ultimos jogadores. Contato completo (o painel so abre no PC central, spec D5).
  // Durante a corrida o campo do jogador fica travado (mostra quem esta na pista); os
  // botoes P1/P2 so voltam quando a corrida terminar ("Proximo P1/P2" chega com a NEU-140).
  let recentKey = null;
  function renderRecent() {
    const tbody = $('[data-recent-list]');
    const rows = S.filterRecentPlayers(st.recent, $('[data-recent-search]').value);
    const locked = { 1: $('#email1').readOnly, 2: $('#email2').readOnly };
    // So refaz a tabela quando algo mudou: refazer a cada refresh (2 s) troca o botao no meio
    // do clique e o clique do operador se perde.
    const key = JSON.stringify([rows, locked, (st.recent || []).length]);
    if (key === recentKey) return;
    recentKey = key;
    tbody.replaceChildren();
    if (rows.length === 0) {
      const tr = document.createElement('tr'); tr.className = 'empty';
      const td = document.createElement('td'); td.colSpan = 3;
      td.textContent = (st.recent || []).length ? 'Nenhum contato com essa busca.' : 'Ninguém cadastrado ainda.';
      tr.appendChild(td); tbody.appendChild(tr); return;
    }
    for (const p of rows) {
      const tr = document.createElement('tr');
      const contact = document.createElement('td'); contact.className = 'mono'; contact.textContent = String(p.contact); tr.appendChild(contact);
      const when = document.createElement('td'); when.className = 'mono';
      when.textContent = p.lastAt ? new Date(Number(p.lastAt)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
      tr.appendChild(when);
      const actions = document.createElement('td');
      for (const slot of [1, 2]) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn-small'; btn.textContent = `P${slot}`;
        btn.dataset.fillSlot = String(slot); btn.dataset.contact = String(p.contact);
        btn.disabled = locked[slot];
        btn.title = locked[slot] ? 'Disponível quando a corrida terminar' : `Preencher o Jogador ${slot}`;
        actions.appendChild(btn);
      }
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
  }
  $('[data-recent-search]').addEventListener('input', renderRecent);
  $('[data-recent-list]').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-fill-slot]');
    if (!btn || btn.disabled) return;
    // NEU-86 (spec D2): preencher um lado em Bot volta esse lado para NeuroSky.
    const cur = setupOf(Number(btn.dataset.fillSlot));
    if (cur && cur.source === 'bot' && !(await postSetup('/api/players/source', { player: Number(btn.dataset.fillSlot), source: 'neurosky' }))) return;
    const slot = btn.dataset.fillSlot; const input = $(`#email${slot}`);
    input.value = btn.dataset.contact;
    input.removeAttribute('aria-invalid'); const err = $(`[data-error="${slot}"]`); err.hidden = true; err.textContent = '';
    $('[data-recent-hint]').textContent = `Jogador ${slot}: ${btn.dataset.contact}. Confira e registre.`;
    input.focus();
  });
  $('[data-recent-clear]').addEventListener('click', async () => {
    if (!window.confirm('Apagar a lista de últimos jogadores deste PC? Não dá para desfazer.')) return;
    try {
      const res = await fetch('/api/players/recent/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      $('[data-recent-hint]').textContent = res.ok ? 'Lista apagada.' : `Falha ao apagar (${res.status}).`;
    } catch (e) {
      $('[data-recent-hint]').textContent = 'Sem resposta do broker. Ele está de pé?';
    }
    await refresh();
  });
  // ---------- NEU-86: fonte (NeuroSky | Bot) e camera por jogador ----------
  const setupMsg = { 1: '', 2: '' };
  const setupOf = (slot) => (st.status && st.status.setup && st.status.setup[slot]) || null;
  async function postSetup(path, body) {
    const slot = body.player;
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setupMsg[slot] = res.ok ? '' : res.status === 409 ? 'Corrida em andamento: troque quando ela terminar.' : `Falha ao trocar (${res.status}). Tente de novo.`;
      return res.ok;
    } catch (e) {
      setupMsg[slot] = 'Sem resposta do broker. Ele está de pé?';
      return false;
    } finally { await refresh(); }
  }
  document.querySelectorAll('[data-source-btn]').forEach((btn) => btn.addEventListener('click', () => {
    const slot = Number(btn.dataset.sourceBtn); const cur = setupOf(slot);
    if (btn.disabled || (cur && cur.source === btn.dataset.source)) return;
    postSetup('/api/players/source', { player: slot, source: btn.dataset.source });
  }));
  document.querySelectorAll('[data-camera]').forEach((sel) => sel.addEventListener('change', () => {
    postSetup('/api/players/camera', { player: Number(sel.dataset.camera), camera: Number(sel.value) });
  }));
  function renderSetup() {
    const locked = S.setupLocked({ session: st.session, raceEvents: st.raceEvents, history: st.history, now: Date.now() });
    for (const slot of [1, 2]) {
      const setup = setupOf(slot); const source = setup ? setup.source : null;
      document.querySelectorAll(`[data-source-btn="${slot}"]`).forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.source === source));
        b.disabled = !setup || locked;
        b.title = locked ? 'Travado durante a corrida' : !setup ? 'Sem resposta do broker' : '';
      });
      // Bot desliga o campo de contato (spec B2): nada a cadastrar, nada vai para a nuvem.
      const input = $(`#email${slot}`);
      if (source === 'bot' && !input.disabled) { input.value = ''; input.disabled = true; input.placeholder = 'Bot: não vai para a nuvem'; }
      else if (source !== 'bot' && input.disabled) { input.disabled = false; input.placeholder = 'jogador@exemplo.com'; }
      const piece = st.status && st.status.pieces && st.status.pieces[`gesture-p${slot}`];
      const inUse = piece && piece.connected ? (piece.camera ?? (piece.meta && piece.meta.camera) ?? null) : null;
      const chosen = setup ? setup.camera : null;
      const sel = $(`[data-camera="${slot}"]`);
      sel.disabled = !setup || locked;
      sel.title = locked ? 'Travado durante a corrida' : '';
      // Nao troca o valor enquanto o operador esta com o seletor aberto.
      if (document.activeElement !== sel) sel.value = S.cameraSelectValue({ chosen, inUse });
      const msg = $(`[data-setup-msg="${slot}"]`);
      const text = setupMsg[slot] || S.cameraText({ chosen, inUse, error: piece && piece.cameraError });
      msg.textContent = text; msg.hidden = !text;
    }
  }
  // ---------- NEU-142: abas e Diagnostico ----------
  document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  }));
  const DIAG_KEYS = ['broker', 'redis', 'acquisition-p1', 'gesture-p1', 'jogo', 'acquisition-p2', 'gesture-p2'];
  function renderDiag() {
    const d = S.diagnostics({ status: st.status });
    const byKey = Object.fromEntries(d.pcs.flatMap((pc) => pc.pieces).map((p) => [p.key, p]));
    for (const key of DIAG_KEYS) {
      const el = $(`[data-diag="${key}"]`); const p = byKey[key];
      el.dataset.level = p ? p.level : 'unknown';
      el.querySelector('[data-diag-word]').textContent = p ? p.word : '—';
      el.querySelector('[data-diag-version]').textContent = p ? p.version : '—';
      const line = el.querySelector('[data-diag-line]');
      line.hidden = !(p && p.line); line.textContent = p && p.line ? p.line : '';
      // So refaz a lista quando muda: o <details> continua aberto de qualquer jeito.
      const dl = el.querySelector('[data-diag-details]'); const detailsKey = JSON.stringify(p ? p.details : []);
      if (dl.dataset.key !== detailsKey) {
        dl.dataset.key = detailsKey; dl.replaceChildren();
        for (const [label, value] of (p ? p.details : [])) {
          const dt = document.createElement('dt'); dt.textContent = label;
          const dd = document.createElement('dd'); dd.className = 'mono'; dd.textContent = value;
          dl.append(dt, dd);
        }
      }
    }
  }
  function render() { renderStrip(); renderDiag(); renderCards(); renderSetup(); renderSignal(1); renderSignal(2); renderRecent(); renderCloud(); renderBanner(); }

  setInterval(() => { renderStrip(); renderSignal(1); renderSignal(2); renderBanner(); }, 1000);
  setInterval(refresh, 2000);
  refresh();
}());
