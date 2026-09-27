// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine.js');
const { CPU } = require('../src/ai.js');

const { W, H, HIDDEN, block } = E;

function match(a = 'halloween', b = 'ninja', seed = 1) {
  return new E.Match({ chars: [a, b], seed });
}
function fillRow(board, y, hole = -1, kind = 'g') {
  for (let x = 0; x < W; x++) board[y][x] = x === hole ? null : block(kind);
}
function count(board) {
  let n = 0;
  for (const r of board) for (const c of r) if (c) n++;
  return n;
}
function run(m, frames) { for (let i = 0; i < frames && !m.over; i++) m.update(); }

test('shared queue shows 3 pieces and both players draw from it', () => {
  const m = match();
  assert.strictEqual(m.queue.length, 3);
  const next = m.queue[0].type;
  m.players[0].piece = null;
  m.spawn(m.players[0]);
  assert.strictEqual(m.players[0].piece.type, next);
});

test('10 characters x 4 spells, every spell implemented and has text', () => {
  assert.strictEqual(E.CHARACTERS.length, 10);
  for (const c of E.CHARACTERS) {
    assert.strictEqual(c.spells.length, 4);
    for (const s of c.spells) assert.ok(E.SPELL_TEXT[s], 'missing text for ' + s);
  }
});

test('clearing a line with a crystal collects it; Up casts and discards both pieces', () => {
  const m = match();
  const p = m.players[0];
  fillRow(p.board, H - 1, 0);
  p.board[H - 1][5].cr = true;
  p.piece = { id: 99, type: 'I', rot: 1, x: -2, y: 5, crystal: -1 };   // vertical I into column 0
  p.piece.y = E.dropY(p.board, p.piece);
  m.lock(p);
  run(m, 30);
  assert.strictEqual(p.crystals, 1);
  const before = [m.players[0].piece.id, m.players[1].piece.id];
  assert.ok(m.cast(p));
  assert.notStrictEqual(m.players[0].piece.id, before[0]);
  assert.notStrictEqual(m.players[1].piece.id, before[1]);
  assert.strictEqual(p.crystals, 0);
});

test('4-line clear sends 4 garbage lines, applied when the opponent locks', () => {
  const m = match();
  const [p, o] = m.players;
  for (let y = H - 4; y < H; y++) fillRow(p.board, y, 0);
  p.piece = { id: 99, type: 'I', rot: 1, x: -2, y: 5, crystal: -1 };
  p.piece.y = E.dropY(p.board, p.piece);
  m.lock(p);
  run(m, 20);
  assert.strictEqual(o.pendingGarbage[0].n, 4);
  o.piece.y = E.dropY(o.board, o.piece);
  m.lock(o);
  let rows = 0;
  for (let y = 0; y < H; y++) if (o.board[y].filter(Boolean).length === W - 1) rows++;
  assert.strictEqual(rows, 4);
});

test('locking a piece in the vanishing zone tops out', () => {
  const m = match();
  const p = m.players[0];
  for (let y = HIDDEN; y < H; y++) fillRow(p.board, y, y % 2 ? 0 : 9);
  p.piece = { id: 99, type: 'O', rot: 0, x: 4, y: 0, crystal: -1 };
  m.lock(p);
  assert.ok(p.dead);
  assert.strictEqual(m.winner, 1);
});

test('stone rows must be cleared twice', () => {
  const m = match();
  const p = m.players[0];
  fillRow(p.board, H - 1, 0, 's');
  p.piece = { id: 99, type: 'I', rot: 1, x: -2, y: 5, crystal: -1 };
  p.piece.y = E.dropY(p.board, p.piece);
  m.lock(p);
  run(m, 20);
  assert.strictEqual(p.board[H - 1].filter((c) => c && c.k === 'g').length, W - 1);
});

test('Fry rows clear on next lock without sending garbage', () => {
  const m = match('halloween');
  const [p, o] = m.players;
  p.crystals = 1;
  m.cast(p);
  assert.ok(p.board[H - 1].every(Boolean));
  p.piece.y = E.dropY(p.board, p.piece);
  m.lock(p);
  run(m, 20);
  assert.strictEqual(o.pendingGarbage.length, 0);
  assert.ok(p.board[H - 1].some((c) => !c) || p.board[H - 1].every((c) => c && c.k === 'n'));
});

