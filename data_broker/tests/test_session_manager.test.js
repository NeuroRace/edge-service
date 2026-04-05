// data_broker/tests/test_session_manager.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionManager } = require('../session_manager');

function createRedisFake() {
  const hashes = {};
  const lists = {};
  return {
    hashes,
    lists,
    async hset(key, ...args) {
      if (!hashes[key]) hashes[key] = {};
      for (let i = 0; i < args.length; i += 2) {
        hashes[key][args[i]] = args[i + 1];
      }
    },
    async hgetall(key) {
      return hashes[key] || null;
    },
    async del(key) {
      delete hashes[key];
    },
    async expire() {},
    async rpush(key, value) {
      if (!lists[key]) lists[key] = [];
      lists[key].push(value);
    },
    async lrange(key, start, end) {
      const list = lists[key] || [];
      return end === -1 ? list.slice(start) : list.slice(start, end + 1);
    },
    multi() {
      const self = this;
      const ops = [];
      const chain = {
        hset(key, ...args) {
          ops.push({ cmd: 'hset', key, args });
          return chain;
        },
        del(key) {
          ops.push({ cmd: 'del', key });
          return chain;
        },
        async exec() {
          for (const op of ops) {
            if (op.cmd === 'hset') {
              if (!self.hashes[op.key]) self.hashes[op.key] = {};
              for (let i = 0; i < op.args.length; i += 2) {
                self.hashes[op.key][op.args[i]] = op.args[i + 1];
              }
            } else if (op.cmd === 'del') {
              delete self.hashes[op.key];
            }
          }
        },
      };
      return chain;
    },
  };
}

const noopLog = () => {};
const config = {
  supabaseUrl: null,
  supabaseAnonKey: null,
  dispatchTtlMs: 86400000,
};

test('registerPlayers stores emails in pending:players', async () => {
  const redis = createRedisFake();
  const sm = createSessionManager(redis, config, noopLog);

  await sm.registerPlayers('p1@x.com', 'p2@x.com');

  const pending = redis.hashes['pending:players'];
  assert.equal(pending.player1Email, 'p1@x.com');
  assert.equal(pending.player2Email, 'p2@x.com');
});

test('registerPlayers returns validated:false when supabaseUrl not configured', async () => {
  const redis = createRedisFake();
  const sm = createSessionManager(redis, config, noopLog);

  const result = await sm.registerPlayers('p1@x.com', '');

  assert.equal(result.player1.uuid, null);
  assert.equal(result.player1.validated, false);
  assert.equal(result.player2.uuid, null);
  assert.equal(result.player2.validated, false);
});

test('onRaceStarted creates session:current and removes pending:players', async () => {
  const redis = createRedisFake();
  redis.hashes['pending:players'] = {
    player1Email: 'a@x.com',
    player1Uuid: 'uuid-1',
    player2Email: 'b@x.com',
    player2Uuid: '',
  };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onRaceStarted();

  const session = redis.hashes['session:current'];
  assert.ok(session, 'session:current deve existir');
  assert.ok(session.id, 'id deve ser gerado');
  assert.equal(session.status, 'active');
  assert.ok(Number(session.startedAt) > 0, 'startedAt deve ser um timestamp numérico positivo');
  assert.equal(session.player1Email, 'a@x.com');
  assert.equal(session.player1IsBot, 'false');
  assert.equal(session.player2Email, 'b@x.com');
  assert.equal(session.player2IsBot, 'false');
  assert.equal(redis.hashes['pending:players'], undefined, 'pending:players deve ser removido');
});

test('onRaceStarted marca player como bot quando email vazio', async () => {
  const redis = createRedisFake();
  redis.hashes['pending:players'] = {
    player1Email: 'a@x.com',
    player1Uuid: 'uuid-1',
    player2Email: '',
    player2Uuid: '',
  };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onRaceStarted();

  assert.equal(redis.hashes['session:current'].player1IsBot, 'false');
  assert.equal(redis.hashes['session:current'].player2IsBot, 'true');
});

