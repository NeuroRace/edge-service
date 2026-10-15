# NEU-140 (plano B) — Registrar com travas, vincular, Parar e sessão que expira — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O operador registra cada lado NeuroSky com contato ou "Sem cadastro" de propósito, vincula o contato a uma corrida que o jogo largou sem registro, para a corrida pelo painel sem gravar nada, e uma sessão esquecida expira sozinha em 10 min.

**Architecture:** `session:current` ganha `playerNKind` (`contact|nosignup|bot|missing`) e os status `cancelled|expired`. Fechar a sessão (Parar/expirar) e vincular viram dois scripts Lua atômicos (`session_scripts.js`); o `onHasFinished` passa a reivindicar o lado antes de ler a sessão. O painel ganha a caixa "Sem cadastro", as travas do Registrar (função pura em `ops_state.js`), o botão Vincular e o Parar em dois passos.

**Tech Stack:** Node 22 (CommonJS), ioredis (`eval`), `node:test`, HTML/JS sem build no `public/`.

**Spec:** `docs/superpowers/specs/2026-10-15-neu-140-registrar-parar-design.md`

## Global Constraints

* Branch `feature/neu-140`, criada da `feature/neu-86` (`7ae0f57`). Nunca commitar na `main`.
* Trailer de commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
* `RACE_LOCK_MS` = 10 min, importado de `public/ops_state.js` (já existe). Nenhuma constante nova de tempo, fora os 5 s da confirmação do Parar.
* Rotas novas: `Content-Type: application/json` obrigatório (`415`), corpo até `MAX_BODY_BYTES` = 4096 (`413`).
* Textos da tela (exatos):
  * caixa: `Sem cadastro`; placeholder com a caixa marcada: `Sem cadastro: não vai para a nuvem`;
  * travas: `P1: digite o contato ou marque Sem cadastro`, `P2: e-mail inválido`, `P1: corrida sem cadastro, use Vincular`;
  * card `missing`: `Sem cadastro nesta corrida`; botão: `Vincular a esta corrida`; card `lost`: `Terminou sem cadastro: não foi salva`;
  * rótulos: `Sem cadastro: não vai para a nuvem` (`nosignup`), `Bot: não vai para a nuvem` (`bot`);
  * alerta: `P1 largou sem cadastro. Digite o contato e clique em Vincular antes de terminar.` (com os dois lados: `P1 e P2 largaram sem cadastro. ...`);
  * Parar: botão `Parar corrida`, confirmação `Confirmar: parar sem gravar?`, dica depois `Corrida parada, nada foi gravado. Pare também no jogo.`
* Testes: `npm --prefix data_broker run validate` (sem Redis: integração pula). Integração: `docker run -d --rm -p 127.0.0.1:6399:6379 --name neu140-redis redis:7-alpine` e `REDIS_URL=redis://127.0.0.1:6399 node --test --test-concurrency=1` dentro de `data_broker`.
* Volume `edge-service_redis-data`: nunca `docker compose down -v`; parar com `stop`.

## Review Focus

1. **Sessão trocada no meio de um fechamento:** um Parar ou uma expiração que lê a sessão A enquanto o jogo larga a B não pode fechar a B. Teste na Task 2 (script recebe o `id` e confere).
2. **Vincular perto do `hasFinished`:** um vínculo gravado entre a chegada do `hasFinished` e o claim tem de consolidar com o e-mail; um vínculo depois do claim responde `already_finished`. Testes na Task 3.
3. **Lado mudou para Bot depois do registro:** o Bot do `players:setup` na largada manda, mesmo com contato no `pending`. E um lado registrado como Bot que voltou a NeuroSky antes da largada vira `missing`, não `bot`. Teste na Task 1.
4. **Corpo estranho nas rotas:** `player` como string `"1"`, `email` número, `player1NoSignup: "true"` (string). `player` string é `invalid_player`; `NoSignup` só vale `true` booleano. Testes na Task 4.
5. **Campo digitado para vincular e o Registrar:** com um lado `missing`, o Registrar trava com `P1: corrida sem cadastro, use Vincular`, para o operador não registrar a próxima dupla achando que vinculou. Teste na Task 5.

---

## File Structure

| Arquivo | Responsabilidade |
| -- | -- |
| `data_broker/session_scripts.js` (novo) | os dois scripts Lua (`CLOSE_SCRIPT`, `LINK_SCRIPT`) |
| `data_broker/session_manager.js` | `kind`, `noSignup`, `readSession` (expira), `stopRace`, `linkPlayer`, eventos ignorados, claim antes da releitura |
| `data_broker/tests/fake_redis.js` | `eval` com a mesma lógica dos dois scripts, em JS |
| `data_broker/http_server.js` | `missing_contact` no `/api/players`; `POST /api/session/link` e `/api/session/stop` |
| `data_broker/public/ops_state.js` | `cardState` com os estados novos, `registerBlockers`, alerta por lado, `setupLocked` com `missing` |
| `data_broker/public/index.html`, `ops.js`, `ops.css` | caixa Sem cadastro, travas, Vincular, Parar |
| `docs/event-contracts.md`, `docs/banca-runbook.md` | contrato e roteiro do operador |

---

### Task 1: `kind` por lado e "Sem cadastro" explícito no registro

**Files:**
- Modify: `data_broker/session_manager.js` (`registerPlayers`, `onRaceStarted`, `getCurrentSession`, novo `kindOf`)
- Modify (migração mecânica): `data_broker/tests/test_session_manager.test.js`, `test_session_integration.test.js`, `test_recent_players.test.js`, `test_no_eeg_discard.test.js`, `test_ops_screen.test.js`, `test_discard_observability.test.js`
- Create: `data_broker/tests/test_session_kinds.test.js`

**Interfaces:**
- Produces:
  * `registerPlayers(p1Email, p2Email, { p1NoSignup = false, p2NoSignup = false } = {})` → como hoje; lança `{ code: 'missing_contact', field }` para lado NeuroSky vazio sem `noSignup`.
  * `pending:players` ganha `player1NoSignup`, `player2NoSignup` (`'true'|'false'`) e `player1Kind`, `player2Kind` (`contact|nosignup|bot`).
  * `session:current` ganha `player1Kind`, `player2Kind`. `playerNIsBot` = `'false'` só para `contact`.
  * `getCurrentSession()` ganha `player1Kind`, `player2Kind`; `pending` ganha `player1Kind`, `player2Kind`.
  * `kindOf(session, n)` (interno): `playerNKind` se válido; senão `IsBot === 'true'` → `bot`, senão `contact`.
  * `onRaceStarted` grava `startedAt` com o `now()` dos hooks (era `Date.now()`), para os testes de expiração da Task 2.

- [ ] **Step 1: Migrar os testes que registram lado vazio como anônimo**

O vazio deixa de ser anônimo. Primeiro as duas `registerPlayers('', '')` (`test_discard_observability.test.js:14` e `test_no_eeg_discard.test.js:81`): esses testes querem "corrida descartada por falta de e-mail", que passa a ser o caso `missing` (ninguém registrou), então a linha **sai**. Depois, onde o teste quer "P2 anônimo", ele passa a marcar Sem cadastro. Rodar em `data_broker/`, nesta ordem:

```bash
sed -i "/await session.registerPlayers('', '');/d" tests/test_discard_observability.test.js tests/test_no_eeg_discard.test.js
for f in tests/test_session_manager.test.js tests/test_session_integration.test.js tests/test_recent_players.test.js tests/test_no_eeg_discard.test.js tests/test_ops_screen.test.js tests/test_discard_observability.test.js; do
  sed -i -E "s/registerPlayers\(('[^']*'|\`[^\`]*\`|[a-z]+), ''\)/registerPlayers(\1, '', { p2NoSignup: true })/" "$f"
done
grep -rn "registerPlayers(" tests/ | grep "''" | grep -v "p2NoSignup"
```

Expected: nenhuma linha (toda chamada com `''` restante tem `{ p2NoSignup: true }`).

Em `tests/test_ops_screen.test.js`, no teste `test_EmailValidated_http_returns_400_invalid_email`, trocar o corpo do segundo POST:

```js
    const ok = await request(port, { method: 'POST', path: '/api/players', body: JSON.stringify({ player1Email: ' A@x.com ', player2Email: '', player2NoSignup: true }) });
```

(Esse teste passa a depender da Task 4, que lê `player2NoSignup` na rota. Até lá ele falha com 400; está listado no Step 4.)

- [ ] **Step 2: Escrever os testes novos**

Create `data_broker/tests/test_session_kinds.test.js`:

```js
// NEU-140 (spec B8a): cada lado entra na corrida como contact, nosignup, bot ou missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { PLAYER_SETUP_KEY } = require('../player_setup');

function make() {
  const redis = new FakeRedis();
  return { redis, session: createSessionManager(redis, {}, () => {}) };
}

test('registro: lado NeuroSky vazio sem Sem cadastro e recusado com missing_contact', async () => {
  const { session } = make();
  await assert.rejects(() => session.registerPlayers('a@x.com', ''), (err) => err.code === 'missing_contact' && err.field === 'player2Email');
  await assert.rejects(() => session.registerPlayers('', 'b@x.com'), (err) => err.code === 'missing_contact' && err.field === 'player1Email');
});

test('registro: Sem cadastro grava kind nosignup no pending', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  const p = await redis.hgetall('pending:players');
  assert.equal(p.player1Kind, 'contact'); assert.equal(p.player1NoSignup, 'false');
  assert.equal(p.player2Kind, 'nosignup'); assert.equal(p.player2NoSignup, 'true');
  const cur = await session.getCurrentSession();
  assert.equal(cur.pending.player1Kind, 'contact'); assert.equal(cur.pending.player2Kind, 'nosignup');
});

test('registro: contato valido ganha de Sem cadastro marcado', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com', { p2NoSignup: true });
  assert.equal((await redis.hgetall('pending:players')).player2Kind, 'contact');
});

test('registro: e-mail invalido continua invalid_email, mesmo com Sem cadastro', async () => {
  const { session } = make();
  await assert.rejects(() => session.registerPlayers('foo', '', { p1NoSignup: true, p2NoSignup: true }), (err) => err.code === 'invalid_email' && err.field === 'player1Email');
});

test('registro: lado em Bot ignora e-mail e Sem cadastro', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', '');
  assert.equal((await redis.hgetall('pending:players')).player2Kind, 'bot');
});

test('largada: cada lado vira o kind certo e IsBot so e false para contact', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.equal(s.player1Kind, 'contact'); assert.equal(s.player1IsBot, 'false');
  assert.equal(s.player2Kind, 'nosignup'); assert.equal(s.player2IsBot, 'true');
  const cur = await session.getCurrentSession();
  assert.equal(cur.player1Kind, 'contact'); assert.equal(cur.player2Kind, 'nosignup');
});

test('largada sem registro: os dois lados ficam missing', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.equal(s.player1Kind, 'missing'); assert.equal(s.player2Kind, 'missing');
  assert.equal(s.player1IsBot, 'true');
});

test('largada: Bot no setup manda, mesmo com contato registrado', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await redis.hset(PLAYER_SETUP_KEY, 'p1Source', 'bot');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.equal(s.player1Kind, 'bot'); assert.equal(s.player1Email, '');
});

test('largada: lado registrado como Bot que voltou a NeuroSky vira missing', async () => {
  const { redis, session } = make();
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'bot');
  await session.registerPlayers('a@x.com', '');
  await redis.hset(PLAYER_SETUP_KEY, 'p2Source', 'neurosky');
  await session.onRaceStarted();
  assert.equal((await redis.hgetall('session:current')).player2Kind, 'missing');
});

test('pending antigo (sem NoSignup) com e-mail vazio vira missing na largada', async () => {
  const { redis, session } = make();
  await redis.hset('pending:players', 'player1Email', 'a@x.com', 'player1Uuid', '', 'player2Email', '', 'player2Uuid', '');
  await session.onRaceStarted();
  const s = await redis.hgetall('session:current');
  assert.equal(s.player1Kind, 'contact'); assert.equal(s.player2Kind, 'missing');
});

test('sessao antiga sem kind: getCurrentSession deriva do IsBot', async () => {
  const { redis, session } = make();
  await redis.hset('session:current', 'id', 's-old', 'startedAt', String(Date.now()), 'status', 'active',
    'player1Email', 'a@x.com', 'player1IsBot', 'false', 'player2Email', '', 'player2IsBot', 'true');
  const cur = await session.getCurrentSession();
  assert.equal(cur.player1Kind, 'contact'); assert.equal(cur.player2Kind, 'bot');
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run (em `data_broker/`): `node --test tests/test_session_kinds.test.js`
Expected: FAIL — `missing_contact` não é lançado (o registro aceita vazio) e `player1Kind` é `undefined`.

- [ ] **Step 4: Implementar**

Em `data_broker/session_manager.js`:

1. Abaixo de `const RECENT_PLAYERS_MAX = 200;`:

```js
// NEU-140 (spec B8a): como cada lado entrou na corrida. So `contact` vai para a nuvem.
const KINDS = ['contact', 'nosignup', 'bot', 'missing'];
function kindOf(session, n) {
  const k = session && session[`player${n}Kind`];
  if (KINDS.includes(k)) return k;
  // Sessao gravada antes da NEU-140: so havia IsBot.
  return session && session[`player${n}IsBot`] === 'true' ? 'bot' : 'contact';
}
```

2. Trocar `registerPlayers` inteiro por:

```js
  // NEU-140: lado NeuroSky vazio so vale com "Sem cadastro" marcado de proposito.
  function sideOf(raw, field, isBot, noSignup) {
    if (isBot) return { email: '', kind: 'bot', noSignup: false };
    const email = checkEmail(raw, field);
    if (email) return { email, kind: 'contact', noSignup: false };
    if (noSignup === true) return { email: '', kind: 'nosignup', noSignup: true };
    const err = new Error(`contato ausente em ${field}`);
    err.code = 'missing_contact';
    err.field = field;
    throw err;
  }

  async function registerPlayers(rawPlayer1Email, rawPlayer2Email, { p1NoSignup = false, p2NoSignup = false } = {}) {
    const bots = await botSlots();
    const side1 = sideOf(rawPlayer1Email, 'player1Email', bots[1], p1NoSignup);
    const side2 = sideOf(rawPlayer2Email, 'player2Email', bots[2], p2NoSignup);
    const player1 = await validateEmailRemote(side1.email);
    const player2 = await validateEmailRemote(side2.email);

    const multi = redis
      .multi()
      .hset(
        'pending:players',
        'player1Email', side1.email,
        'player1Uuid', player1.uuid || '',
        'player1Kind', side1.kind,
        'player1NoSignup', String(side1.noSignup),
        'player2Email', side2.email,
        'player2Uuid', player2.uuid || '',
        'player2Kind', side2.kind,
        'player2NoSignup', String(side2.noSignup),
      )
      .expire('pending:players', 3600);
    // So cadastrados entram na lista (anonimo nunca). Registrar de novo so atualiza o horario.
    const at = now();
    for (const email of [side1.email, side2.email]) if (email) multi.zadd(RECENT_PLAYERS, at, email);
    multi.zremrangebyrank(RECENT_PLAYERS, 0, -(RECENT_PLAYERS_MAX + 1));
    await execMulti(multi);

    log('info', 'session_transition', { from: 'none', to: 'setup' });
    return { player1, player2 };
  }
```

3. Em `onRaceStarted`, trocar o bloco que monta `player1Email`…`player2Uuid` por:

```js
    const pending = (await redis.hgetall('pending:players')) || {};
    const bots = await botSlots();
    // NEU-140: Bot do painel manda; depois contato; depois "Sem cadastro" marcado; senao, esqueceram.
    const sideAt = (n) => {
      if (bots[n]) return { email: '', uuid: '', kind: 'bot' };
      const email = pending[`player${n}Email`] || '';
      if (email) return { email, uuid: pending[`player${n}Uuid`] || '', kind: 'contact' };
      if (pending[`player${n}NoSignup`] === 'true') return { email: '', uuid: '', kind: 'nosignup' };
      return { email: '', uuid: '', kind: 'missing' };
    };
    const p1 = sideAt(1);
    const p2 = sideAt(2);
```

trocar `const startedAt = Date.now();` por `const startedAt = now();`, e o `hset('session:current', ...)` por:

```js
      .hset(
        'session:current',
        'id', id,
        'startedAt', String(startedAt),
        'status', 'active',
        'player1Email', p1.email,
        'player1Uuid', p1.uuid,
        'player1Kind', p1.kind,
        'player1IsBot', p1.kind === 'contact' ? 'false' : 'true',
        'player2Email', p2.email,
        'player2Uuid', p2.uuid,
        'player2Kind', p2.kind,
        'player2IsBot', p2.kind === 'contact' ? 'false' : 'true',
      )
```

e o log `race_started` por:

```js
    log('info', 'race_started', {
      sessionId: id,
      player1Kind: p1.kind,
      player2Kind: p2.kind,
      player1IsBot: p1.kind !== 'contact',
      player2IsBot: p2.kind !== 'contact',
    });
```

4. Em `getCurrentSession`, trocar a montagem de `pending` por:

```js
    const pending = pendingRaw && pendingRaw.player1Email !== undefined
      ? {
        player1Email: pendingRaw.player1Email,
        player2Email: pendingRaw.player2Email,
        player1Kind: pendingRaw.player1Kind || (pendingRaw.player1Email ? 'contact' : 'missing'),
        player2Kind: pendingRaw.player2Kind || (pendingRaw.player2Email ? 'contact' : 'missing'),
      }
      : null;
```

e, no objeto `out`, logo depois de `player2IsBot`:

```js
      player1Kind: kindOf(session, 1),
      player2Kind: kindOf(session, 2),
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/test_session_kinds.test.js` → Expected: PASS (11/11).
Run: `npm run validate` → Expected: tudo verde **exceto** `test_EmailValidated_http_returns_400_invalid_email` (depende da rota da Task 4) e, possivelmente, testes de descarte que contam `onDiscarded` para lado `nosignup` (a regra muda na Task 3). Anotar quais falharam; nenhum outro pode falhar.

- [ ] **Step 6: Commit**

```bash
git add data_broker/session_manager.js data_broker/tests/
git commit -m "feat(broker): cada lado entra como contato, sem cadastro, bot ou esquecido; vazio sem Sem cadastro e recusado [NEU-140]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Parar, expirar em 10 min e eventos de sessão fechada ignorados

**Files:**
- Create: `data_broker/session_scripts.js`
- Modify: `data_broker/session_manager.js` (`readSession`, `stopRace`, `onEsense`, `onHasFinished` (só a checagem de status), `raceInProgress`, `getCurrentSession`)
- Modify: `data_broker/tests/fake_redis.js` (`eval`)
- Create: `data_broker/tests/test_session_close.test.js`

**Interfaces:**
- Consumes: `kindOf(session, n)` (Task 1).
- Produces:
  * `session_scripts.js`: `CLOSE_SCRIPT` (KEYS: `session:current`, pacotes P1, pacotes P2; ARGV: `id`, `status`, `closedAt`) → `1` fechou, `0` não (outra sessão, ou já fechada).
  * `stopRace()` → `{ ok: true, sessionId }` | `{ ok: false, error: 'no_active_session' }`.
  * `readSession(at = now())` (interno) → hash da sessão (já expirada se passou de `RACE_LOCK_MS`) ou `null`.
  * `getCurrentSession().status` pode ser `cancelled` ou `expired`.
  * `raceInProgress(at)` conta lado `contact` ou `missing` sem `Dispatched`, só em sessão `active`.