test('every spell runs without error on a busy field', () => {
  for (const ch of E.CHARACTERS) {
    for (let lvl = 1; lvl <= 4; lvl++) {
      const m = match(ch.id, 'bit', lvl * 7);
      for (const q of m.players) for (let y = H - 8; y < H; y++) fillRow(q.board, y, (y * 3) % W);
      m.players[1].board[H - 3][2].cr = true;
      m.players[0].crystals = lvl;
      assert.ok(m.cast(m.players[0]), ch.name + ' lvl ' + lvl);
      for (const q of m.players) for (let y = 0; y < HIDDEN; y++) assert.ok(q.board[y].every((c) => !c));
      run(m, 600);
    }
  }
});

test('specific spell effects', () => {
  let m = match('mirurun');
  m.players[0].crystals = 3; m.cast(m.players[0]);
  assert.strictEqual(m.players[1].pendingGarbage[0].n, 5, 'Pentaris');

  m = match('aladdin');
  fillRow(m.players[0].board, H - 1, 4);
  m.players[0].crystals = 2; m.cast(m.players[0]);           // Shield
  assert.ok(m.players[0].shield > 0, 'Shield');
  m.players[0].crystals = 3; m.cast(m.players[0]);           // Fax
  assert.strictEqual(m.players[1].board[H - 1].filter(Boolean).length, W - 1, 'Fax');

  m = match('princess', 'mirurun');
  m.players[0].crystals = 2; m.cast(m.players[0]);           // Mirror
  m.players[1].crystals = 3; m.cast(m.players[1]);           // Pentaris gets stolen
  assert.strictEqual(m.players[0].pendingGarbage.length, 0);
  assert.strictEqual(m.players[1].pendingGarbage[0].n, 5, 'Mirror steals Pentaris');

  m = match('dragon');
  const a = m.players[0].board; const b = m.players[1].board;
  m.players[0].crystals = 4; m.cast(m.players[0]);
  assert.strictEqual(m.players[0].board, b, 'Change');
  assert.strictEqual(m.players[1].board, a);

  m = match('bit');
  fillRow(m.players[1].board, H - 1, 3);
  m.players[1].board[H - 1][0].cr = true;
  m.players[1].board[H - 1][1].cr = true;
  m.players[0].crystals = 3; m.cast(m.players[0]);
  assert.strictEqual(m.players[0].crystals, 2, 'Gang');

  m = match('ninja');
  fillRow(m.players[1].board, H - 1, 3);
  m.players[0].crystals = 4; m.cast(m.players[0]);
  assert.ok(m.players[1].board[H - 1].filter(Boolean).every((c) => c.k === 's'), 'Medusa');

  m = match('grandprincess');
  fillRow(m.players[0].board, H - 1, 3);
  m.players[0].crystals = 4; m.cast(m.players[0]);
  assert.strictEqual(count(m.players[0].board), 0, 'Clear');

  m = match('dragon');
  m.players[0].crystals = 3; m.cast(m.players[0]);
  const t = m.players[1];
  assert.ok(t.fx.roulette === 3 && t.rouletteMap, 'Roulette');
  assert.ok(Object.keys(t.rouletteMap).some((k) => t.rouletteMap[k] !== k));
});

test('Remote: caster steers opponent piece, own piece frozen', () => {
  const m = match('aladdin');
  const [p, o] = m.players;
  p.crystals = 4; m.cast(p);
  assert.strictEqual(o.remoteBy, 0);
  const ox = o.piece.x, px = p.piece.x;
  m.press(0, 'left');
  assert.strictEqual(o.piece.x, ox - 1);
  assert.strictEqual(p.piece.x, px);
  m.press(1, 'right');
  assert.strictEqual(o.piece.x, ox - 1, 'opponent cannot steer own piece');
});

test('CPU vs CPU plays complete rounds without errors', () => {
  const ids = E.CHARACTERS.map((c) => c.id);
  for (let i = 0; i < 10; i++) {
    const m = new E.Match({ chars: [ids[i], ids[(i + 3) % 10]], seed: 100 + i, crystalCost: 1, startSpeed: 6 });
    const cpus = [new CPU(m, 0, 'hard'), new CPU(m, 1, 'normal')];
    let f = 0;
    while (!m.over && f < 60 * 60 * 8) { cpus[0].update(); cpus[1].update(); m.update(); f++; }
    assert.ok(m.players[0].stats.pieces > 20, 'cpu placed pieces');
  }
});
