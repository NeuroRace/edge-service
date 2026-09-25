const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./jogo-falso');

test('jogo-falso: defaults sao broker local, 30 s e os dois jogadores', () => {
  assert.deepEqual(parseArgs([]), { broker: 'http://localhost:3000', seconds: 30, players: [1, 2] });
});

test('jogo-falso: jogadores viram NUMEROS (contrato hasFinished, NEU-90)', () => {
  const args = parseArgs(['http://192.168.15.20:3000', '45', '1']);
  assert.deepEqual(args, { broker: 'http://192.168.15.20:3000', seconds: 45, players: [1] });
  assert.equal(typeof args.players[0], 'number');
});

test('jogo-falso: recusa segundos invalidos', () => {
  assert.throws(() => parseArgs(['http://localhost:3000', '0']), /segundos/);
  assert.throws(() => parseArgs(['http://localhost:3000', 'abc']), /segundos/);
});

test('jogo-falso: recusa jogador fora de 1 e 2', () => {
  assert.throws(() => parseArgs(['http://localhost:3000', '10', '1,3']), /jogadores/);
});