- [ ] **Step 1: Escrever os testes**

Create `data_broker/tests/test_session_close.test.js`:

```js
// NEU-140 (spec C6, L3): Parar e expirar fecham a sessao; eventos atrasados sao ignorados.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { RACE_LOCK_MS } = require('../public/ops_state');

function make() {
  const redis = new FakeRedis(); const logs = []; const clock = { t: 1_000_000 };
  const session = createSessionManager(redis, {}, (level, message, meta) => logs.push({ level, message, ...meta }), { now: () => clock.t });
  return { redis, session, logs, clock };
}
const esense = (player) => ({ player, source: 'real', attention: 50, timeStamp: 1 });

test('Parar: cancela, apaga pacotes e o hasFinished atrasado nao vai para a fila', async () => {
  const { redis, session, logs } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.onEsense(esense(1));
  assert.deepEqual(await session.stopRace(), { ok: true, sessionId: id });
  const s = await redis.hgetall('session:current');
  assert.equal(s.status, 'cancelled'); assert.ok(s.closedAt);
  assert.equal(await redis.llen(`session:${id}:player:1:packets`), 0);
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
  assert.ok(logs.find((l) => l.message === 'has_finished_ignored_closed_session' && l.status === 'cancelled' && l.playerId === 1));
  assert.ok(logs.find((l) => l.message === 'race_stopped' && l.sessionId === id));
});

test('Parar: a proxima largada consolida normalmente (CA de C6)', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.stopRace();
  await session.onHasFinished({ playerId: 1 });
  await session.registerPlayers('c@x.com', 'd@x.com');
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  await session.onHasFinished({ playerId: 1 });
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1); assert.equal(JSON.parse(queue[0]).payload.email, 'c@x.com');
});

test('Parar: nao mexe na proxima dupla registrada', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.registerPlayers('c@x.com', 'd@x.com');
  await session.stopRace();
  assert.equal((await redis.hgetall('pending:players')).player1Email, 'c@x.com');
});

test('Parar sem corrida aberta: no_active_session', async () => {
  const { session } = make();
  assert.deepEqual(await session.stopRace(), { ok: false, error: 'no_active_session' });
});

test('Parar duas vezes: a segunda e no_active_session', async () => {
  const { session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.stopRace();
  assert.deepEqual(await session.stopRace(), { ok: false, error: 'no_active_session' });
});

test('eSense depois do Parar: nao cria lista e loga uma vez so', async () => {
  const { redis, session, logs } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.stopRace();
  await session.onEsense(esense(1)); await session.onEsense(esense(1)); await session.onEsense(esense(2));
  assert.equal(await redis.llen(`session:${id}:player:1:packets`), 0);
  assert.equal(logs.filter((l) => l.message === 'esense_ignored_closed_session').length, 1);
});

test('expira: com 10 min da largada a sessao vira expired na leitura, uma vez', async () => {
  const { redis, session, logs, clock } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const { id } = await redis.hgetall('session:current');
  await session.onEsense(esense(1));
  clock.t += RACE_LOCK_MS - 1;
  assert.equal((await session.getCurrentSession()).status, 'active');
  clock.t += 1;
  assert.equal((await session.getCurrentSession()).status, 'expired');
  assert.equal((await session.getCurrentSession()).status, 'expired');
  assert.equal(logs.filter((l) => l.message === 'session_expired').length, 1);
  assert.equal(await redis.llen(`session:${id}:player:1:packets`), 0);
});

test('expira: hasFinished depois de 11 min e ignorado', async () => {
  const { redis, session, logs, clock } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  clock.t += 11 * 60 * 1000;
  await session.onHasFinished({ playerId: 1 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
  assert.ok(logs.find((l) => l.message === 'has_finished_ignored_closed_session' && l.status === 'expired'));
});

test('raceInProgress: falso depois do Parar; lado missing conta como humano', async () => {
  const { session, clock } = make();
  await session.onRaceStarted(); // ninguem registrado: os dois missing
  assert.equal(await session.raceInProgress(clock.t + 1000), true);
  await session.stopRace();
  assert.equal(await session.raceInProgress(clock.t + 1000), false);
});

test('fechar nao fecha a sessao nova se o jogo largou no meio (id confere)', async () => {
  const { redis, session } = make();
  await session.registerPlayers('a@x.com', 'b@x.com');
  await session.onRaceStarted();
  const old = await redis.hgetall('session:current');
  // Simula: a leitura do Parar viu a sessao velha, mas o jogo ja largou a nova.
  const realHgetall = redis.hgetall.bind(redis);
  let once = true;
  redis.hgetall = async (key) => {
    if (once && key === 'session:current') {
      once = false;
      const snapshot = await realHgetall(key);
      await session.registerPlayers('c@x.com', 'd@x.com');
      await session.onRaceStarted();
      return snapshot;
    }
    return realHgetall(key);
  };
  const res = await session.stopRace();
  redis.hgetall = realHgetall;
  assert.deepEqual(res, { ok: false, error: 'no_active_session' });
  const cur = await redis.hgetall('session:current');
  assert.notEqual(cur.id, old.id); assert.equal(cur.status, 'active');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/test_session_close.test.js`
Expected: FAIL — `session.stopRace is not a function`.

- [ ] **Step 3: Criar `session_scripts.js`**

Create `data_broker/session_scripts.js`:

```js
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
```

- [ ] **Step 4: `eval` no fake**

Em `data_broker/tests/fake_redis.js`, no topo, depois do `require('node:assert/strict')`:

```js
const { CLOSE_SCRIPT } = require('../session_scripts');
```

e, antes de `multi() {`:

```js
  // Os scripts Lua da sessao (NEU-140), na mesma logica, em JS. Outro script = erro alto.
  async eval(script, numKeys, ...rest) {
    const keys = rest.slice(0, numKeys).map(String);
    const argv = rest.slice(numKeys).map(String);
    const h = this.hashes.get(keys[0]);
    const get = (f) => (h && h.has(f) ? h.get(f) : null);
    if (script === CLOSE_SCRIPT) {
      if (get('id') !== argv[0] || get('status') !== 'active') return 0;
      h.set('status', argv[1]); h.set('closedAt', argv[2]);
      await this.del(keys[1], keys[2]);
      return 1;
    }
    throw new Error('FakeRedis.eval: script desconhecido');
  }
```

- [ ] **Step 5: Implementar no `session_manager.js`**

1. No topo: `const { CLOSE_SCRIPT } = require('./session_scripts');` e, dentro de `createSessionManager`, depois de `minEegPackets`:

```js
  const SESSION_KEY = 'session:current';
  const packetsKey = (id, n) => `session:${id}:player:${n}:packets`;
  // eSense de sessao fechada: um log por sessao, nao um por pacote (1/s por jogador).
  const loggedClosed = new Set();

  // NEU-140: fecha a sessao `id` de forma atomica (so se ainda for a atual e estiver aberta).
  async function closeSession(id, status, at) {
    const closed = await redis.eval(CLOSE_SCRIPT, 3, SESSION_KEY, packetsKey(id, 1), packetsKey(id, 2), id, status, String(at));
    return Number(closed) === 1;
  }

  // Le a sessao atual e aplica a expiracao (spec L3): 10 min da largada = esquecida.
  async function readSession(at = now()) {
    const s = await redis.hgetall(SESSION_KEY);
    if (!s || !s.id) return null;
    if (s.status === 'active' && !(at - Number(s.startedAt) < RACE_LOCK_MS)) {
      if (await closeSession(s.id, 'expired', at)) log('info', 'session_expired', { sessionId: s.id, startedAt: Number(s.startedAt) });
      return redis.hgetall(SESSION_KEY);
    }
    return s;
  }
```

(Na releitura depois do fechamento, `hgetall` pode devolver uma sessão nova se o jogo largou no meio. Isso é o certo: é a sessão atual.)

2. `onEsense`: trocar a leitura da sessão por:

```js
    const session = await readSession();
    if (!session || !session.id) {
      log('warn', 'esense_no_active_session', { player: payload.player });
      return;
    }
    if (session.status !== 'active') {
      if (!loggedClosed.has(session.id)) {
        if (loggedClosed.size > 100) loggedClosed.clear();
        loggedClosed.add(session.id);
        log('warn', 'esense_ignored_closed_session', { sessionId: session.id, status: session.status });
      }
      return;
    }
```

e o `rpush` para usar `packetsKey(session.id, payload.player)`.

3. `onHasFinished`: trocar `const session = await redis.hgetall('session:current');` e o `if (!session || !session.id)` por:

```js
    const session = await readSession();
    if (!session || !session.id) {
      log('warn', 'has_finished_no_active_session', { playerId });
      return;
    }
    if (session.status !== 'active') {
      log('warn', 'has_finished_ignored_closed_session', { playerId, sessionId: session.id, status: session.status });
      return;
    }
```

4. Nova função, antes de `raceInProgress`:

```js
  // NEU-140 (spec C6): Parar. Nada da corrida e gravado; a proxima dupla (pending) fica.
  async function stopRace() {
    const at = now();
    const s = await readSession(at);
    if (!s || s.status !== 'active') return { ok: false, error: 'no_active_session' };
    if (!(await closeSession(s.id, 'cancelled', at))) return { ok: false, error: 'no_active_session' };
    log('info', 'race_stopped', { sessionId: s.id, afterMs: at - Number(s.startedAt) });
    return { ok: true, sessionId: s.id };
  }
```

