// data_broker/session_scripts.js
//
// NEU-140: scripts Lua da sessao, atomicos no Redis. WATCH nao serve aqui: o broker usa
// uma conexao so, e o EXEC de qualquer outro trecho desfaz o WATCH. O tests/fake_redis.js
// implementa a mesma logica em JS; os testes de integracao conferem o Lua de verdade.

// Fecha a sessao `id` (Parar = cancelled, 10 min = expired) e apaga os pacotes dela.
// KEYS: session:current, pacotes P1, pacotes P2. ARGV: id, status, closedAt.
// Devolve 1 se fechou; 0 se a sessao atual e outra (o jogo largou no meio) ou ja fechou.
const CLOSE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'closedAt', ARGV[3])
redis.call('DEL', KEYS[2], KEYS[3])
return 1
`;

module.exports = { CLOSE_SCRIPT };
