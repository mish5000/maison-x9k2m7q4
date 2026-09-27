// Computer opponent. Plans a placement for the current piece and presses buttons toward it
// at a speed set by difficulty. It is affected by the same spells as a human.
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.TBS;
  const { W, H, HIDDEN, collides, dropY, pieceCells, rowFull } = E;

  const DIFFICULTY = {
    easy: { delay: 16, mistakes: 0.25 },
    normal: { delay: 9, mistakes: 0.08 },
    hard: { delay: 4, mistakes: 0 },
  };

  function evaluate(board, piece) {
    const b = board.map((r) => r.slice());
    let crystalCleared = 0;
    let topOut = false;
    for (const c of pieceCells(piece)) {
      if (c.y < HIDDEN) topOut = true;
      b[c.y][c.x] = { cr: c.cr };
    }
    let lines = 0;
    for (let y = H - 1; y >= 0; y--) {
      if (rowFull(b[y])) {
        lines++;
        crystalCleared += b[y].filter((c) => c.cr).length;
        b.splice(y, 1);
        b.unshift(new Array(W).fill(null));
        y++;
      }
    }
    const heights = [];
    let holes = 0;
    for (let x = 0; x < W; x++) {
      let h = 0;
      let seen = false;
      for (let y = 0; y < H; y++) {
        if (b[y][x]) { if (!seen) { h = H - y; seen = true; } } else if (seen) holes++;
      }
      heights.push(h);
    }
    let agg = 0, bump = 0, maxH = 0;
    for (let x = 0; x < W; x++) {
      agg += heights[x];
      maxH = Math.max(maxH, heights[x]);
      if (x > 0) bump += Math.abs(heights[x] - heights[x - 1]);
    }
    let score = -0.51 * agg + 0.76 * lines - 0.36 * holes - 0.18 * bump + 2.5 * crystalCleared;
    if (maxH > 14) score -= (maxH - 14) * 2;
    if (topOut) score -= 1000;
    return score;
  }

  // Best (or, for Remote on an enemy piece, worst) reachable placement.
  function plan(board, piece, opts) {
    const rots = opts.canRotate ? [0, 1, 2, 3] : [piece.rot];
    let best = null;
    for (const rot of rots) {
      for (let x = -3; x < W; x++) {
        const q = Object.assign({}, piece, { rot, x, y: piece.y });
        if (collides(board, q)) continue;
        q.y = dropY(board, q);
        let s = evaluate(board, q);
        if (opts.sabotage) s = -s;
        if (!best || s > best.score) best = { rot, x, score: s };
      }
    }
    return best;
  }

  class CPU {
    constructor(match, idx, level) {
      this.m = match;
      this.idx = idx;
      this.cfg = DIFFICULTY[level] || DIFFICULTY.normal;
      this.timer = 0;
      this.target = null;
      this.goalLevel = 2 + Math.floor(Math.random() * 3);
      this.stuck = 0;
    }

    // Which piece do my buttons steer right now?
    steering() {
      const me = this.m.players[this.idx];
      const opp = this.m.players[1 - this.idx];
      if (opp.remoteBy === this.idx) return { p: opp, sabotage: true };
      if (me.remoteBy >= 0) return null;
      return { p: me, sabotage: false };
    }

    // Find the physical button that performs `action` under the current scrambles.
    buttonFor(p, action) {
      for (const b of ['left', 'right', 'rotL', 'rotR']) if (this.m.mapButton(p, b) === action) return b;
      return action;
    }

    update() {
      const m = this.m;
      if (m.over) return;
      const me = m.players[this.idx];
      if (me.dead) return;

      // Spell decision, once per new piece.
      if (me.piece && me.piece.id !== this.lastSeen) {
        this.lastSeen = me.piece.id;
        const lvl = m.level(me);
        const danger = E.stackHeight(me.board) > 13;
        if (lvl >= 1 && (lvl >= this.goalLevel || danger)) {
          m.press(this.idx, 'spell');
          this.goalLevel = 2 + Math.floor(Math.random() * 3);
          return;
        }
      }

      const s = this.steering();
      if (!s || !s.p.piece || s.p.clearing) { m.setSoft(this.idx, false); return; }
      const p = s.p;
      const key = p.idx + ':' + p.piece.id + ':' + p.piece.type;
      if (key !== this.planKey) {
        this.planKey = key;
        this.target = plan(p.board, p.piece, { canRotate: p.fx.paralysis <= 0, sabotage: s.sabotage });
        if (this.target && Math.random() < this.cfg.mistakes) this.target.x += Math.random() < 0.5 ? -1 : 1;
        this.timer = this.cfg.delay;
        this.stuck = 0;
      }
      if (!this.target) return;

      let delay = this.cfg.delay;
      if (m.controlsScrambled(p) || p.fx.dark > 0) delay *= 2;   // confused: slower
      if (--this.timer > 0) return;
      this.timer = delay;

      const cur = p.piece;
      if (cur.rot !== this.target.rot && p.fx.paralysis <= 0) {
        const before = cur.rot;
        m.press(this.idx, this.buttonFor(p, 'rotR'));
        if (p.piece && p.piece.rot === before) this.stuck++;
      } else if (cur.x !== this.target.x) {
        const before = cur.x;
        m.press(this.idx, this.buttonFor(p, cur.x > this.target.x ? 'left' : 'right'));
        if (p.piece && p.piece.x === before) this.stuck++;
      } else {
        // In position: soft drop unless that would spin the piece or would help the enemy (Remote).
        m.setSoft(this.idx, !s.sabotage && p.fx.rotation <= 0);
        return;
      }
      m.setSoft(this.idx, false);
      if (this.stuck > 3) { this.target = { rot: cur.rot, x: cur.x }; }
    }
  }

  const api = { CPU, plan, evaluate, DIFFICULTY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TBSAI = api;
})(typeof window !== 'undefined' ? window : globalThis);