5. `raceInProgress` inteiro:

```js
  // NEU-86: ha corrida de gente em andamento? Trava a troca de fonte e camera.
  // NEU-140: so sessao aberta; lado esquecido (missing) conta como gente.
  async function raceInProgress(at = now()) {
    const s = await readSession(at);
    if (!s || s.status !== 'active') return false;
    return [1, 2].some((n) => ['contact', 'missing'].includes(kindOf(s, n)) && s[`player${n}Dispatched`] !== 'true');
  }
```

6. `getCurrentSession`: trocar `const session = await redis.hgetall('session:current');` por `const session = await readSession();` e o `if (!session || !session.id)` continua igual.

7. Exportar: incluir `stopRace` no objeto devolvido.

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/test_session_close.test.js` → Expected: PASS (10/10).
Run: `npm run validate` → Expected: as mesmas falhas anotadas na Task 1, nenhuma nova. Se `test_player_setup_session.test.js` (raceInProgress da NEU-86) falhar por passar `at` muito à frente do `startedAt` real, corrigir o teste para usar `hooks.now` (o `startedAt` agora vem do `now()`).

- [ ] **Step 7: Commit**

```bash
git add data_broker/session_scripts.js data_broker/session_manager.js data_broker/tests/fake_redis.js data_broker/tests/test_session_close.test.js data_broker/tests/
git commit -m "feat(broker): Parar cancela a corrida, sessao expira em 10 min e eventos atrasados sao ignorados [NEU-140]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Vincular e claim antes da releitura no `hasFinished`

**Files:**
- Modify: `data_broker/session_scripts.js` (`LINK_SCRIPT`)
- Modify: `data_broker/session_manager.js` (`linkPlayer`, `onHasFinished`)
- Modify: `data_broker/tests/fake_redis.js` (`eval` do `LINK_SCRIPT`)
- Create: `data_broker/tests/test_session_link.test.js`
- Modify: `data_broker/tests/test_session_integration.test.js` (CAs contra Redis real)

**Interfaces:**
- Consumes: `readSession`, `kindOf`, `SESSION_KEY`, `packetsKey` (Tasks 1–2).
- Produces:
  * `LINK_SCRIPT` (KEYS: `session:current`; ARGV: `n`, `email`, `id`) → `'ok'` | `'no_active_session'` | `'not_missing'` | `'already_finished'`.
  * `linkPlayer(player, rawEmail)` → `{ ok: true, session }` | `{ ok: false, error }` com `invalid_player`, `invalid_email`, `no_active_session`, `not_missing`, `already_finished`.
  * `onHasFinished`: reivindica `playerNDispatched` primeiro e relê a sessão. Só `missing` chama `hooks.onDiscarded` (motivo `no_email_registered`, log `has_finished_discarded_bot` como hoje). `bot` e `nosignup` logam `has_finished_not_saved` (`info`, com `kind`) e não chamam o hook.

- [ ] **Step 1: Escrever os testes**

Create `data_broker/tests/test_session_link.test.js`:

```js
// NEU-140: vincular o contato a uma corrida largada sem registro (lado missing).
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');

function make() {
  const redis = new FakeRedis(); const logs = []; const discards = [];
  const session = createSessionManager(redis, {}, (level, message, meta) => logs.push({ level, message, ...meta }), { onDiscarded: (d) => discards.push(d) });
  return { redis, session, logs, discards };
}
const esense = (player) => ({ player, source: 'real', attention: 50, timeStamp: 1 });

test('vincular no meio: o hasFinished consolida com o e-mail vinculado', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  const res = await session.linkPlayer(1, '  Late@X.com ');
  assert.equal(res.ok, true); assert.equal(res.session.player1Kind, 'contact'); assert.equal(res.session.player1Email, 'late@x.com');
  await session.onHasFinished({ playerId: 1 });
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1); assert.equal(JSON.parse(queue[0]).payload.email, 'late@x.com');
  assert.equal((await session.getRecentPlayers())[0].contact, 'late@x.com');
});

test('vincular depois do hasFinished: already_finished e fila sem mudanca', async () => {
  const { redis, session, discards } = make();
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 1 });
  assert.equal(discards.length, 1); assert.equal(discards[0].reason, 'no_email_registered');
  assert.deepEqual(await session.linkPlayer(1, 'late@x.com'), { ok: false, error: 'already_finished' });
  assert.equal(await redis.llen('dispatch:queue'), 0);
});

test('vincular lado que nao e missing: not_missing', async () => {
  const { session } = make();
  await session.registerPlayers('a@x.com', '', { p2NoSignup: true });
  await session.onRaceStarted();
  assert.deepEqual(await session.linkPlayer(1, 'b@x.com'), { ok: false, error: 'not_missing' });
  assert.deepEqual(await session.linkPlayer(2, 'b@x.com'), { ok: false, error: 'not_missing' });
});

test('vincular sem corrida, depois do Parar ou com entrada ruim', async () => {
  const { session } = make();
  assert.deepEqual(await session.linkPlayer(1, 'a@x.com'), { ok: false, error: 'no_active_session' });
  await session.onRaceStarted();
  assert.deepEqual(await session.linkPlayer(3, 'a@x.com'), { ok: false, error: 'invalid_player' });
  assert.deepEqual(await session.linkPlayer('1', 'a@x.com'), { ok: false, error: 'invalid_player' });
  assert.deepEqual(await session.linkPlayer(1, ''), { ok: false, error: 'invalid_email' });
  assert.deepEqual(await session.linkPlayer(1, 'foo'), { ok: false, error: 'invalid_email' });
  await session.stopRace();
  assert.deepEqual(await session.linkPlayer(1, 'a@x.com'), { ok: false, error: 'no_active_session' });
});

test('claim antes da releitura: vinculo gravado entre a chegada do hasFinished e o claim consolida', async () => {
  const { redis, session } = make();
  await session.onRaceStarted();
  await session.onEsense(esense(1));
  const realHsetnx = redis.hsetnx.bind(redis);
  let once = true;
  redis.hsetnx = async (key, field, value) => {
    if (once && field === 'player1Dispatched') { once = false; await session.linkPlayer(1, 'late@x.com'); }
    return realHsetnx(key, field, value);
  };
  await session.onHasFinished({ playerId: 1 });
  redis.hsetnx = realHsetnx;
  const queue = await redis.lrange('dispatch:queue', 0, -1);
  assert.equal(queue.length, 1); assert.equal(JSON.parse(queue[0]).payload.email, 'late@x.com');
});

test('bot e sem cadastro: nao vao para a fila e nao contam como descarte', async () => {
  const { redis, session, logs, discards } = make();
  await session.registerPlayers('', '', { p1NoSignup: true, p2NoSignup: true });
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 1 });
  await session.onHasFinished({ playerId: 2 });
  assert.equal(await redis.llen('dispatch:queue'), 0);
  assert.equal(discards.length, 0);
  assert.equal(logs.filter((l) => l.message === 'has_finished_not_saved' && l.kind === 'nosignup').length, 2);
});

test('hasFinished duplicado de lado missing: um descarte so', async () => {
  const { session, discards } = make();
  await session.onRaceStarted();
  await session.onHasFinished({ playerId: 2 });
  await session.onHasFinished({ playerId: 2 });
  assert.equal(discards.length, 1);
});
```

E acrescentar ao fim de `data_broker/tests/test_session_integration.test.js` (usa o `withRedis` que já existe no arquivo; os testes do arquivo rodam em série):

```js
// NEU-140, contra Redis real: os scripts Lua (vincular, Parar, expirar) e o CA de C6.
test('integracao NEU-140: largou sem registro, vinculou no meio = 1 registro com o e-mail', { skip }, async () => {
  await withRedis(async (redis, session) => {
    await session.onRaceStarted();
    await session.onEsense({ player: 1, source: 'real', attention: 60, timeStamp: 1 });
    assert.equal((await session.linkPlayer(1, 'late@x.com')).ok, true);
    await session.onHasFinished({ playerId: 1 });
    await session.onHasFinished({ playerId: 2 });
    const queue = await redis.lrange('dispatch:queue', 0, -1);
    assert.equal(queue.length, 1); assert.equal(JSON.parse(queue[0]).payload.email, 'late@x.com');
    assert.deepEqual(await session.linkPlayer(2, 'x@x.com'), { ok: false, error: 'already_finished' });
  });
});

test('integracao NEU-140: Parar e depois hasFinished = fila sem mudanca; a proxima consolida (CA C6)', { skip }, async () => {
  await withRedis(async (redis, session) => {
    await session.registerPlayers('a@x.com', 'b@x.com');
    await session.onRaceStarted();
    await session.onEsense({ player: 1, source: 'real', attention: 60, timeStamp: 1 });
    assert.equal((await session.stopRace()).ok, true);
    await session.onHasFinished({ playerId: 1 });
    assert.equal(await redis.llen('dispatch:queue'), 0);
    await session.registerPlayers('c@x.com', '', { p2NoSignup: true });
    await session.onRaceStarted();
    await session.onEsense({ player: 1, source: 'real', attention: 60, timeStamp: 1 });
    await session.onHasFinished({ playerId: 1 });
    assert.equal(JSON.parse((await redis.lrange('dispatch:queue', 0, -1))[0]).payload.email, 'c@x.com');
  });
});

test('integracao NEU-140: fechar confere o id (Lua real)', { skip }, async () => {
  await withRedis(async (redis) => {
    const { CLOSE_SCRIPT } = require('../session_scripts');
    await redis.hset('session:current', 'id', 'novo', 'status', 'active', 'startedAt', '1');
    assert.equal(await redis.eval(CLOSE_SCRIPT, 3, 'session:current', 'p1', 'p2', 'velho', 'cancelled', '2'), 0);
    assert.equal(await redis.hget('session:current', 'status'), 'active');
    assert.equal(await redis.eval(CLOSE_SCRIPT, 3, 'session:current', 'p1', 'p2', 'novo', 'expired', '2'), 1);
    assert.equal(await redis.hget('session:current', 'status'), 'expired');
  });
});
```

