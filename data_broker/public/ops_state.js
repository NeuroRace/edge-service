// data_broker/public/ops_state.js — logica PURA da tela de operacao (NEU-68).
// Carregado no browser (window.OpsState) E no Node (session_manager usa a mesma regra
// de e-mail; os testes rodam sem DOM). Sem clock: `now` e sempre injetado.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsState = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // NEU-86: fonte e camera ficam travadas durante a corrida, mas so ate 10 min depois
  // da largada: a sessao nunca expira (L3), e uma corrida esquecida travaria para sempre.
  const RACE_LOCK_MS = 10 * 60 * 1000;

  function normalizeEmail(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  // Vazio = jogador anonimo (permitido, nao vai para a nuvem). Qualquer outra coisa
  // precisa ter formato basico de e-mail (D15: validar no edge, sem consultar a nuvem).
  function validateEmail(value) {
    if (value === '') return true;
    return EMAIL_RE.test(value);
  }

  // NEU-160: e-mail ou celular num campo so. Tem `@` = e-mail; so numeros (com espaco,
  // ponto, traco, parenteses ou +) = celular brasileiro com DDD, guardado como +55DDD9XXXXXXXX.
  // Qualquer outra coisa segue como e-mail (e e recusada como hoje: invalid_email).
  const PHONE_CHARS_RE = /^[\d\s().+-]+$/;
  const DDDS = new Set('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '));

  function phoneError(foreign, digits) {
    if (foreign) return 'só celular do Brasil (+55)';
    if (digits.length === 8 || digits.length === 9) return 'falta o DDD (ex.: 11 98765-4321)';
    if (digits.length === 10) return 'parece telefone fixo: celular tem o 9 depois do DDD';
    if (digits.length !== 11) return 'celular tem 11 números com o DDD (ex.: 11 98765-4321)';
    if (!DDDS.has(digits.slice(0, 2))) return `DDD ${digits.slice(0, 2)} não existe`;
    if (digits[2] !== '9') return 'parece telefone fixo: celular tem o 9 depois do DDD';
    return null;
  }

  // -> { type: 'empty'|'email'|'phone', value, error: null | { code, text } }
  function parseContact(rawValue) {
    const raw = String(rawValue == null ? '' : rawValue).trim();
    if (raw === '') return { type: 'empty', value: '', error: null };
    if (raw.includes('@') || !PHONE_CHARS_RE.test(raw) || !/\d/.test(raw)) {
      const value = normalizeEmail(raw);
      return { type: 'email', value, error: EMAIL_RE.test(value) ? null : { code: 'invalid_email', text: 'e-mail inválido' } };
    }
    // Com `+` o codigo do pais vem na frente e sai sempre ("+55 98765-4321" e falta de DDD,
    // nao DDD 55). Sem `+`: 55 na frente de 11 digitos, ou o 0 da ligacao interurbana.
    let digits = raw.replace(/\D/g, '');
    const foreign = raw.startsWith('+') && !digits.startsWith('55');
    if ((raw.startsWith('+') && !foreign) || (digits.length === 13 && digits.startsWith('55'))) digits = digits.slice(2);
    else if (digits.length === 12 && digits.startsWith('0')) digits = digits.slice(1);
    const text = phoneError(foreign, digits);
    return text ? { type: 'phone', value: digits, error: { code: 'invalid_phone', text } } : { type: 'phone', value: `+55${digits}`, error: null };
  }

  // Celular guardado (+5511987654321) -> "(11) 98765-4321". E-mail volta igual.
  function formatContact(value) {
    const m = /^\+55(\d{2})(\d{5})(\d{4})$/.exec(String(value == null ? '' : value));
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(value == null ? '' : value);
  }

  // Estado do cartao do jogador, na ordem do trabalho do operador:
  // waiting -> registered|nosignup|bot -> racing -> finished -> sent|rejected
  // NEU-140: missing (o jogo largou sem registro; da para Vincular) -> lost (terminou sem).
  function kindOf(session, key) {
    const k = session[`${key}Kind`];
    if (k === 'contact' || k === 'nosignup' || k === 'bot' || k === 'missing') return k;
    return session[`${key}IsBot`] ? 'bot' : 'contact'; // broker anterior a NEU-140
  }
  function cardState({ slot, session, pending, raceEvents, history }) {
    const key = `player${slot}`;
    if (pending && pending[`${key}Email`] !== undefined) {
      if (pending[`${key}Email`]) return 'registered';
      const k = pending[`${key}Kind`];
      return k === 'nosignup' || k === 'bot' ? k : 'waiting';
    }
    if (session && session.status === 'active') {
      const kind = kindOf(session, key);
      const done = Boolean(session[`${key}Finished`] || (raceEvents && raceEvents[slot]));
      if (kind === 'missing') return done ? 'lost' : 'missing';
      if (kind !== 'contact') return kind;
      // Historico da sessao atual manda (a pagina pode ter sido aberta DEPOIS do hasFinished).
      // Correlacao por sessionId — um envio atrasado da corrida anterior nao pode "fechar" a atual.
      // Entradas antigas sem sessionId (broker anterior) caem no criterio de tempo.
      const startedAt = Number(session.startedAt) || 0;
      const mine = (history || []).filter((h) => h.playerId === slot
        && (h.sessionId ? h.sessionId === session.sessionId : Number(h.at) >= startedAt));
      if (mine.length > 0) return mine[0].status === 'sent' ? 'sent' : 'rejected';
      if (done) return 'finished';
      return 'racing';
    }
    return 'waiting';
  }

  // NEU-86 (spec C5): fonte e camera travadas enquanto alguem corre. Mesma janela do
  // broker (RACE_LOCK_MS): uma sessao esquecida de outro dia nao trava para sempre.
  // `pending` fica de fora: registrar a proxima dupla nao destrava a corrida atual.
  function setupLocked({ session, raceEvents, history, now }) {
    if (!session || session.status !== 'active') return false;
    if (!(now - Number(session.startedAt) < RACE_LOCK_MS)) return false;
    return [1, 2].some((slot) => ['racing', 'missing'].includes(cardState({ slot, session, pending: null, raceEvents, history })));
  }

  // NEU-140: Parar armado so vale para a corrida em que foi armado, e so enquanto ela esta aberta.
  function stopArmValid({ armedSessionId, session }) {
    return Boolean(armedSessionId && session && session.status === 'active' && session.sessionId === armedSessionId);
  }

  // NEU-140: campo de contato e caixa "Sem cadastro". Bot (NEU-86) e Sem cadastro desligam o campo;
  // numa corrida sem cadastro (missing) o campo e do Vincular, entao a caixa some e desmarca.
  function contactFieldState({ source, noSignup, state }) {
    const PH = 'e-mail ou celular com DDD';
    if (source === 'bot') return { boxHidden: true, boxChecked: false, disabled: true, placeholder: 'Bot: não vai para a nuvem' };
    if (state === 'missing') return { boxHidden: true, boxChecked: false, disabled: false, placeholder: PH };
    if (noSignup) return { boxHidden: false, boxChecked: true, disabled: true, placeholder: 'Sem cadastro: não vai para a nuvem' };
    return { boxHidden: false, boxChecked: false, disabled: false, placeholder: PH };
  }

  // NEU-140 (spec B8a, C2 no plano B): Registrar trava com o motivo ao lado. Bot nao tem contato.
  function registerBlockers(slots) {
    const out = [];
    for (const slot of [1, 2]) {
      const s = slots[slot] || {};
      if (s.source === 'bot') continue;
      // Revisao do #37: o campo de quem corre fica travado com o contato em uso. Registrar
      // agora mandaria esse contato para a proxima dupla.
      if (s.state === 'racing') { out.push({ slot, code: 'side_racing', text: `P${slot} ainda está correndo: espere a chegada para registrar a próxima dupla` }); continue; }
      if (s.state === 'missing') { out.push({ slot, code: 'link_first', text: `P${slot}: corrida sem cadastro, use Vincular` }); continue; }
      const c = parseContact(s.email);
      if (c.error) out.push({ slot, code: c.error.code, text: `P${slot}: ${c.error.text}` });
      else if (c.type === 'empty' && s.noSignup !== true) out.push({ slot, code: 'missing_contact', text: `P${slot}: digite o contato ou marque Sem cadastro` });
    }
    return out;
  }

  // NEU-141 (spec B9, offline first): o campo do jogador so trava enquanto ele corre, e mostra
  // quem esta na pista. "Terminou" ja libera a proxima dupla, sem esperar o envio a nuvem.
  function contactLocked({ state, hasPending }) {
    return state === 'racing' && !hasPending;
  }

  // NEU-140: Largar = registrar + mandar o jogo largar. Formato do jogo (Thiago, 20/10,
  // NEU-146): { startRace: true, gameMode: 'player' | 'bot' }. 'bot' = o P2 e o bot e a
  // pessoa joga no P1. Dois Bot vao como 'player': os dois carros andam com o EEG simulado.
  function startRacePayload(sources) {
    const bot1 = sources[1] === 'bot'; const bot2 = sources[2] === 'bot';
    return { startRace: true, gameMode: bot2 && !bot1 ? 'bot' : 'player' };
  }

  // Largar trava com o motivo ao lado: as travas do Registrar e mais as do jogo.
  function startBlockers({ register, gameConnected, panelConnected, sessionActive, sources }) {
    // Com corrida em andamento, o "race_active" abaixo ja diz o motivo: um texto so.
    const out = register.filter((b) => !(sessionActive && b.code === 'side_racing'));
    if (sources[1] === 'bot' && sources[2] !== 'bot') out.push({ code: 'human_on_p2', text: 'Com um jogador só, ele joga no P1: ponha o P1 em NeuroSky e o P2 em Bot' });
    if (!panelConnected) out.push({ code: 'panel_offline', text: 'Painel sem conexão com o broker' });
    if (!gameConnected) out.push({ code: 'game_down', text: 'Jogo não conectado' });
    if (sessionActive) out.push({ code: 'race_active', text: 'Já há uma corrida em andamento' });
    return out;
  }

  // O seletor mostra a camera EM USO (a que o detector informa). Mostrar a escolha que
  // falhou enganaria o operador; sem noticia do detector, mostra a escolha guardada.
  function cameraSelectValue({ chosen, inUse }) {
    return String(inUse ?? chosen ?? 0);
  }

  // Linha embaixo do seletor de camera: erro da ultima troca ou troca ainda chegando.
  function cameraText({ chosen, inUse, error }) {
    if (error) return String(error);
    const known = (v) => v !== null && v !== undefined;
    if (known(chosen) && known(inUse) && chosen !== inUse) return `trocando para a Câmera ${Number(chosen) + 1}…`;
    return '';
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
    // NEU-140: alerta por lado; so enquanto da para vincular (antes do hasFinished daquele lado).
    if (session && session.status === 'active') {
      const missing = [1, 2].filter((slot) => cardState({ slot, session, pending: null, raceEvents: null, history: [] }) === 'missing');
      if (missing.length) {
        const who = missing.map((n) => `P${n}`).join(' e ');
        const verb = missing.length === 2 ? 'largaram' : 'largou';
        out.push({ level: 'error', code: 'race_missing_contact', text: `${who} ${verb} sem cadastro. Digite o contato e clique em Vincular antes de terminar.` });
      }
    }
    // Revisao do #41 (NEU-179): chegada ignorada por vir antes do piso. Avisa so enquanto a
    // corrida em que ela caiu estiver aberta: numa corrida curta de verdade, as duas chegadas
    // sao ignoradas e so o Parar libera o painel. Some quando aquele jogador chega de verdade:
    // com o outro ainda correndo, obedecer ao "clique em Parar" perderia a corrida dele.
    const ign = health && health.lastIgnoredFinish;
    if (ign && session && session.status === 'active' && ign.sessionId === session.sessionId && !session[`player${ign.playerId}Finished`]) {
      const secs = (v) => String(Math.round(Number(v) / 100) / 10).replace('.', ',');
      out.push({ level: 'warn', code: 'finish_ignored', text: `Chegada do P${ign.playerId} ignorada: veio ${secs(ign.elapsedMs)} s depois da largada (o mínimo é ${secs(ign.minRaceMs)} s), deve ser da corrida anterior. A corrida segue. Se ela acabou mesmo, clique em Parar corrida.` });
    }
    if (health && Number(health.discardedRaces) > Number(prevDiscarded || 0)) {
      const text = health.lastDiscardReason === 'no_eeg_signal'
        ? 'Uma corrida foi descartada porque o leitor ficou sem sinal de EEG (fone desconectado ou sem contato). Ela não foi para a nuvem — peça para a pessoa correr de novo.'
        : health.lastDiscardReason === 'session_expired'
          ? 'Uma corrida passou de 10 min sem terminar e foi descartada. Ela não foi para a nuvem — peça para a pessoa correr de novo.'
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
  //
  // NEU-151: 'eeg_down' e a peca VIVA com o EEG fora. Ela manda `acquisitionStatus`
  // a cada 2 s, entao o `lastEventAt` fica fresco e ela passaria por 'ok' sem este
  // ramo — operador vendo verde e nenhum dado de EEG chegando.
  function pieceState(piece, now) {
    if (!piece || !piece.connected) return 'down';
    if (piece.eeg === 'connecting') return 'eeg_down';
    if (piece.lastEventAt === null || piece.lastEventAt === undefined || now - piece.lastEventAt > STALE_MS) return 'stale';
    return 'ok';
  }

  function pieceLine(key, state) {
    const pc = PIECE_PC[key];
    const player = key.slice(-2).toUpperCase();
    if (key.startsWith('acquisition')) {
      // NEU-151: os tres casos agora se distinguem, porque a acquisition conecta no
      // broker ANTES do EEG e segue conectada quando o EEG cai.
      if (state === 'down') return `${key} desligado · suba as peças do ${pc}`;
      if (state === 'eeg_down') return `ThinkGear do ${player} fechado · abra o ThinkGear Connector no ${pc}`;
      return `${key} sem dados · confira o fone do ${player} no ${pc}`;
    }
    return state === 'down' ? `${key} desligado · abra o detector de gesto no ${pc}` : `${key} sem notícia · reinicie o detector de gesto no ${pc}`;
  }

  // Spec A1: vermelho quando nenhuma peca do grupo responde. "Sem noticia" conta: com o PC
  // congelado ou o cabo puxado, as pecas seguem conectadas ate o ping cair (~44 s).
  // ThinkGear fechado (eeg_down) prova que o PC responde, entao nao conta.
  function groupLevel(states) {
    if (states.every((s) => s === 'ok')) return 'ok';
    if (states.every((s) => s === 'down' || s === 'stale')) return 'down';
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
  const DIAG_WORD = { ok: 'OK', stale: 'Sem notícia', down: 'Fora', eeg_down: 'ThinkGear fora' };
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
      // NEU-151: estado do EEG e o ultimo erro entram no bloco da acquisition — e o
      // que diz ao operador se o problema e o ThinkGear, o fone ou a peca.
      const details = key.startsWith('acquisition')
        ? [['fonte', dash(p.source ?? meta.source)], ['ThinkGear', meta.eegHost ? `${meta.eegHost}:${dash(meta.acqPort)}` : '—'], ['EEG', p.eeg === 'connecting' ? 'conectando' : p.eeg === 'connected' ? 'conectado' : '—'], ['último erro', dash(p.lastError)], ['Poor Signal', dash(p.poorSignalLevel)], ['atenção', dash(p.attention)], ['último dado', ago(age)]]
        : [['câmera', (p.camera ?? meta.camera) === undefined || (p.camera ?? meta.camera) === null ? '—' : `Câmera ${Number(p.camera ?? meta.camera) + 1}`], ['mão vista', p.handSeen === null || p.handSeen === undefined ? '—' : p.handSeen ? 'sim' : 'não'], ['última notícia', ago(age)]];
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
  // NEU-160: busca so de numeros compara so os digitos, para achar o celular digitado de
  // qualquer jeito ("(11) 98765", "+55 11 9876").
  function filterRecentPlayers(list, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const items = Array.isArray(list) ? list : [];
    if (!q) return items;
    if (PHONE_CHARS_RE.test(q) && /\d/.test(q)) {
      const d = q.replace(/\D/g, '');
      return items.filter((p) => String(p.contact || '').replace(/\D/g, '').includes(d));
    }
    return items.filter((p) => String(p.contact || '').toLowerCase().includes(q));
  }

  // Revisao do #36: depois do Parar, diz quem ja tinha o tempo gravado (estava na fila antes do Parar).
  function stopFeedback({ saved, told }) {
    const tail = told ? 'O jogo volta para a espera.' : 'Pare também no jogo.';
    const s = Array.isArray(saved) ? saved.filter((n) => n === 1 || n === 2) : [];
    if (s.length === 0) return `Corrida parada, nada foi gravado. ${tail}`;
    if (s.length === 2) return `Corrida parada. Os tempos do P1 e do P2 já tinham sido gravados e vão para o site. ${tail}`;
    const other = s[0] === 1 ? 2 : 1;
    return `Corrida parada. O tempo do P${s[0]} já tinha sido gravado e vai para o site; o do P${other} não foi gravado. ${tail}`;
  }

  return { stopFeedback, normalizeEmail, validateEmail, parseContact, formatContact,cardState, signalStatus, alerts, failureText, cloudNeedsAttention, pendingCount, statusStrip, pslLevel, filterRecentPlayers, diagnostics, versionWarnings, QUEUE_STUCK_MS, STALE_MS, RACE_LOCK_MS, setupLocked, registerBlockers, contactLocked, startRacePayload, startBlockers, stopArmValid, contactFieldState, cameraText, cameraSelectValue };
}));
