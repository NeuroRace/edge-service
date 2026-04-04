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