(Se o `withRedis` do arquivo não apagar `players:recent`, acrescentar `'players:recent'` à lista `KEYS` dele, para o vínculo não deixar contato de teste no Redis.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/test_session_link.test.js`
Expected: FAIL — `session.linkPlayer is not a function`; o teste "bot e sem cadastro" falha com `discards.length` 2.

- [ ] **Step 3: `LINK_SCRIPT`**

Em `data_broker/session_scripts.js`, antes do `module.exports`:

```js
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
```

e trocar o export por `module.exports = { CLOSE_SCRIPT, LINK_SCRIPT };`.

- [ ] **Step 4: `eval` do vínculo no fake**

Em `tests/fake_redis.js`, trocar o `require` por `const { CLOSE_SCRIPT, LINK_SCRIPT } = require('../session_scripts');` e, dentro de `eval`, antes do `throw`:

```js
    if (script === LINK_SCRIPT) {
      const p = `player${argv[0]}`;
      if (get('id') !== argv[2] || get('status') !== 'active') return 'no_active_session';
      if (get(`${p}Kind`) !== 'missing') return 'not_missing';
      if (h.has(`${p}Dispatched`)) return 'already_finished';
      h.set(`${p}Email`, argv[1]); h.set(`${p}Kind`, 'contact'); h.set(`${p}IsBot`, 'false');
      return 'ok';
    }
```

- [ ] **Step 5: Implementar no `session_manager.js`**

1. `require` passa a `const { CLOSE_SCRIPT, LINK_SCRIPT } = require('./session_scripts');`.

2. Nova função, depois de `stopRace`:

```js
  // NEU-140: o jogo largou sem registro (lado missing); o operador vincula o contato
  // ate o hasFinished daquele lado. Atomico contra o claim do hasFinished (LINK_SCRIPT).
  async function linkPlayer(player, rawEmail) {
    if (player !== 1 && player !== 2) return { ok: false, error: 'invalid_player' };
    const email = normalizeEmail(rawEmail);
    if (!email || !validateEmail(email)) return { ok: false, error: 'invalid_email' };
    const s = await readSession();
    if (!s || s.status !== 'active') return { ok: false, error: 'no_active_session' };
    const result = await redis.eval(LINK_SCRIPT, 1, SESSION_KEY, String(player), email, s.id);
    if (result !== 'ok') return { ok: false, error: String(result) };
    await execMulti(redis.multi().zadd(RECENT_PLAYERS, now(), email).zremrangebyrank(RECENT_PLAYERS, 0, -(RECENT_PLAYERS_MAX + 1)));
    log('info', 'player_linked', { sessionId: s.id, playerId: player });
    return { ok: true, session: await getCurrentSession() };
  }
```

(`typeof rawEmail` não-string: `normalizeEmail` converte com `String()`, e um número vira texto sem `@`, então `invalid_email`.)

3. `onHasFinished`: logo depois do bloco `if (session.status !== 'active') {...}` da Task 2, **trocar** o bloco `if (session[\`player${playerId}IsBot\`] === 'true') {...}` e o claim que vem depois dele por:

```js
    const dispatchedKey = `player${playerId}Dispatched`;

    // Claim atomico primeiro (bug H3: HSETNX), depois a releitura. NEU-140: depois do claim
    // nenhum vinculo grava (LINK_SCRIPT confere o Dispatched), entao a releitura e a verdade.
    const claimed = await redis.hsetnx(SESSION_KEY, dispatchedKey, 'true');
    if (claimed === 0) {
      log('warn', 'has_finished_duplicate', { playerId, sessionId: session.id });
      return;
    }
    const current = await redis.hgetall(SESSION_KEY);
    if (!current || current.id !== session.id || current.status !== 'active') {
      log('warn', 'has_finished_ignored_closed_session', { playerId, sessionId: session.id, status: current && current.status });
      return;
    }

    const kind = kindOf(current, playerId);
    if (kind === 'missing') {
      // NEU-73: largada sem registro — a forma mais provavel de perder a corrida de uma pessoa.
      log('warn', 'has_finished_discarded_bot', {
        playerId, sessionId: session.id, reason: 'no_email_registered',
      });
      if (typeof hooks.onDiscarded === 'function') {
        hooks.onDiscarded({ playerId, sessionId: session.id, reason: 'no_email_registered' });
      }
      return;
    }
    if (kind !== 'contact') {
      // Bot ou "Sem cadastro": escolha do operador, nada a gravar e nada a alertar.
      log('info', 'has_finished_not_saved', { playerId, sessionId: session.id, kind });
      return;
    }
```

No resto da função, trocar as leituras `session[\`player${playerId}Email\`]` e `session[\`player${playerId}Uuid\`]` por `current[...]` (o e-mail vinculado está em `current`), e `packetsKey` local por `packetsKey(session.id, playerId)` (renomear a variável local para `listKey` para não sombrear a função).

4. Exportar `linkPlayer`.

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/test_session_link.test.js` → Expected: PASS (7/7).
Run: `npm run validate` → Expected: só falha `test_EmailValidated_http_returns_400_invalid_email` (Task 4). Os testes de descarte que agora removem o registro (Task 1, Step 1) passam.
Run (integração): subir o `neu140-redis` (Global Constraints) e `REDIS_URL=redis://127.0.0.1:6399 node --test --test-concurrency=1 tests/test_session_integration.test.js` → Expected: PASS, incluindo os 3 novos.

- [ ] **Step 7: Commit**

```bash
git add data_broker/session_scripts.js data_broker/session_manager.js data_broker/tests/
git commit -m "feat(broker): vincular contato a corrida largada sem registro; hasFinished reivindica antes de ler [NEU-140]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Rotas `link`, `stop` e `missing_contact`

**Files:**
- Modify: `data_broker/http_server.js`
- Create: `data_broker/tests/test_session_routes.test.js`

**Interfaces:**
- Consumes: `session.registerPlayers(p1, p2, { p1NoSignup, p2NoSignup })`, `session.linkPlayer(player, email)`, `session.stopRace()`.
- Produces: `POST /api/session/link`, `POST /api/session/stop`; `/api/players` com `400 missing_contact`.

- [ ] **Step 1: Escrever os testes**

Create `data_broker/tests/test_session_routes.test.js`:

```js
// NEU-140: rotas de vincular e parar, e missing_contact no registro.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { FakeRedis } = require('./fake_redis');
const { createSessionManager } = require('../session_manager');
const { createHttpServer } = require('../http_server');

const health = () => ({ status: 'ok' });
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function post(port, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: contentType ? { 'Content-Type': contentType } : {} }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function withServer(fn) {
  const session = createSessionManager(new FakeRedis(), {}, () => {});
  const server = createHttpServer(health, session);
  const port = await listen(server);
  try { await fn(port, session); } finally { server.close(); }
}

test('POST /api/players: vazio sem Sem cadastro = 400 missing_contact; com true booleano = 200', async () => {
  await withServer(async (port) => {
    const bad = await post(port, '/api/players', JSON.stringify({ player1Email: 'a@x.com', player2Email: '' }));
    assert.equal(bad.status, 400); assert.deepEqual(bad.body, { error: 'missing_contact', field: 'player2Email' });
    const str = await post(port, '/api/players', JSON.stringify({ player1Email: 'a@x.com', player2Email: '', player2NoSignup: 'true' }));
    assert.equal(str.status, 400, 'NoSignup so vale true booleano');
    const ok = await post(port, '/api/players', JSON.stringify({ player1Email: 'a@x.com', player2Email: '', player2NoSignup: true }));
    assert.equal(ok.status, 200);
  });
});

test('POST /api/session/stop: 409 sem corrida, 200 com corrida', async () => {
  await withServer(async (port, session) => {
    assert.deepEqual(await post(port, '/api/session/stop', '{}'), { status: 409, body: { ok: false, error: 'no_active_session' } });
    await session.onRaceStarted();
    const res = await post(port, '/api/session/stop', '{}');
    assert.equal(res.status, 200); assert.equal(res.body.ok, true); assert.ok(res.body.sessionId);
  });
});

test('POST /api/session/link: 200, 400 e 409', async () => {
  await withServer(async (port, session) => {
    assert.equal((await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 'a@x.com' }))).status, 409);
    await session.onRaceStarted();
    assert.equal((await post(port, '/api/session/link', JSON.stringify({ player: '1', email: 'a@x.com' }))).body.error, 'invalid_player');
    assert.equal((await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 'foo' }))).status, 400);
    assert.equal((await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 42 }))).body.error, 'invalid_email');
    const ok = await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 'a@x.com' }));
    assert.equal(ok.status, 200); assert.equal(ok.body.session.player1Kind, 'contact');
    const again = await post(port, '/api/session/link', JSON.stringify({ player: 1, email: 'b@x.com' }));
    assert.deepEqual(again, { status: 409, body: { ok: false, error: 'not_missing' } });
  });
});

