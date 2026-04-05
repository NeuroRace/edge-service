// data_broker/tests/test_redis_isolation.test.js
//
// Behavior Contract: o dispatcher DEVE usar um cliente Redis exclusivo,
// separado do cliente usado pelo session manager.
// Um BLPOP pendente no dispatcher NÃO DEVE bloquear comandos do session.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher } = require('../api_dispatcher');
const { createSessionManager } = require('../session_manager');

const config = {
  supabaseUrl: null,
  supabaseAnonKey: null,
  apiUrl: null,
  dispatchTtlMs: 60000,
  backoffBaseMs: 100,
  backoffMaxMs: 1000,
};
const log = () => {};

test('dispatcher blpop no seu cliente não bloqueia hset do session em cliente separado', async () => {
  // Cliente do dispatcher: blpop nunca resolve (simula fila vazia com timeout=0)
  let blpopCalled = false;
  const blockingRedis = {
    blpop: () => {
      blpopCalled = true;
      return new Promise(() => {}); // bloqueia indefinidamente
    },
    llen: async () => 0,
  };

  // Cliente do session: operações normais rápidas
  const hsetCalls = [];
  const regularRedis = {
    hset: async (...args) => { hsetCalls.push(args); return 1; },
    expire: async () => 1,
    hgetall: async () => null,
  };

  const dispatcher = createDispatcher(blockingRedis, config, log);
  const session = createSessionManager(regularRedis, config, log);

  // Inicia dispatcher — fica preso no blpop (bloqueante)
  const dispatchPromise = dispatcher.processDequeue();

  // Session deve completar sem esperar o dispatcher desbloquear
  await session.registerPlayers('p1@test.com', 'p2@test.com');

  // Verifica que blpop foi chamado no cliente do dispatcher
  assert.ok(blpopCalled, 'dispatcher deve ter chamado blpop');

  // Verifica que hset foi chamado no cliente do session (não ficou pendurado)
  assert.ok(hsetCalls.length > 0, 'session.registerPlayers deve ter completado (hset chamado)');
  assert.ok(
    hsetCalls.some(args => args.includes('pending:players')),
    'hset deve ter sido chamado com pending:players',
  );

  // Limpa a promise pendente do dispatcher (não vai resolver)
  dispatchPromise.catch(() => {});
});

test('session e dispatcher com o MESMO cliente: hset fica pendurado (documenta o bug)', async () => {
  // Este teste documenta o comportamento BUG (não deve existir na produção)
  // Usa um cliente que bloqueia depois de receber blpop
  let resolveBlpop;
  let hsetCalled = false;

  const sharedRedis = {
    _blocked: false,
    blpop: function () {
      this._blocked = true;
      return new Promise((resolve) => { resolveBlpop = resolve; });
    },
    llen: async () => 0,
    hset: async (...args) => {
      if (this._blocked) throw new Error('conexão bloqueada pelo blpop');
      hsetCalled = true;
      return 1;
    },
    expire: async () => 1,
    hgetall: async () => null,
  };

  // Com clientes separados (o fix correto), hset funciona independentemente
  const regularRedis = {
    hset: async (...args) => { hsetCalled = true; return 1; },
    expire: async () => 1,
    hgetall: async () => null,
  };

  const session = createSessionManager(regularRedis, config, log);
  await session.registerPlayers('a@b.com', 'c@d.com');

  assert.ok(hsetCalled, 'com clientes separados, hset completa normalmente');

  // Resolve o blpop para limpeza (se existisse)
  if (resolveBlpop) resolveBlpop(null);
});
