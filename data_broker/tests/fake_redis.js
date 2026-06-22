// tests/fake_redis.js
// Double em memoria do subconjunto de Redis usado pelo session_manager E pelo
// dispatcher. Cobre hash ops (HSETNX/HSET/HDEL), list ops da fila confiavel
// (LMOVE/BLMOVE/LREM/LPUSH/RPUSH) e MULTI/EXEC para o claim atomico.
// NAO e um arquivo de teste (sem `.test.`), entao node --test nao o executa.
const { EventEmitter } = require('node:events');

class FakeRedis extends EventEmitter {
  constructor() {
    super();
    this.hashes = new Map(); // key -> Map(field -> value)
    this.lists = new Map(); // key -> string[]
  }

  _hash(key) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key);
  }

  async hset(key, ...args) {
    const h = this._hash(key);
    let pairs = args;
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      pairs = Object.entries(args[0]).flat();
    }
    let added = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      const field = String(pairs[i]);
      if (!h.has(field)) added += 1;
      h.set(field, String(pairs[i + 1]));
    }
    return added;
  }

  async hgetall(key) {
    const h = this.hashes.get(key);
    return h ? Object.fromEntries(h) : {};
  }

  async hsetnx(key, field, value) {
    const h = this._hash(key);
    if (h.has(String(field))) return 0;
    h.set(String(field), String(value));
    return 1;
  }

  async hdel(key, field) {
    const h = this.hashes.get(key);
    return h && h.delete(String(field)) ? 1 : 0;
  }

  async rpush(key, ...values) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    const list = this.lists.get(key);
    for (const v of values) list.push(String(v));
    return list.length;
  }

  async lrange(key, start, stop) {
    const list = this.lists.get(key) || [];
    const len = list.length;
    let s = start < 0 ? len + start : start;
    const e = stop < 0 ? len + stop : stop;
    if (s < 0) s = 0;
    return list.slice(s, e + 1);
  }

  async llen(key) {
    return (this.lists.get(key) || []).length;
  }

  async lpush(key, ...values) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    const list = this.lists.get(key);
    for (const v of values) list.unshift(String(v));
    return list.length;
  }

  async lmove(source, dest, srcDir, destDir) {
    const src = this.lists.get(source) || [];
    if (src.length === 0) return null;
    const val = srcDir === 'LEFT' ? src.shift() : src.pop();
    if (src.length === 0) this.lists.delete(source);
    if (!this.lists.has(dest)) this.lists.set(dest, []);
    const d = this.lists.get(dest);
    if (destDir === 'LEFT') d.unshift(val);
    else d.push(val);
    return val;
  }

  // Fake nao bloqueia: retorna imediatamente (null se vazio). Os testes
  // pre-populam a fila, entao o comportamento bloqueante real e irrelevante aqui.
  async blmove(source, dest, srcDir, destDir, _timeoutSec) {
    return this.lmove(source, dest, srcDir, destDir);
  }

  async lrem(key, count, value) {
    const list = this.lists.get(key);
    if (!list) return 0;
    const v = String(value);
    let removed = 0;
    if (count < 0) {
      for (let i = list.length - 1; i >= 0 && removed < -count; i -= 1) {
        if (list[i] === v) { list.splice(i, 1); removed += 1; }
      }
    } else {
      const limit = count === 0 ? Infinity : count;
      for (let i = 0; i < list.length && removed < limit;) {
        if (list[i] === v) { list.splice(i, 1); removed += 1; }
        else i += 1;
      }
    }
    if (list.length === 0) this.lists.delete(key);
    return removed;
  }

  async del(...keys) {
    let n = 0;
    for (const key of keys) {
      if (this.hashes.delete(key)) n += 1;
      if (this.lists.delete(key)) n += 1;
    }
    return n;
  }

  async expire() {
    return 1; // no-op no fake
  }

  multi() {
    const ops = [];
    const proxy = {};
    const methods = ['hset', 'del', 'rpush', 'expire', 'hsetnx', 'hdel', 'lrange'];
    for (const m of methods) {
      proxy[m] = (...args) => {
        ops.push([m, args]);
        return proxy;
      };
    }
    proxy.exec = async () => {
      const results = [];
      for (const [m, args] of ops) {
        results.push([null, await this[m](...args)]);
      }
      return results;
    };
    return proxy;
  }
}

module.exports = { FakeRedis };