test('rotas novas: 415 sem JSON, 400 JSON invalido, 413 corpo grande', async () => {
  await withServer(async (port) => {
    for (const path of ['/api/session/link', '/api/session/stop']) {
      assert.equal((await post(port, path, '{}', 'text/plain')).status, 415, path);
      assert.deepEqual((await post(port, path, '{nope')).body, { error: 'invalid_json' }, path);
      assert.equal((await post(port, path, JSON.stringify({ pad: 'x'.repeat(5000) }))).status, 413, path);
    }
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/test_session_routes.test.js`
Expected: FAIL — `/api/players` devolve 200 para o vazio (a rota não repassa `NoSignup` e ainda não mapeia `missing_contact`: hoje cai em 500) e as rotas novas dão 404.

- [ ] **Step 3: Implementar**

Em `data_broker/http_server.js`:

1. Generalizar `handleSetup`: renomear para `handleJsonPost(req, res, log, apply, statusMap, errorTag)`, trocando `SETUP_STATUS` por `statusMap` e `'api_player_setup_error'` por `errorTag`. Nos dois chamadores de hoje (`/api/players/source` e `/api/players/camera`), passar `SETUP_STATUS, 'api_player_setup_error'`. Acrescentar:

```js
const SESSION_STATUS = { invalid_player: 400, invalid_email: 400, no_active_session: 409, not_missing: 409, already_finished: 409 };
```

2. Antes do bloco `if (session && req.method === 'POST' && req.url === '/api/players')`:

```js
    // NEU-140: vincular o contato a uma corrida largada sem registro, e Parar.
    if (session && req.method === 'POST' && req.url === '/api/session/link') {
      handleJsonPost(req, res, log, (data) => session.linkPlayer(data.player, data.email), SESSION_STATUS, 'api_session_link_error');
      return;
    }
    if (session && req.method === 'POST' && req.url === '/api/session/stop') {
      handleJsonPost(req, res, log, () => session.stopRace(), SESSION_STATUS, 'api_session_stop_error');
      return;
    }
```

3. No `/api/players`, trocar a chamada e o tratamento de erro:

```js
        try {
          const result = await session.registerPlayers(player1Email, player2Email, {
            p1NoSignup: data.player1NoSignup === true,
            p2NoSignup: data.player2NoSignup === true,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          if (err && (err.code === 'invalid_email' || err.code === 'missing_contact')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.code, field: err.field }));
            return;
          }
```

(o resto do `catch` continua igual).

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/test_session_routes.test.js` → Expected: PASS (4/4).
Run: `npm run validate` → Expected: tudo verde (inclui `test_EmailValidated_http_returns_400_invalid_email`, que passa a ver o `player2NoSignup`).

- [ ] **Step 5: Commit**

```bash
git add data_broker/http_server.js data_broker/tests/test_session_routes.test.js
git commit -m "feat(broker): rotas de vincular e parar, e missing_contact no registro [NEU-140]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Regras puras do painel (`ops_state.js`)

**Files:**
- Modify: `data_broker/public/ops_state.js` (`cardState`, `setupLocked`, `alerts`, novo `registerBlockers`)
- Modify: `data_broker/tests/test_ops_state.test.js` (expectativas de `anonymous` e do alerta)
- Create: `data_broker/tests/test_ops_state_register.test.js`

**Interfaces:**
- Consumes: `getCurrentSession()` com `playerNKind` e `pending.playerNKind` (Task 1).
- Produces:
  * `cardState(...)` devolve também `nosignup`, `bot`, `missing`, `lost`; nunca mais `anonymous`.
  * `registerBlockers({ 1: { source, email, noSignup, state }, 2: {...} })` → `[{ slot, code, text }]`, `code` ∈ `link_first`, `invalid_email`, `missing_contact`.
  * `alerts(...)`: código `race_missing_contact` no lugar de `race_without_players`.
  * `setupLocked` trava com `racing` ou `missing`.

- [ ] **Step 1: Escrever os testes**

Create `data_broker/tests/test_ops_state_register.test.js`:

```js
// NEU-140: estados novos do card, travas do Registrar e alerta por lado.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/ops_state');

const active = (over = {}) => ({ status: 'active', sessionId: 's1', startedAt: 100, player1Email: '', player2Email: '', player1IsBot: true, player2IsBot: true, ...over });
const card = (slot, session, extra = {}) => S.cardState({ slot, session, pending: null, raceEvents: {}, history: [], ...extra });

test('cardState: pending com kind', () => {
  const pending = { player1Email: 'a@x.com', player2Email: '', player1Kind: 'contact', player2Kind: 'nosignup' };
  assert.equal(S.cardState({ slot: 1, session: { status: 'none' }, pending, raceEvents: {}, history: [] }), 'registered');
  assert.equal(S.cardState({ slot: 2, session: { status: 'none' }, pending, raceEvents: {}, history: [] }), 'nosignup');
  assert.equal(S.cardState({ slot: 2, session: { status: 'none' }, pending: { ...pending, player2Kind: 'bot' }, raceEvents: {}, history: [] }), 'bot');
  assert.equal(S.cardState({ slot: 2, session: { status: 'none' }, pending: { ...pending, player2Kind: 'missing' }, raceEvents: {}, history: [] }), 'waiting');
});

test('cardState: corrida com missing, lost, nosignup e bot', () => {
  const s = active({ player1Kind: 'missing', player2Kind: 'nosignup' });
  assert.equal(card(1, s), 'missing');
  assert.equal(card(1, { ...s, player1Finished: true }), 'lost');
  assert.equal(card(1, s, { raceEvents: { 1: true } }), 'lost');
  assert.equal(card(2, s), 'nosignup');
  assert.equal(card(2, active({ player2Kind: 'bot' })), 'bot');
  assert.equal(card(1, active({ player1Kind: 'contact', player1IsBot: false, player1Email: 'a@x.com' })), 'racing');
});

test('cardState: sessao sem kind (broker antigo) deriva do IsBot', () => {
  assert.equal(card(2, active()), 'bot');
  assert.equal(card(1, active({ player1IsBot: false })), 'racing');
});

test('cardState: sessao cancelled ou expired = waiting', () => {
  assert.equal(card(1, active({ status: 'cancelled', player1Kind: 'contact' })), 'waiting');
  assert.equal(card(1, active({ status: 'expired', player1Kind: 'missing' })), 'waiting');
});

test('setupLocked: lado missing trava; sessao cancelled nao', () => {
  const now = 200;
  assert.equal(S.setupLocked({ session: active({ player1Kind: 'missing', player2Kind: 'bot' }), raceEvents: {}, history: [], now }), true);
  assert.equal(S.setupLocked({ session: active({ status: 'cancelled', player1Kind: 'contact', player1IsBot: false }), raceEvents: {}, history: [], now }), false);
});

test('registerBlockers: contato, vazio, Sem cadastro, invalido, Bot e corrida sem cadastro', () => {
  const ok = { source: 'neurosky', email: 'a@x.com', noSignup: false, state: 'waiting' };
  assert.deepEqual(S.registerBlockers({ 1: ok, 2: ok }), []);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, email: '  ' }, 2: ok }), [{ slot: 1, code: 'missing_contact', text: 'P1: digite o contato ou marque Sem cadastro' }]);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, email: '', noSignup: true }, 2: ok }), []);
  assert.deepEqual(S.registerBlockers({ 1: ok, 2: { ...ok, email: 'foo' } }), [{ slot: 2, code: 'invalid_email', text: 'P2: e-mail inválido' }]);
  assert.deepEqual(S.registerBlockers({ 1: ok, 2: { ...ok, email: 'foo', noSignup: true } }), [{ slot: 2, code: 'invalid_email', text: 'P2: e-mail inválido' }]);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, source: 'bot', email: '' }, 2: ok }), []);
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, source: null, email: '' }, 2: ok }).map((b) => b.code), ['missing_contact'], 'sem resposta do broker = NeuroSky');
  assert.deepEqual(S.registerBlockers({ 1: { ...ok, state: 'missing' }, 2: ok }), [{ slot: 1, code: 'link_first', text: 'P1: corrida sem cadastro, use Vincular' }]);
});

test('alerts: um lado missing acende o alerta daquele lado; dois lados, um alerta so', () => {
  const base = { health: { discardedRaces: 0, dispatcher: { enabled: true, counts: { queue: 0, processing: 0, deadletter: 0 } } }, signals: {}, now: 10_000, queueSince: null, prevDiscarded: 0 };
  const one = S.alerts({ ...base, session: active({ player1Kind: 'missing', player2Kind: 'bot' }) });
  assert.deepEqual(one.map((a) => a.code), ['race_missing_contact']);
  assert.equal(one[0].text, 'P1 largou sem cadastro. Digite o contato e clique em Vincular antes de terminar.');
  const two = S.alerts({ ...base, session: active({ player1Kind: 'missing', player2Kind: 'missing' }) });
  assert.equal(two[0].text, 'P1 e P2 largaram sem cadastro. Digite o contato e clique em Vincular antes de terminar.');
  assert.deepEqual(S.alerts({ ...base, session: active({ player1Kind: 'bot', player2Kind: 'bot' }) }), [], 'bot x bot de proposito nao alerta');
  assert.deepEqual(S.alerts({ ...base, session: active({ player1Kind: 'missing', player1Finished: true, player2Kind: 'bot' }) }), [], 'depois do fim vira descarte, nao Vincular');
});
```

Em `tests/test_ops_state.test.js`:
* no `test_OpsState_cardState_follows_operator_sequence`, os dois `assert.equal(..., 'anonymous')`: o do `pending` (P2 `''` sem kind) passa a esperar `'waiting'`; o da sessão ativa (`player2IsBot: true`, sem kind) passa a esperar `'bot'`;
* no teste de alertas, a sessão `bad` passa a `{ status: 'active', player1IsBot: true, player2IsBot: true, player1Kind: 'missing', player2Kind: 'missing' }`, o código esperado `'race_without_players'` vira `'race_missing_contact'` e o `assert.match(bad[0].text, /NÃO será salva/)` vira `assert.match(bad[0].text, /largaram sem cadastro/)`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/test_ops_state_register.test.js tests/test_ops_state.test.js`
Expected: FAIL — `S.registerBlockers is not a function`; `cardState` devolve `anonymous`.

