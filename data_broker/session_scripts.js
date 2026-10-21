// data_broker/session_scripts.js
//
// NEU-140: scripts Lua da sessao, atomicos no Redis. WATCH nao serve aqui: o broker usa
// uma conexao so, e o EXEC de qualquer outro trecho desfaz o WATCH. O tests/fake_redis.js
// implementa a mesma logica em JS; os testes de integracao conferem o Lua de verdade.

// Fecha a sessao `id` (Parar = cancelled, 10 min = expired, raceStopped do jogo = stopped)
// e apaga os pacotes dela.
// KEYS: session:current, pacotes P1, pacotes P2. ARGV: id, status, closedAt.
// Devolve 1 se fechou; 0 se a sessao atual e outra (o jogo largou no meio) ou ja fechou.
const CLOSE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'closedAt', ARGV[3])
redis.call('DEL', KEYS[2], KEYS[3])
return 1
`;

// Vincula o contato ao lado N da sessao `id`, so se o lado ainda e `missing` e o hasFinished
// dele nao reivindicou o lado. KEYS: session:current. ARGV: n, email, id.
const LINK_SCRIPT = `
local s = KEYS[1]
local p = 'player' .. ARGV[1]
if redis.call('HGET', s, 'id') ~= ARGV[3] then return 'no_active_session' end
if redis.call('HGET', s, 'status') ~= 'active' then return 'no_active_session' end
if redis.call('HGET', s, p .. 'Kind') ~= 'missing' then return 'not_missing' end
if redis.call('HEXISTS', s, p .. 'Dispatched') == 1 then return 'already_finished' end
redis.call('HSET', s, p .. 'Email', ARGV[2], p .. 'Kind', 'contact', p .. 'IsBot', 'false')
return 'ok'
`;

// Enfileira o resultado do lado N so se a sessao `id` ainda estiver aberta, e apaga a lista
// de pacotes. Atomico contra o CLOSE_SCRIPT: um Parar no meio do hasFinished nao deixa a
// corrida entrar na fila com o painel dizendo "nada foi gravado" (revisao do PR #32).
// KEYS: session:current, dispatch:queue, pacotes do lado. ARGV: id, registro (JSON).
// Devolve 1 se enfileirou; 0 se a sessao atual e outra ou ja fechou.
const ENQUEUE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return 0 end
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[3])
return 1
`;

module.exports = { CLOSE_SCRIPT, LINK_SCRIPT, ENQUEUE_SCRIPT };
