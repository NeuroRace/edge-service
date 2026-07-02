// data_broker/e2e/race-payloads.js
//
// Geradores PUROS de payload para o harness produtor de corrida (NEU-70).
// Sem clock, sem random, sem I/O: mesma entrada -> mesma saida (determinismo),
// para que os testes e as corridas E2E sejam reproduziveis.
//
// Os eventos gerados sao validos nos DOIS contratos da costura edge->cloud:
//  - broker: `../event_contracts.js` (validateEventPayload(tipo, payload))
//  - nuvem : ingest-race `contract.ts` (attention/meditation inteiros 0..100,
//            t inteiro, poor_signal_level null|0..200, signal_status no enum).
// Ver docs/cloud-sync-contract.md e docs/e2e-local-runbook.md.

// Base de tempo fixa (nao Date.now) — determinismo. Valores em ms.
const DEFAULT_BASE_T = 1_000_000;
const DEFAULT_INTERVAL_MS = 200;

// eegPower fixo e plano (o broker exige objeto; a nuvem repassa como jsonb).
const EEG_POWER = { delta: 1, theta: 2, alpha: 3, beta: 4 };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Gera um ponto eSense deterministico para (player, index).
// Faixas escolhidas para satisfazer broker + contrato da nuvem.
function buildEsense({ player, index, baseT = DEFAULT_BASE_T, intervalMs = DEFAULT_INTERVAL_MS }) {
  return {
    player,
    attention: 40 + ((index * 7) % 61), // 40..100, inteiro
    meditation: 30 + ((index * 11) % 51), // 30..80, inteiro
    poorSignalLevel: index % 4 === 0 ? 0 : (index * 13) % 51, // 0..50, inteiro
    eegPower: { ...EEG_POWER },
    source: 'real', // 'bot' nao e persistido pelo session_manager
    timeStamp: baseT + index * intervalMs, // inteiro, crescente
    status: index % 5 === 0 ? 'poor' : 'ok', // enum do contrato
  };
}

// Gera um evento handGesture deterministico (broker exige player + timeStamp).
function buildHandGesture({ player, index, baseT = DEFAULT_BASE_T, intervalMs = DEFAULT_INTERVAL_MS }) {
  return {
    player,
    timeStamp: baseT + index * intervalMs,
  };
}

// Sequencia deterministica de N pontos eSense para um jogador.
function buildTelemetry({ player, points, baseT = DEFAULT_BASE_T, intervalMs = DEFAULT_INTERVAL_MS }) {
  const out = [];
  for (let index = 0; index < points; index += 1) {
    out.push(buildEsense({ player, index, baseT, intervalMs }));
  }
  return out;
}

// Extrai o hostname de uma URL/host, normalizando IPv6 (remove colchetes).
// Trata tambem 'host:port' sem esquema: o WHATWG URL parser interpreta o host
// como esquema (hostname vem vazio), entao re-tentamos prefixando http://.
function hostOf(target) {
  const raw = String(target);
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    host = '';
  }
  if (host === '') {
    try {
      host = new URL(`http://${raw}`).hostname;
    } catch {
      host = raw;
    }
  }
  return host.replace(/^\[|\]$/g, '');
}

// Guard anti-producao: recusa qualquer alvo que nao seja local. Espelha a
// protecao de cloud-backend/scripts/proof-ingest.sh — o harness precisa ser
// INCAPAZ de enviar uma corrida de teste para producao.
function assertLocalTarget(target) {
  const host = hostOf(target);
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`refused_non_local_target: ${host} (o harness so roda contra alvo local)`);
  }
  return target;
}

module.exports = {
  buildEsense,
  buildHandGesture,
  buildTelemetry,
  assertLocalTarget,
  LOCAL_HOSTS,
  DEFAULT_BASE_T,
  DEFAULT_INTERVAL_MS,
};