- [ ] **Step 3: Implementar em `ops_state.js`**

1. `cardState` inteiro:

```js
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
```

2. Em `setupLocked`, trocar `=== 'racing'` por `['racing', 'missing'].includes(cardState({ ... }))`.

3. Nova função, depois de `setupLocked`:

```js
  // NEU-140 (spec B8a, C2 no plano B): Registrar trava com o motivo ao lado. Bot nao tem contato.
  function registerBlockers(slots) {
    const out = [];
    for (const slot of [1, 2]) {
      const s = slots[slot] || {};
      if (s.source === 'bot') continue;
      if (s.state === 'missing') { out.push({ slot, code: 'link_first', text: `P${slot}: corrida sem cadastro, use Vincular` }); continue; }
      const email = normalizeEmail(s.email);
      if (email && !validateEmail(email)) out.push({ slot, code: 'invalid_email', text: `P${slot}: e-mail inválido` });
      else if (!email && s.noSignup !== true) out.push({ slot, code: 'missing_contact', text: `P${slot}: digite o contato ou marque Sem cadastro` });
    }
    return out;
  }
```

4. Em `alerts`, trocar o bloco do `race_without_players` por:

```js
    // NEU-140: alerta por lado; so enquanto da para vincular (antes do hasFinished daquele lado).
    if (session && session.status === 'active') {
      const missing = [1, 2].filter((slot) => cardState({ slot, session, pending: null, raceEvents: null, history: [] }) === 'missing');
      if (missing.length) {
        const who = missing.map((s) => `P${s}`).join(' e ');
        const verb = missing.length === 2 ? 'largaram' : 'largou';
        out.push({ level: 'error', code: 'race_missing_contact', text: `${who} ${verb} sem cadastro. Digite o contato e clique em Vincular antes de terminar.` });
      }
    }
```

5. Acrescentar `registerBlockers` ao objeto exportado no fim do arquivo.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/test_ops_state_register.test.js tests/test_ops_state.test.js` → Expected: PASS.
Run: `npm run validate` → Expected: tudo verde.

- [ ] **Step 5: Commit**

```bash
git add data_broker/public/ops_state.js data_broker/tests/test_ops_state.test.js data_broker/tests/test_ops_state_register.test.js
git commit -m "feat(ops): estados sem cadastro/bot/esquecido no card, travas do Registrar e alerta por lado [NEU-140]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Painel — Sem cadastro, travas, Vincular e Parar

**Files:**
- Modify: `data_broker/public/index.html`, `data_broker/public/ops.js`, `data_broker/public/ops.css`
- Modify: `data_broker/tests/test_ops_screen.test.js`

**Interfaces:**
- Consumes: `S.registerBlockers`, `S.cardState` (Task 5); `POST /api/players` com `playerNNoSignup`, `POST /api/session/link`, `POST /api/session/stop` (Task 4).
- Produces: `data-nosignup="N"`, `data-register-blockers`, `data-link="N"`, `data-stop` no HTML.

- [ ] **Step 1: Escrever o teste de tela**

Em `tests/test_ops_screen.test.js`, dentro do teste que já confere `data-source-btn` (o laço `for (const slot of [1, 2])`), acrescentar:

```js
      assert.match(res.body, new RegExp(`data-nosignup="${slot}"`));
      assert.match(res.body, new RegExp(`data-link="${slot}"`));
```

e, depois do laço:

```js
      assert.match(res.body, /data-register-blockers/);
      assert.match(res.body, /data-stop/);
      assert.doesNotMatch(res.body, /deixe em branco para anônimo/);
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/test_ops_screen.test.js` → Expected: FAIL em `data-nosignup="1"`.

- [ ] **Step 3: HTML**

Em `data_broker/public/index.html`, para cada card (N = 1 e 2), trocar o `<label class="label" for="emailN">E-mail (deixe em branco para anônimo)</label>` por `<label class="label" for="emailN">E-mail</label>` e, logo depois do `<input id="emailN" ...>`, inserir:

```html
          <div class="contact-row">
            <label class="nosignup"><input type="checkbox" data-nosignup="N"> Sem cadastro</label>
            <button type="button" class="btn-small" data-link="N" hidden>Vincular a esta corrida</button>
          </div>
```

E trocar o `<div class="actions">` inteiro por:

```html
        <div class="actions">
          <button type="submit" class="btn-primary" id="register-btn">Registrar jogadores</button>
          <button type="button" class="btn-danger" data-stop hidden>Parar corrida</button>
          <span class="hint mono" id="register-hint">Registre antes da largada. O registro vale por 1 hora.</span>
          <span class="blockers mono" data-register-blockers hidden></span>
        </div>
```

- [ ] **Step 4: CSS**

Em `data_broker/public/ops.css`, no fim:

```css
/* NEU-140: Sem cadastro, travas do Registrar, Vincular e Parar */
.contact-row { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.4rem; flex-wrap: wrap; }
.nosignup { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.85rem; color: var(--fg-muted); cursor: pointer; }
.nosignup[hidden] { display: none; }
.blockers { color: var(--warn); }
.btn-primary[disabled][data-blocked="true"] { cursor: not-allowed; }
.btn-danger { font: inherit; font-weight: 600; background: transparent; color: var(--error); border: 1px solid var(--error); border-radius: 10px; padding: 0.7rem 1.1rem; cursor: pointer; }
.btn-danger[data-armed="true"] { background: var(--error); color: var(--bg); }
.btn-danger:focus-visible { outline: 2px solid var(--fg-strong); outline-offset: 2px; } .btn-danger[disabled] { opacity: 0.6; cursor: wait; }
.card[data-state="missing"] .state-chip, .card[data-state="lost"] .state-chip { color: var(--error); border-color: var(--error); }
```

- [ ] **Step 5: JS (`ops.js`)**

1. Em `STATE_LABEL`, trocar `anonymous: 'Anônimo — não vai para a nuvem'` por:

```js
nosignup: 'Sem cadastro: não vai para a nuvem', bot: 'Bot: não vai para a nuvem', missing: 'Sem cadastro nesta corrida', lost: 'Terminou sem cadastro: não foi salva'
```

2. Novas funções, logo antes de `// ---------- registrar ----------`:

```js
  // ---------- NEU-140: contato, Sem cadastro e travas do Registrar ----------
  const noSignupBox = (slot) => $(`[data-nosignup="${slot}"]`);
  const cardStates = { 1: 'waiting', 2: 'waiting' };
  // Campo de contato: Bot (NEU-86) e Sem cadastro desligam; o resto liga.
  function applyContactField(slot, source) {
    const input = $(`#email${slot}`); const box = noSignupBox(slot);
    box.closest('.nosignup').hidden = source === 'bot';
    if (source === 'bot') box.checked = false;
    const off = source === 'bot' || box.checked;
    if (off && !input.disabled) { input.value = ''; input.disabled = true; }
    else if (!off && input.disabled) input.disabled = false;
    input.placeholder = source === 'bot' ? 'Bot: não vai para a nuvem' : box.checked ? 'Sem cadastro: não vai para a nuvem' : 'jogador@exemplo.com';
  }
  function renderBlockers() {
    const slots = {};
    for (const slot of [1, 2]) {
      const setup = setupOf(slot);
      slots[slot] = { source: setup ? setup.source : null, email: $(`#email${slot}`).value, noSignup: noSignupBox(slot).checked, state: cardStates[slot] };
    }
    const list = S.registerBlockers(slots);
    const el = $('[data-register-blockers]'); const btn = $('#register-btn');
    el.textContent = list.map((b) => b.text).join(' · '); el.hidden = list.length === 0;
    btn.disabled = list.length > 0; btn.dataset.blocked = String(list.length > 0);
    return list;
  }
  for (const slot of [1, 2]) {
    $(`#email${slot}`).addEventListener('input', renderBlockers);
    noSignupBox(slot).addEventListener('change', () => { const s = setupOf(slot); applyContactField(slot, s ? s.source : null); renderBlockers(); });
  }