test('onRaceStarted sem pending:players inicia com ambos os players como bot', async () => {
  const redis = createRedisFake();
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onRaceStarted();

  assert.equal(redis.hashes['session:current'].player1IsBot, 'true');
  assert.equal(redis.hashes['session:current'].player2IsBot, 'true');
});

test('onEsense com source:bot não faz RPUSH', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = { id: 'sess-1', status: 'active' };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onEsense({
    player: 1,
    source: 'bot',
    attention: 80,
    meditation: 55,
    eegPower: {},
    poorSignalLevel: 0,
    status: 'ok',
    timeStamp: 1000,
  });

  assert.equal(redis.lists['session:sess-1:player:1:packets'], undefined);
});

test('onEsense com source:real faz RPUSH na lista correta do player', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = { id: 'sess-1', status: 'active' };
  const sm = createSessionManager(redis, config, noopLog);

  const payload = {
    player: 1,
    source: 'real',
    attention: 80,
    meditation: 55,
    eegPower: { delta: 10 },
    poorSignalLevel: 0,
    status: 'ok',
    timeStamp: 1000,
  };
  await sm.onEsense(payload);

  const list = redis.lists['session:sess-1:player:1:packets'];
  assert.equal(list.length, 1);
  assert.deepEqual(JSON.parse(list[0]), payload);
});

test('onHasFinished para player bot não enfileira job', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = {
    id: 'sess-1',
    player1IsBot: 'false',
    player2IsBot: 'true',
  };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onHasFinished({ playerId: 2 });

  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('onHasFinished para player humano enfileira job com payload correto', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = {
    id: 'sess-1',
    startedAt: '1000000000',
    player1IsBot: 'false',
    player1Email: 'p1@x.com',
    player1Uuid: 'uuid-p1',
  };
  const packet = {
    player: 1,
    source: 'real',
    attention: 80,
    meditation: 55,
    eegPower: {},
    poorSignalLevel: 0,
    status: 'ok',
    timeStamp: 1000,
  };
  redis.lists['session:sess-1:player:1:packets'] = [JSON.stringify(packet)];
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onHasFinished({ playerId: 1 });

  const jobs = redis.lists['dispatch:queue'];
  assert.equal(jobs.length, 1);
  const job = JSON.parse(jobs[0]);
  assert.equal(job.playerId, 1);
  assert.equal(job.sessionId, 'sess-1');
  assert.ok(job.expiresAt > Date.now());
  assert.equal(job.attempts, 0);
  assert.ok(job.jobId, 'jobId deve ser um UUID');
  assert.equal(job.payload.email, 'p1@x.com');
  assert.equal(job.payload.playerUuid, 'uuid-p1');
  assert.equal(job.payload.startedAt, 1000000000);
  assert.equal(job.payload.packets.length, 1);
  assert.deepEqual(job.payload.packets[0], packet);
});

