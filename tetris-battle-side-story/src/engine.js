// Rules engine: board, pieces, shared queue, crystals, garbage and all 40 spells.
// Plain script (no build step). Works in the browser (window.TBS) and in Node (module.exports).
(function (root) {
  'use strict';

  // ---- Constants ---------------------------------------------------------
  const W = 10;
  const H = 22;          // 20 visible rows + 2 hidden "vanishing zone" rows
  const HIDDEN = 2;
  const FPS = 60;

  // Garbage sent per number of lines cleared at once.
  // ASSUMPTION: sources only say "clearing two or more lines sends garbage".
  const GARBAGE_TABLE = [0, 0, 1, 2, 4];

  const CRYSTAL_CHANCE = 0.25;   // ASSUMPTION: share of pieces that carry a crystal
  const LOCK_DELAY = 30;         // frames a grounded piece waits before locking
  const CLEAR_DELAY = 18;        // frames of line-clear flash
  const SHIELD_FRAMES = 10 * FPS;  // "a short time" -> 10 s (assumption)
  const PALS_FRAMES = 10 * FPS;    // "a short time" -> 10 s (assumption)
  const BOMB_BLOCKS = 12;          // number of blocks Bomb destroys (assumption)
  // Frames per row of gravity by speed level. Speed rises every 30 s of a round.
  const GRAVITY = [48, 40, 32, 26, 21, 17, 13, 10, 8, 6, 5, 4, 3, 2];
  const SPEEDUP_FRAMES = 30 * FPS;

  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const COLORS = {
    I: '#35d0e6', O: '#f2d23c', T: '#b04ce0', S: '#4cd964',
    Z: '#ff4b4b', J: '#3f6df2', L: '#ff9a2e',
    g: '#8a8f98',   // garbage
    s: '#5b5048',   // stone
    f: '#ff7a3d',   // Fry filler
    star: '#fff38a',
  };

  // Spawn shapes in an n x n box: [n, [[x,y] x4]]
  const BASE = {
    I: [4, [[0, 1], [1, 1], [2, 1], [3, 1]]],
    O: [2, [[0, 0], [1, 0], [0, 1], [1, 1]]],
    T: [3, [[1, 0], [0, 1], [1, 1], [2, 1]]],
    S: [3, [[1, 0], [2, 0], [0, 1], [1, 1]]],
    Z: [3, [[0, 0], [1, 0], [1, 1], [2, 1]]],
    J: [3, [[0, 0], [0, 1], [1, 1], [2, 1]]],
    L: [3, [[2, 0], [0, 1], [1, 1], [2, 1]]],
  };
  // SHAPES[type][rot] = 4 minos, mino order preserved so a crystal stays on its block.
  const SHAPES = {};
  for (const t of TYPES) {
    const [n, cells] = BASE[t];
    const rots = [cells];
    for (let r = 1; r < 4; r++) {
      rots.push(rots[r - 1].map(([x, y]) => [n - 1 - y, x]));
    }
    SHAPES[t] = rots;
  }

  // ---- Characters and spells --------------------------------------------
  // Names follow English fan documentation (TetrisWiki). Two names were changed to keep
  // the game English-only: Mirurun's unnamed level 1 is called "Drain", and Wolf-man's
  // "Nue" (a Japanese folklore creature) is called "Chimera".
  const CHARACTERS = [
    { id: 'halloween', name: 'Halloween', color: '#ff8c1a', boss: false,
      spells: ['Fry', 'Dark', 'Vampire', 'Bomb'] },
    { id: 'mirurun', name: 'Mirurun', color: '#ff7fbf', boss: false,
      spells: ['Drain', 'Inversion', 'Pentaris', 'Sirtet'] },
    { id: 'shaman', name: 'Shaman', color: '#7bd66b', boss: false,
      spells: ['Moses', 'Rotation', 'Curse', 'Prayer'] },
    { id: 'aladdin', name: 'Aladdin', color: '#e0c050', boss: false,
      spells: ['Seesaw', 'Shield', 'Fax', 'Remote'] },
    { id: 'princess', name: 'Princess', color: '#f5a3c7', boss: false,
      spells: ['Sol', 'Mirror', 'Paralysis', 'Copy'] },
    { id: 'bit', name: 'Bit', color: '#6fd3ff', boss: false,
      spells: ['Stardust', 'Fever', 'Gang', 'Mambo'] },
    { id: 'ninja', name: 'Ninja', color: '#8c7cf0', boss: false,
      spells: ['Assemble', 'Fraud', 'Ruin', 'Medusa'] },
    { id: 'wolfman', name: 'Wolf-man', color: '#b08560', boss: false,
      spells: ['Cut', 'Chimera', 'Pals', 'Thwack'] },
    { id: 'dragon', name: 'Dragon', color: '#e04040', boss: true,
      spells: ['Press', 'Wish', 'Roulette', 'Change'] },
    { id: 'grandprincess', name: 'Grand Princess', color: '#f0e0ff', boss: true,
      spells: ['Hyper Fry', 'Reverse', 'Double', 'Clear'] },
  ];
  const CHAR_BY_ID = {};
  CHARACTERS.forEach((c) => { CHAR_BY_ID[c.id] = c; });

  const SPELL_TEXT = {
    Fry: 'Fills the gaps in your bottom 3 rows. They clear when your next piece lands.',
    Dark: 'Blacks out the opponent\'s field except a small area under their piece (3 pieces).',
    Vampire: 'Steals all of the opponent\'s crystals.',
    Bomb: 'Destroys random blocks on the opponent\'s field.',
    Drain: 'Removes your bottom 4 rows. Nothing is sent to the opponent.',
    Inversion: 'Inverts the opponent\'s controls for their next 3 pieces.',
    Pentaris: 'Sends 5 garbage lines to the opponent.',
    Sirtet: 'Every row with blocks on the opponent\'s field is inverted.',
    Moses: 'Parts your field: left half moves 2 columns left, right half 2 columns right.',
    Rotation: 'The opponent\'s next 3 pieces spin wildly when they soft drop.',
    Curse: 'Each of the opponent\'s next 5 pieces adds a stone line under them.',
    Prayer: 'Casts a random level 4 spell.',
    Seesaw: 'Moves your bottom 2 rows to the bottom of the opponent\'s field.',
    Shield: 'You are immune to incoming lines for a short time.',
    Fax: 'Copies your field onto the opponent\'s field.',
    Remote: 'You steer the opponent\'s next 2 pieces.',
    Sol: 'A beam of light clears 3 adjacent columns of your field.',
    Mirror: 'Steals the next spell the opponent casts.',
    Paralysis: 'The opponent cannot rotate their next 3 pieces.',
    Copy: 'Replaces your field with a copy of the opponent\'s.',
    Stardust: '9 stars fall onto your field, filling gaps and clearing lines.',
    Fever: 'Until 6 pieces are placed, every piece in the shared queue is the same.',
    Gang: 'Steals every crystal on the opponent\'s field.',
    Mambo: 'Randomly shuffles the opponent\'s stack.',
    Assemble: 'Pushes all your blocks to one side.',
    Fraud: 'Randomizes the opponent\'s next 5 pieces.',
    Medusa: 'Turns every block on the opponent\'s field to stone.',
    Ruin: 'For the opponent\'s next 6 pieces, cleared lines leave the stack hanging.',
    Cut: 'Clears the top 4 rows of your stack.',
    Chimera: 'The opponent cannot soft drop their next 4 pieces.',
    Pals: 'For a short time, lines sent to you lower your stack instead.',
    Thwack: 'For your next 4 pieces, blocks from your cleared lines drop on the opponent.',
    Press: 'Squeezes your stack together, removing the 2 center columns.',
    Wish: 'Choose any piece you want for your next 4 pieces.',
    Roulette: 'Scrambles the opponent\'s controls for their next 3 pieces.',
    Change: 'Swaps both players\' fields.',
    'Hyper Fry': 'Fills your bottom 4 rows and clears them, collecting their crystals.',
    Reverse: 'Reverses the opponent\'s left/right for their next 4 pieces.',
    Double: 'Lines cleared by your next piece send double garbage.',
    Clear: 'Clears your entire field.',
  };

  // ---- RNG ---------------------------------------------------------------
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    const rng = function () {            // mulberry32
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.int = (n) => Math.floor(rng() * n);
    rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
    rng.shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      return arr;
    };
    return rng;
  }

  // ---- Board helpers -----------------------------------------------------
  const emptyRow = () => new Array(W).fill(null);
  const emptyBoard = () => Array.from({ length: H }, emptyRow);
  const cloneCell = (c) => (c ? Object.assign({}, c) : null);
  const cloneBoard = (b) => b.map((row) => row.map(cloneCell));
  const rowFull = (row) => row.every((c) => c !== null);
  const rowEmpty = (row) => row.every((c) => c === null);

  function block(kind, color, crystal) {
    return { k: kind, c: color || COLORS[kind] || COLORS.g, cr: !!crystal };
  }

  function pieceCells(p) {
    return SHAPES[p.type][p.rot].map(([x, y], i) => ({ x: p.x + x, y: p.y + y, cr: i === p.crystal }));
  }

  function collides(board, p) {
    for (const { x, y } of pieceCells(p)) {
      if (x < 0 || x >= W || y >= H) return true;
      if (y >= 0 && board[y][x]) return true;
    }
    return false;
  }

  function dropY(board, p) {
    const q = Object.assign({}, p);
    while (!collides(board, Object.assign({}, q, { y: q.y + 1 }))) q.y++;
    return q.y;
  }

  // Delete anything pushed into the vanishing zone.
  function trimHidden(board) {
    for (let y = 0; y < HIDDEN; y++) board[y] = emptyRow();
  }

  function stackHeight(board) {
    for (let y = 0; y < H; y++) if (!rowEmpty(board[y])) return H - y;
    return 0;
  }

  function removeRows(board, ys) {
    const set = new Set(ys);
    const kept = board.filter((_, y) => !set.has(y));
    while (kept.length < H) kept.unshift(emptyRow());
    for (let y = 0; y < H; y++) board[y] = kept[y];
  }

  function pushRowsBottom(board, rows) {
    for (const r of rows) { board.shift(); board.push(r); }
    trimHidden(board);
  }

  function garbageRow(kind, hole) {
    const r = emptyRow();
    for (let x = 0; x < W; x++) if (x !== hole) r[x] = block(kind);
    return r;
  }

  // ---- Player ------------------------------------------------------------
  function makePlayer(idx, charId) {
    return {
      idx,
      char: CHAR_BY_ID[charId],
      board: emptyBoard(),
      piece: null,
      crystals: 0,
      dead: false,
      soft: false,
      gravTimer: 0,
      lockTimer: 0,
      spinTimer: 0,
      spawnDelay: 0,
      clearing: null,          // { rows, frames }
      pendingGarbage: [],      // [{ kind, n } | { rows }]
      // per-piece counters (decrement when this player locks a piece)
      fx: { invert: 0, reverse: 0, paralysis: 0, rotation: 0, noSoft: 0, dark: 0,
            ruin: 0, fraud: 0, wish: 0, double: 0, thwack: 0, curse: 0, roulette: 0, remote: 0 },
      rouletteMap: null,
      remoteBy: -1,            // index of the player steering this player's piece
      shield: 0,               // frames
      pals: 0,                 // frames
      mirror: false,
      fryPending: false,
      stats: { lines: 0, pieces: 0, spells: 0, sent: 0 },
    };
  }

  // ---- Match -------------------------------------------------------------
  class Match {
    constructor(opts) {
      this.opts = Object.assign({ seed: Date.now(), crystalCost: 1, startSpeed: 0 }, opts);
      this.rng = makeRng(this.opts.seed);
      this.players = [makePlayer(0, this.opts.chars[0]), makePlayer(1, this.opts.chars[1])];
      this.queue = [];
      this.fever = 0;
      this.frame = 0;
      this.winner = -1;
      this.events = [];        // drained by the UI: { type, player, ... }
      for (let i = 0; i < 3; i++) this.queue.push(this.randomPiece());
      this.spawn(this.players[0]);
      this.spawn(this.players[1]);
    }

    emit(e) { this.events.push(e); }
    other(p) { return this.players[1 - p.idx]; }
    speedLevel() {
      return Math.min(GRAVITY.length - 1, this.opts.startSpeed + Math.floor(this.frame / SPEEDUP_FRAMES));
    }
    level(p) { return Math.min(4, Math.floor(p.crystals / this.opts.crystalCost)); }
    maxCrystals() { return 4 * this.opts.crystalCost; }
    addCrystals(p, n) { p.crystals = Math.min(this.maxCrystals(), p.crystals + n); }

    randomPiece(type) {
      return {
        type: type || this.rng.pick(TYPES),
        crystal: this.rng() < CRYSTAL_CHANCE ? this.rng.int(4) : -1,
      };
    }

    nextFromQueue() {
      const entry = this.queue.shift();
      const nextType = this.fever > 0 ? this.queue[0].type : undefined;
      this.queue.push(this.randomPiece(nextType));
      return entry;
    }

    spawn(p) {
      if (p.dead) return;
      let entry;
      if (p.fx.fraud > 0) entry = this.randomPiece();   // Fraud: random piece, shared queue untouched
      else entry = this.nextFromQueue();
      this.pieceSeq = (this.pieceSeq || 0) + 1;
      const piece = { id: this.pieceSeq, type: entry.type, crystal: entry.crystal, rot: 0, x: entry.type === 'O' ? 4 : 3, y: 0 };
      p.piece = piece;
      p.gravTimer = 0;
      p.lockTimer = 0;
      if (collides(p.board, piece)) this.kill(p);
    }

    kill(p) {
      if (p.dead) return;
      p.dead = true;
      p.piece = null;
      if (this.winner < 0) this.winner = 1 - p.idx;
      this.emit({ type: 'dead', player: p.idx });
    }

    get over() { return this.winner >= 0; }

    // Which player's buttons currently steer p's piece (Remote).
    controllerOf(p) { return p.remoteBy >= 0 ? p.remoteBy : p.idx; }

    // Translate a physical button into the action it performs on p's piece.
    mapButton(p, btn) {
      let b = btn;
      if (p.fx.roulette > 0 && p.rouletteMap && p.rouletteMap[b]) b = p.rouletteMap[b];
      if (p.fx.invert > 0) {
        b = { left: 'right', right: 'left', rotL: 'rotR', rotR: 'rotL' }[b] || b;
      }
      if (p.fx.reverse > 0) b = { left: 'right', right: 'left' }[b] || b;
      return b;
    }

    controlsScrambled(p) {
      return p.fx.roulette > 0 || p.fx.invert > 0 || p.fx.reverse > 0;
    }

    // Physical button press from player `who`.
    press(who, btn) {
      if (this.over) return;
      const me = this.players[who];
      if (btn === 'spell') { this.cast(me); return; }
      const opp = this.other(me);
      // Remote: my buttons steer the opponent's piece; my own piece is frozen.
      const target = opp.remoteBy === who ? opp : me;
      if (target === me && me.remoteBy >= 0) return;   // my piece is being steered by the opponent
      if (target.dead || !target.piece || target.clearing) return;
      if (btn === 'wishPrev' || btn === 'wishNext') { this.wishCycle(target, btn === 'wishNext' ? 1 : -1); return; }
      const act = this.mapButton(target, btn);
      if (act === 'left') this.tryMove(target, -1, 0);
      else if (act === 'right') this.tryMove(target, 1, 0);
      else if (act === 'rotL' || act === 'rotR') {
        if (target.fx.paralysis > 0) return;
        this.tryRotate(target, act === 'rotR' ? 1 : -1);
      }
    }

    // Soft drop is held, not pressed. Scrambled controls can map "down" too (Roulette only maps left/right/rotate).
    setSoft(who, on) {
      const me = this.players[who];
      const opp = this.other(me);
      const target = opp.remoteBy === who ? opp : me;
      if (target === me && me.remoteBy >= 0) return;
      target.soft = on;
    }

    tryMove(p, dx, dy) {
      const q = Object.assign({}, p.piece, { x: p.piece.x + dx, y: p.piece.y + dy });
      if (collides(p.board, q)) return false;
      p.piece = q;
      if (dx !== 0) this.emit({ type: 'move', player: p.idx });
      return true;
    }

    // BPS-style rotation approximation: no wall kicks.
    tryRotate(p, dir) {
      const q = Object.assign({}, p.piece, { rot: (p.piece.rot + dir + 4) % 4 });
      if (collides(p.board, q)) return false;
      p.piece = q;
      this.emit({ type: 'rotate', player: p.idx });
      return true;
    }

    wishCycle(p, dir) {
      if (p.fx.wish <= 0) return;
      const i = TYPES.indexOf(p.piece.type);
      for (let k = 1; k <= TYPES.length; k++) {
        const t = TYPES[(i + dir * k + TYPES.length * 2) % TYPES.length];
        const q = Object.assign({}, p.piece, { type: t, rot: 0 });
        if (!collides(p.board, q)) { p.piece = q; return; }
      }
    }

    // ---- Per-frame update ----
    update() {
      if (this.over) return;
      this.frame++;
      for (const p of this.players) this.updatePlayer(p);
    }

    updatePlayer(p) {
      if (p.dead) return;
      if (p.shield > 0) p.shield--;
      if (p.pals > 0) p.pals--;
      if (p.clearing) {
        if (--p.clearing.frames <= 0) this.finishClear(p);
        return;
      }
      if (p.spawnDelay > 0) {
        if (--p.spawnDelay === 0) this.spawn(p);
        return;
      }
      if (!p.piece) return;
      // My piece is frozen while I steer the opponent's piece with Remote.
      if (this.other(p).remoteBy === p.idx) return;

      const softAllowed = p.soft && p.fx.noSoft <= 0;
      if (softAllowed && p.fx.rotation > 0) {           // Rotation spell: soft drop makes the piece spin
        if (++p.spinTimer >= 4) { p.spinTimer = 0; this.tryRotate(p, 1); }
      }
      const interval = softAllowed ? Math.min(2, GRAVITY[this.speedLevel()]) : GRAVITY[this.speedLevel()];
      const grounded = collides(p.board, Object.assign({}, p.piece, { y: p.piece.y + 1 }));
      if (grounded) {
        if (softAllowed || ++p.lockTimer >= LOCK_DELAY) this.lock(p);
        return;
      }
      p.lockTimer = 0;
      if (++p.gravTimer >= interval) {
        p.gravTimer = 0;
        this.tryMove(p, 0, 1);
      }
    }

    lock(p) {
      const cells = pieceCells(p.piece);
      const color = COLORS[p.piece.type];
      p.piece = null;
      p.stats.pieces++;
      if (cells.some((c) => c.y < HIDDEN)) { this.kill(p); return; }   // locked in the vanishing zone
      for (const c of cells) p.board[c.y][c.x] = block('n', color, c.cr);
      this.emit({ type: 'lock', player: p.idx });
      if (this.fever > 0) this.fever--;

      const rows = [];
      for (let y = 0; y < H; y++) if (rowFull(p.board[y])) rows.push(y);
      if (rows.length) {
        p.clearing = { rows, frames: CLEAR_DELAY };
        this.emit({ type: 'clearStart', player: p.idx, rows: rows.slice() });
      } else {
        this.afterLock(p);
      }
    }

    finishClear(p) {
      // Re-check: a spell cast during the flash (Fax, Change, ...) may have replaced the field.
      const rows = p.clearing.rows.filter((y) => rowFull(p.board[y]));
      p.clearing = null;
      const opp = this.other(p);
      let counted = 0;
      let crystals = 0;
      const thwackBlocks = [];
      for (const y of rows) {
        const row = p.board[y];
        const isFry = row.some((c) => c.k === 'f');
        if (!isFry) {
          counted++;
          crystals += row.filter((c) => c.cr).length;
        }
        if (p.fx.thwack > 0 && !isFry) {
          row.forEach((c, x) => { if (!c.cr) thwackBlocks.push(x); });
        }
      }
      this.clearRowsOnBoard(p, rows);
      p.stats.lines += counted;
      if (crystals) { this.addCrystals(p, crystals); this.emit({ type: 'crystal', player: p.idx, n: crystals }); }
      this.emit({ type: 'clear', player: p.idx, n: counted });

      let send = GARBAGE_TABLE[Math.min(4, counted)];
      if (p.fx.double > 0) send *= 2;
      if (send > 0) this.sendGarbage(p, opp, { kind: 'g', n: send });
      if (thwackBlocks.length) this.dropBlocksOn(opp, thwackBlocks);
      this.afterLock(p);
    }

    // Removes full rows, honoring stone blocks and Ruin.
    clearRowsOnBoard(p, rows) {
      const collapse = [];
      for (const y of rows) {
        const row = p.board[y];
        if (row.some((c) => c && c.k === 's')) {
          // Stone must be cleared twice: first clear cracks it into ordinary garbage and the row stays.
          p.board[y] = row.map((c) => (c && c.k === 's' ? block('g') : null));
        } else if (p.fx.ruin > 0) {
          p.board[y] = emptyRow();                        // Ruin: row empties but nothing falls
        } else {
          collapse.push(y);
        }
      }
      removeRows(p.board, collapse);
    }

    afterLock(p) {
      const fx = p.fx;
      if (fx.curse > 0) p.pendingGarbage.push({ kind: 's', n: 1 });
      for (const k of Object.keys(fx)) if (fx[k] > 0) fx[k]--;
      if (fx.remote === 0 && p.remoteBy >= 0) { p.remoteBy = -1; p.soft = false; }
      if (fx.roulette === 0) p.rouletteMap = null;
      // Apply garbage waiting for this player.
      for (const g of p.pendingGarbage) this.applyGarbage(p, g);
      p.pendingGarbage = [];
      if (p.dead) return;
      p.spawnDelay = 1;
    }

    sendGarbage(from, to, g) {
      if (to.dead) return;
      if (to.shield > 0) { this.emit({ type: 'blocked', player: to.idx }); return; }
      const n = g.rows ? g.rows.length : g.n;
      from.stats.sent += n;
      if (to.pals > 0) {                                  // Pals: incoming lines lower your stack
        removeRows(to.board, this.bottomRowIdx(to.board, n));
        this.emit({ type: 'pals', player: to.idx, n });
        return;
      }
      to.pendingGarbage.push(g);
      this.emit({ type: 'garbage', player: to.idx, n });
    }

    applyGarbage(p, g) {
      if (g.rows) { pushRowsBottom(p.board, g.rows); return; }
      const hole = this.rng.int(W);
      const rows = [];
      for (let i = 0; i < g.n; i++) rows.push(garbageRow(g.kind, hole));
      pushRowsBottom(p.board, rows);
    }

    bottomRowIdx(board, n) {
      const ys = [];
      for (let y = H - 1; y >= H - n && y >= 0; y--) ys.push(y);
      return ys;
    }

    // Blocks fall straight down into the given columns (Thwack, Stardust).
    dropBlocksOn(p, columns, kind) {
      for (const x of columns) {
        let y = HIDDEN - 1;
        while (y + 1 < H && !p.board[y + 1][x]) y++;
        if (y >= HIDDEN) p.board[y][x] = block(kind || 'g');
      }
    }

    // Clears any full rows immediately (spell side-effects). Returns count; crystals are collected.
    instantClear(p, collect) {
      const rows = [];
      let crystals = 0;
      for (let y = 0; y < H; y++) {
        if (rowFull(p.board[y])) { rows.push(y); crystals += p.board[y].filter((c) => c.cr).length; }
      }
      if (!rows.length) return 0;
      this.clearRowsOnBoard(p, rows);
      if (collect && crystals) { this.addCrystals(p, crystals); this.emit({ type: 'crystal', player: p.idx, n: crystals }); }
      this.emit({ type: 'clear', player: p.idx, n: rows.length });
      return rows.length;
    }

    // ---- Spells ----
    cast(p) {
      if (p.dead || this.over) return false;
      const lvl = this.level(p);
      if (lvl < 1) return false;
      p.crystals -= lvl * this.opts.crystalCost;
      p.stats.spells++;
      const name = p.char.spells[lvl - 1];
      let caster = p;
      const opp = this.other(p);
      if (opp.mirror) {                                   // Mirror: the opponent steals this spell
        opp.mirror = false;
        caster = opp;
        this.emit({ type: 'mirrored', player: opp.idx, spell: name });
      }
      // Casting discards the active piece of both players.
      for (const q of this.players) {
        if (q.piece) { q.piece = null; q.spawnDelay = 1; }
      }
      this.emit({ type: 'spell', player: caster.idx, spell: name, level: lvl });
      this.runSpell(name, caster, this.other(caster));
      for (const q of this.players) {
        trimHidden(q.board);
        if (!q.dead && !q.piece && !q.clearing && q.spawnDelay > 0) { q.spawnDelay = 0; this.spawn(q); }
      }
      return true;
    }

    runSpell(name, c, t) {
      const rng = this.rng;
      const fn = SPELLS[name];
      if (!fn) throw new Error('Unknown spell ' + name);
      fn.call(this, c, t, rng);
    }
  }

  // Each spell runs with `this` = Match, c = caster, t = target (the caster's opponent).
  const SPELLS = {
    // Halloween
    Fry(c) {
      for (let y = H - 3; y < H; y++) {
        for (let x = 0; x < W; x++) if (!c.board[y][x]) c.board[y][x] = block('f');
      }
    },
    Dark(c, t) { t.fx.dark = 3; },
    Vampire(c, t) { this.addCrystals(c, t.crystals); t.crystals = 0; },
    Bomb(c, t, rng) {
      const filled = [];
      for (let y = HIDDEN; y < H; y++) for (let x = 0; x < W; x++) if (t.board[y][x]) filled.push([x, y]);
      rng.shuffle(filled).slice(0, BOMB_BLOCKS).forEach(([x, y]) => { t.board[y][x] = null; });
    },
    // Mirurun
    Drain(c) { removeRows(c.board, this.bottomRowIdx(c.board, 4)); },
    Inversion(c, t) { t.fx.invert = 3; },
    Pentaris(c, t) { this.sendGarbage(c, t, { kind: 'g', n: 5 }); },
    Sirtet(c, t) {
      for (let y = HIDDEN; y < H; y++) {
        if (rowEmpty(t.board[y])) continue;
        t.board[y] = t.board[y].map((cell) => (cell ? null : block('g')));
      }
    },
    // Shaman
    Moses(c) {
      c.board = c.board.map((row) => {
        const r = emptyRow();
        for (let x = 0; x < 5; x++) if (row[x] && x - 2 >= 0) r[x - 2] = row[x];
        for (let x = 5; x < W; x++) if (row[x] && x + 2 < W) r[x + 2] = row[x];
        return r;
      });
    },
    Rotation(c, t) { t.fx.rotation = 3; },
    Curse(c, t) { t.fx.curse = 5; },
    Prayer(c, t, rng) {
      const pool = CHARACTERS.map((ch) => ch.spells[3]).filter((s) => s !== 'Prayer');
      const s = rng.pick(pool);
      this.emit({ type: 'spell', player: c.idx, spell: s, level: 4, via: 'Prayer' });
      SPELLS[s].call(this, c, t, rng);
    },
    // Aladdin
    Seesaw(c, t) {
      const rows = [c.board[H - 2], c.board[H - 1]].filter((r) => !rowEmpty(r)).map((r) => r.map(cloneCell));
      removeRows(c.board, [H - 2, H - 1]);
      if (rows.length) this.sendGarbage(c, t, { rows });
    },
    Shield(c) { c.shield = SHIELD_FRAMES; },
    Fax(c, t) { t.board = cloneBoard(c.board); },
    Remote(c, t) { t.fx.remote = 2; t.remoteBy = c.idx; t.soft = false; c.soft = false; },
    // Princess
    Sol(c) {
      let best = 0, bestCount = -1;
      for (let x = 0; x <= W - 3; x++) {
        let n = 0;
        for (let y = 0; y < H; y++) for (let k = 0; k < 3; k++) if (c.board[y][x + k]) n++;
        if (n > bestCount) { bestCount = n; best = x; }
      }
      for (let y = 0; y < H; y++) for (let k = 0; k < 3; k++) c.board[y][best + k] = null;
      this.emit({ type: 'sol', player: c.idx, x: best });
    },
    Mirror(c) { c.mirror = true; },
    Paralysis(c, t) { t.fx.paralysis = 3; },
    Copy(c, t) { c.board = cloneBoard(t.board); },
    // Bit
    Stardust(c, t, rng) {
      const cols = [];
      for (let i = 0; i < 9; i++) cols.push(rng.int(W));
      for (const x of cols) {
        this.dropBlocksOn(c, [x], 'star');
        this.instantClear(c, true);
      }
    },
    Fever() {
      this.fever = 6;
      const t = this.queue[0].type;
      this.queue = this.queue.map((e) => ({ type: t, crystal: e.crystal }));
    },
    Gang(c, t) {
      let n = 0;
      for (const row of t.board) for (const cell of row) if (cell && cell.cr) { cell.cr = false; n++; }
      this.addCrystals(c, n);
    },
    Mambo(c, t, rng) {
      const rows = [];
      for (let y = HIDDEN; y < H; y++) if (!rowEmpty(t.board[y])) rows.push(y);
      const contents = rng.shuffle(rows.map((y) => rng.shuffle(t.board[y].slice())));
      rows.forEach((y, i) => { t.board[y] = contents[i]; });
    },
    // Ninja
    Assemble(c, t, rng) {
      const toLeft = rng() < 0.5;
      c.board = c.board.map((row) => {
        const cells = row.filter(Boolean);
        const r = emptyRow();
        cells.forEach((cell, i) => { r[toLeft ? i : W - cells.length + i] = cell; });
        return r;
      });
    },
    Fraud(c, t) { t.fx.fraud = 5; },
    Ruin(c, t) { t.fx.ruin = 6; },
    Medusa(c, t) {
      t.board = t.board.map((row) => row.map((cell) => (cell ? block('s') : null)));
    },
    // Wolf-man
    Cut(c) {
      const top = H - stackHeight(c.board);
      if (top >= H) return;
      const ys = [];
      for (let y = top; y < Math.min(H, top + 4); y++) ys.push(y);
      removeRows(c.board, ys);
    },
    Chimera(c, t) { t.fx.noSoft = 4; },
    Pals(c) { c.pals = PALS_FRAMES; },
    Thwack(c) { c.fx.thwack = 4; },
    // Dragon
    Press(c) {
      c.board = c.board.map((row) => {
        const r = emptyRow();
        for (let x = 0; x < 4; x++) r[x + 1] = row[x];
        for (let x = 6; x < W; x++) r[x - 1] = row[x];
        return r;
      });
    },
    Wish(c) { c.fx.wish = 4; },
    Roulette(c, t, rng) {
      const btns = ['left', 'right', 'rotL', 'rotR'];
      let perm;
      do { perm = rng.shuffle(btns.slice()); } while (perm.every((b, i) => b === btns[i]));
      t.rouletteMap = {};
      btns.forEach((b, i) => { t.rouletteMap[b] = perm[i]; });
      t.fx.roulette = 3;
    },
    Change(c, t) { const b = c.board; c.board = t.board; t.board = b; },
    // Grand Princess
    'Hyper Fry'(c) {
      for (let y = H - 4; y < H; y++) {
        for (let x = 0; x < W; x++) if (!c.board[y][x]) c.board[y][x] = block('f');
      }
      // Collect crystals in these rows, then remove them (stone is not special here: Hyper Fry burns it).
      let n = 0;
      for (let y = H - 4; y < H; y++) n += c.board[y].filter((cell) => cell.cr).length;
      removeRows(c.board, [H - 4, H - 3, H - 2, H - 1]);
      if (n) { this.addCrystals(c, n); this.emit({ type: 'crystal', player: c.idx, n }); }
    },
    Reverse(c, t) { t.fx.reverse = 4; },
    Double(c) { c.fx.double = 1; },
    Clear(c) { c.board = emptyBoard(); },
  };

  const api = {
    W, H, HIDDEN, FPS, TYPES, COLORS, SHAPES, CHARACTERS, CHAR_BY_ID, SPELL_TEXT, GARBAGE_TABLE,
    Match, makeRng, emptyBoard, cloneBoard, collides, dropY, pieceCells, stackHeight, block, rowFull,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TBS = api;
})(typeof window !== 'undefined' ? window : globalThis);