```

3. No `submit` do formulário:
   * logo depois de `ev.preventDefault();`, inserir `if (renderBlockers().length) return;`;
   * trocar a mensagem `'E-mail inválido. Corrija ou deixe em branco para anônimo.'` por `'E-mail inválido.'`;
   * trocar o `body` do `fetch` por `JSON.stringify({ player1Email: emails[1], player2Email: emails[2], player1NoSignup: noSignupBox(1).checked, player2NoSignup: noSignupBox(2).checked })`;
   * depois do bloco `if (res.status === 400 && body.error === 'invalid_email') {...}`, inserir um `else if`:

```js
      } else if (res.status === 400 && body.error === 'missing_contact') {
        const slot = body.field === 'player2Email' ? 2 : 1;
        const err = $(`[data-error="${slot}"]`); err.textContent = 'Digite o contato ou marque Sem cadastro.'; err.hidden = false;
```

   * no `finally`, trocar `btn.disabled = false;` por `renderBlockers();`.

4. Em `renderCards`, logo depois de `card.dataset.state = state;`, inserir `cardStates[slot] = state;` e, no fim do laço (depois do bloco do `input.readOnly`):

```js
      $(`[data-link="${slot}"]`).hidden = state !== 'missing';
```

e, depois do laço, antes de fechar a função:

```js
    $('[data-stop]').hidden = st.session.status !== 'active';
    renderBlockers();
```

5. Em `renderSetup`, trocar as duas linhas do campo de contato em Bot (`if (source === 'bot' && !input.disabled) {...}` e o `else if`) e a linha `const input = $(\`#email${slot}\`);` por `applyContactField(slot, source);`.

6. No clique dos últimos jogadores (`[data-recent-list]`), logo antes de `input.value = btn.dataset.contact;`, inserir:

```js
    if (noSignupBox(slot).checked) { noSignupBox(slot).checked = false; applyContactField(slot, 'neurosky'); }
```

e, depois de `input.focus();`, `renderBlockers();`.

7. Vincular e Parar, depois do bloco do registrar:

```js
  // ---------- NEU-140: vincular a corrida largada sem registro ----------
  document.querySelectorAll('[data-link]').forEach((btn) => btn.addEventListener('click', async () => {
    const slot = Number(btn.dataset.link); const input = $(`#email${slot}`); const err = $(`[data-error="${slot}"]`);
    const email = S.normalizeEmail(input.value);
    if (!email || !S.validateEmail(email)) { input.setAttribute('aria-invalid', 'true'); err.textContent = 'Digite um e-mail válido para vincular.'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const res = await fetch('/api/session/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player: slot, email }) });
      const body = await res.json().catch(() => ({}));
      const MSG = { already_finished: 'Essa corrida já terminou sem cadastro.', not_missing: 'Esse lado já tem cadastro.', no_active_session: 'Não há corrida em andamento.', invalid_email: 'O broker recusou este e-mail.' };
      if (res.ok) { input.removeAttribute('aria-invalid'); err.hidden = true; err.textContent = ''; $('#register-hint').textContent = `Jogador ${slot} vinculado: ${email}.`; }
      else { err.textContent = MSG[body.error] || `Falha ao vincular (${res.status}).`; err.hidden = false; }
    } catch (e) {
      err.textContent = 'Sem resposta do broker. Ele está de pé?'; err.hidden = false;
    } finally { btn.disabled = false; await refresh(); }
  }));

  // ---------- NEU-140: Parar corrida (dois passos, sem confirm() que trava a tela) ----------
  const stopBtn = $('[data-stop]');
  let stopArmTimer = null;
  function disarmStop() { clearTimeout(stopArmTimer); stopArmTimer = null; stopBtn.dataset.armed = 'false'; stopBtn.textContent = 'Parar corrida'; }
  stopBtn.addEventListener('click', async () => {
    if (stopBtn.dataset.armed !== 'true') {
      stopBtn.dataset.armed = 'true'; stopBtn.textContent = 'Confirmar: parar sem gravar?';
      stopArmTimer = setTimeout(disarmStop, 5000);
      return;
    }
    disarmStop();
    // Contatos da corrida parada: voltam aos campos (sem registrar) se nao ha proxima dupla.
    const stopped = { 1: st.session.player1Kind === 'contact' ? st.session.player1Email : '', 2: st.session.player2Kind === 'contact' ? st.session.player2Email : '' };
    stopBtn.disabled = true;
    try {
      const res = await fetch('/api/session/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      $('#register-hint').textContent = res.ok ? 'Corrida parada, nada foi gravado. Pare também no jogo.' : res.status === 409 ? 'Não há corrida em andamento.' : `Falha ao parar (${res.status}).`;
      await refresh();
      if (res.ok && !st.session.pending && !$('#email1').value && !$('#email2').value) {
        for (const slot of [1, 2]) if (stopped[slot] && !$(`#email${slot}`).disabled) $(`#email${slot}`).value = stopped[slot];
        renderBlockers();
      }
    } catch (e) {
      $('#register-hint').textContent = 'Sem resposta do broker. Ele está de pé?';
    } finally { stopBtn.disabled = false; }
  });
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/test_ops_screen.test.js` → Expected: PASS.
Run: `npm run validate` → Expected: tudo verde.

- [ ] **Step 7: Conferir na tela (perfil `banca`, Playwright)**

Subir: `API_URL= EDGE_INGEST_TOKEN= docker compose --profile banca up -d --build` (na raiz). Conferir `curl -s localhost:3000/health` com `"dispatcher":{"enabled":false`. Abrir `http://localhost:3000/` no Playwright e conferir:
* campos vazios → Registrar desligado com `P1: digite o contato ou marque Sem cadastro · P2: ...`;
* marcar Sem cadastro no P2 e digitar `a@x.com` no P1 → Registrar liga; registrar → P2 "Sem cadastro: não vai para a nuvem";
* Bot no P2 (NEU-86) → a caixa some.

Screenshot em `.playwright-mcp/neu140-registro.png`.

- [ ] **Step 8: Commit**

```bash
git add data_broker/public/ data_broker/tests/test_ops_screen.test.js
git commit -m "feat(ops): Sem cadastro, Registrar travado com o motivo, Vincular e Parar corrida [NEU-140]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs e E2E

**Files:**
- Modify: `docs/event-contracts.md`, `docs/banca-runbook.md`

- [ ] **Step 1: `event-contracts.md`**

Depois da seção `## Comandos do broker para as pecas (NEU-86)`, acrescentar:

```markdown
## Sessao da corrida: sem cadastro, vincular e parar (NEU-140, plano B)

- `POST /api/players` aceita `player1NoSignup`/`player2NoSignup` (so `true` booleano vale). Lado NeuroSky com e-mail vazio **sem** `NoSignup` -> `400 missing_contact` com `field`. Lado em Bot ignora os dois.
- `session:current` ganha `playerNKind`: `contact` (vai para a nuvem), `nosignup` (marcado de proposito), `bot` (escolha do painel), `missing` (o jogo largou sem registro). `playerNIsBot` continua = "nao vai para a nuvem" (`false` so para `contact`).
- `status`: `active`, `cancelled` (Parar) ou `expired` (10 min da largada, `RACE_LOCK_MS`; aplicado na primeira leitura). Em sessao fechada, `eSense` e `hasFinished` sao ignorados com log (`esense_ignored_closed_session`, uma vez por sessao; `has_finished_ignored_closed_session`).
- So `missing` conta como descarte (`/health`, `no_email_registered`). `bot` e `nosignup` logam `has_finished_not_saved`.
- Rotas (JSON obrigatorio, corpo ate 4096 bytes, `413`, `415`):
  - `POST /api/session/link` `{ "player": 1|2, "email" }` -> `200 { ok, session }` · `400 invalid_player|invalid_email|invalid_json` · `409 no_active_session|not_missing|already_finished`. So para lado `missing` antes do `hasFinished` dele;
  - `POST /api/session/stop` `{}` -> `200 { ok, sessionId }` · `409 no_active_session`. Nada da corrida e gravado; a proxima dupla registrada fica.
- `GET /api/session/current` ganha `player1Kind`/`player2Kind` (e `pending.playerNKind`).
- **Limitacao:** o jogo nao manda id de corrida. Um `hasFinished` atrasado que chega **depois da largada seguinte** cai na corrida nova. A solucao (id no `raceStarted`/`hasFinished`) esta na NEU-146.
```

- [ ] **Step 2: `banca-runbook.md`**

Trocar o passo 1 (`1. **Registrar.** ...`) por:

```markdown
1. **Registrar.** Digite o e-mail dos 2 jogadores e clique **Registrar jogadores**. Os cartões ficam **Registrado** (etapa 1 acesa). Quem não quer cadastro: marque **Sem cadastro** no card (a pessoa joga, mas não entra no ranking). Campo vazio sem a caixa marcada trava o Registrar, com o motivo escrito ao lado. O registro vale 1 hora.
   * **O jogo largou sem registro?** O card mostra **Sem cadastro nesta corrida** e o topo fica vermelho. Digite o e-mail e clique **Vincular a esta corrida** antes de a pessoa terminar.
   * **Precisa cancelar?** **Parar corrida** e confirme no mesmo botão. Nada é gravado. **Pare também no jogo** (o painel ainda não manda o jogo parar). Os e-mails voltam para os campos.
```

- [ ] **Step 3: E2E (perfil `banca`, nuvem desligada)**

Com o compose da Task 6 de pé e o `/health` com `dispatcher.enabled:false`, em `data_broker/`:

1. **Vincular:** sem registrar, `node e2e/jogo-falso.js http://localhost:3000 40 1,2`. No painel: os dois cards em "Sem cadastro nesta corrida". Digitar `teste-neu140@exemplo.com` no P1 e Vincular. Esperar o fim. Conferir `docker compose exec redis redis-cli LLEN dispatch:queue` = valor anterior + 1, e o último registro com o e-mail de teste (`LRANGE dispatch:queue -1 -1`). O P2 (sem vínculo) aparece como descarte.
2. **Parar:** registrar `teste-neu140@exemplo.com` + Sem cadastro, `node e2e/jogo-falso.js http://localhost:3000 40 1`, Parar (dois cliques) no meio. Ao fim do jogo falso, `LLEN dispatch:queue` sem mudança e `docker compose logs broker | grep has_finished_ignored_closed_session` com 1 linha.
3. **Próxima larga normal:** registrar de novo e rodar o jogo falso por 10 s: +1 na fila.

Screenshots em `.playwright-mcp/neu140-vincular.png` e `neu140-parar.png`.

**Limpeza (obrigatória):** os registros de teste da fila **não podem subir** (o dispatcher está desligado, mas a fila é do volume real). Remover cada um pelo `jobId` com `LREM dispatch:queue 1 '<json exato>'`; `ZREM players:recent teste-neu140@exemplo.com`; `DEL pending:players`. Conferir `LLEN dispatch:deadletter` = 6 (as corridas de 28/08 intactas). Parar com `docker compose --profile banca stop` (nunca `down -v`).

- [ ] **Step 4: Rodar a suíte inteira e commitar**

Run: `npm --prefix data_broker run validate` → Expected: verde.
Run: `REDIS_URL=redis://127.0.0.1:6399 node --test --test-concurrency=1` (em `data_broker/`) → Expected: tudo pass.

```bash
git add docs/event-contracts.md docs/banca-runbook.md
git commit -m "docs: sem cadastro, vincular, parar e sessao que expira no contrato e no roteiro [NEU-140]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
