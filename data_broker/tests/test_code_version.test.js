// NEU-142: versao = hash curto do codigo (mesmo resultado com CRLF ou LF).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashFiles, brokerCodeVersion } = require('../code_version');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('vetor de referencia (igual ao do Python): df00286', () => {
  const dir = tree({ 'a.py': 'x\r\ny\n', 'sub/b.py': 'z' });
  assert.equal(hashFiles(dir, ['sub/b.py', 'a.py']), 'df00286');
});

test('CRLF e LF dao o mesmo hash; mudar um byte muda; ordem de entrada nao importa', () => {
  const crlf = tree({ 'a.js': 'linha1\r\nlinha2\r\n', 'b.js': 'b' });
  const lf = tree({ 'a.js': 'linha1\nlinha2\n', 'b.js': 'b' });
  const other = tree({ 'a.js': 'linha1\nlinha3\n', 'b.js': 'b' });
  assert.equal(hashFiles(crlf, ['a.js', 'b.js']), hashFiles(lf, ['b.js', 'a.js']));
  assert.notEqual(hashFiles(lf, ['a.js', 'b.js']), hashFiles(other, ['a.js', 'b.js']));
  assert.match(hashFiles(lf, ['a.js', 'b.js']), /^[0-9a-f]{7}$/);
});

test('brokerCodeVersion: so .js da raiz e public/*; tests e node_modules ficam de fora', () => {
  const base = tree({ 'index.js': 'a', 'public/ops.js': 'b', 'tests/x.test.js': 'c', 'node_modules/m/i.js': 'd', 'README.md': 'e' });
  const v = brokerCodeVersion(base);
  assert.equal(v, hashFiles(base, ['index.js', 'public/ops.js']));
  fs.writeFileSync(path.join(base, 'tests/x.test.js'), 'mudou');
  assert.equal(brokerCodeVersion(base), v, 'mudar teste nao muda a versao');
  fs.writeFileSync(path.join(base, 'public/ops.js'), 'mudou');
  assert.notEqual(brokerCodeVersion(base), v);
});

test('brokerCodeVersion do repo real: 7 hex', () => {
  assert.match(brokerCodeVersion(), /^[0-9a-f]{7}$/);
});