test('onHasFinished duplicado é ignorado', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = {
    id: 'sess-1',
    startedAt: '1000000000',
    player1IsBot: 'false',
    player1Email: 'p1@x.com',
    player1Uuid: '',
    player1Dispatched: 'true',
  };
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onHasFinished({ playerId: 1 });

  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('onEsense sem sessão ativa não faz RPUSH', async () => {
  const redis = createRedisFake();
  // sem session:current no Redis
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onEsense({
    player: 1,
    source: 'real',
    attention: 80,
    meditation: 55,
    eegPower: {},
    poorSignalLevel: 0,
    status: 'ok',
    timeStamp: 1000,
  });

  assert.equal(redis.lists['session:undefined:player:1:packets'], undefined);
  // nenhuma lista deve ter sido criada
  assert.equal(Object.keys(redis.lists).length, 0);
});

test('onHasFinished sem sessão ativa não enfileira job', async () => {
  const redis = createRedisFake();
  // sem session:current no Redis
  const sm = createSessionManager(redis, config, noopLog);

  await sm.onHasFinished({ playerId: 1 });

  assert.equal(redis.lists['dispatch:queue'], undefined);
});

test('getCurrentSession retorna status:none quando não há session:current', async () => {
  const redis = createRedisFake();
  const sm = createSessionManager(redis, config, noopLog);

  const result = await sm.getCurrentSession();

  assert.deepEqual(result, { status: 'none' });
});

test('getCurrentSession retorna status e emails quando sessão existe', async () => {
  const redis = createRedisFake();
  redis.hashes['session:current'] = {
    id: 'sess-1',
    status: 'active',
    player1Email: 'p1@x.com',
    player2Email: 'p2@x.com',
  };
  const sm = createSessionManager(redis, config, noopLog);

  const result = await sm.getCurrentSession();

  assert.deepEqual(result, {
    status: 'active',
    player1Email: 'p1@x.com',
    player2Email: 'p2@x.com',
  });
});

test('registerPlayers loga session_transition com to:setup e emails', async () => {
  const redis = createRedisFake();
  const logs = [];
  const sm = createSessionManager(redis, config, (l, m, d) => logs.push({ l, m, d }));

  await sm.registerPlayers('p1@x.com', 'p2@x.com');

  const t = logs.find((entry) => entry.m === 'session_transition');
  assert.ok(t, 'deve existir log session_transition');
  assert.equal(t.d.from, 'none');
  assert.equal(t.d.to, 'setup');
  assert.equal(t.d.player1Email, 'p1@x.com');
  assert.equal(t.d.player2Email, 'p2@x.com');
});

test('onRaceStarted loga session_transition com from:setup to:active e sessionId', async () => {
  const redis = createRedisFake();
  const logs = [];
  redis.hashes['pending:players'] = {
    player1Email: 'a@x.com',
    player1Uuid: '',
    player2Email: 'b@x.com',
    player2Uuid: '',
  };
  const sm = createSessionManager(redis, config, (l, m, d) => logs.push({ l, m, d }));

  await sm.onRaceStarted();

  const t = logs.find((entry) => entry.m === 'session_transition');
  assert.ok(t, 'deve existir log session_transition');
  assert.equal(t.d.from, 'setup');
  assert.equal(t.d.to, 'active');
  assert.match(t.d.sessionId, /^[0-9a-f-]{36}$/, 'sessionId deve ser um UUID');
});

test('onHasFinished para último player loga session_transition com to:finished', async () => {
  const redis = createRedisFake();
  const logs = [];
  redis.hashes['session:current'] = {
    id: 'sess-1',
    startedAt: '1000000000',
    player1IsBot: 'false',
    player1Email: 'p1@x.com',
    player1Uuid: '',
    player2IsBot: 'true', // player 2 é bot → player 1 é o último
  };
  const sm = createSessionManager(redis, config, (l, m, d) => logs.push({ l, m, d }));

  await sm.onHasFinished({ playerId: 1 });

  const t = logs.find((entry) => entry.m === 'session_transition');
  assert.ok(t, 'deve existir log session_transition');
  assert.equal(t.d.from, 'active');
  assert.equal(t.d.to, 'finished');
  assert.equal(t.d.sessionId, 'sess-1');
});

test('onHasFinished loga session_transition com to:finished quando outro player já despachou', async () => {
  const redis = createRedisFake();
  const logs = [];
  redis.hashes['session:current'] = {
    id: 'sess-2',
    startedAt: '1000000000',
    player1IsBot: 'false',
    player1Email: 'p1@x.com',
    player1Uuid: '',
    player2IsBot: 'false',
    player2Email: 'p2@x.com',
    player2Uuid: '',
    player2Dispatched: 'true', // player 2 já terminou
  };
  const sm = createSessionManager(redis, config, (l, m, d) => logs.push({ l, m, d }));

  await sm.onHasFinished({ playerId: 1 });

  const t = logs.find((entry) => entry.m === 'session_transition');
  assert.ok(t, 'deve existir log session_transition');
  assert.equal(t.d.from, 'active');
  assert.equal(t.d.to, 'finished');
  assert.equal(t.d.sessionId, 'sess-2');
});
