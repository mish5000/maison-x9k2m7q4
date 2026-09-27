// Screens, rendering, keyboard/touch input and sound.
(function () {
  'use strict';
  const E = window.TBS;
  const { CPU } = window.TBSAI;
  const { W, H, HIDDEN, COLORS, SHAPES, CHARACTERS, CHAR_BY_ID, SPELL_TEXT } = E;

  // ---- Storage (optional; the game works without it) ----
  function load(key, fallback) {
    try { const v = localStorage.getItem('tbs.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function save(key, v) { try { localStorage.setItem('tbs.' + key, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  const opts = Object.assign({ cost: 1, cpu: 'normal', speed: 0, rounds: 2, sound: true }, load('opts', {}));
  let bossesUnlocked = load('bosses', false);

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const cv = $('cv');
  const ctx = cv.getContext('2d');
  const screens = ['scrTitle', 'scrSelect', 'scrOptions', 'scrHowto', 'scrPause', 'scrResult'];
  function show(id) {
    screens.forEach((s) => $(s).classList.toggle('on', s === id));
    const first = id && $(id).querySelector('button:not(.locked)');
    if (first) first.focus();
  }

  function fit() {
    const touch = $('touch').classList.contains('on');
    setLayout(window.innerHeight > window.innerWidth * 1.1);
    const availW = window.innerWidth - 8;
    const availH = window.innerHeight - (touch ? 150 : 8);
    const s = Math.min(availW / cv.width, availH / cv.height);
    const w = Math.floor(cv.width * s), h = Math.floor(cv.height * s);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    $('stage').style.width = w + 'px'; $('stage').style.height = h + 'px';
  }
  window.addEventListener('resize', fit);

  // ---- Sound: short synthesized beeps ----
  let actx = null;
  function beep(freq, dur, type, vol) {
    if (!opts.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.05, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + dur);
    } catch (e) { /* no audio */ }
  }
  const SFX = {
    move: () => beep(220, 0.03, 'square', 0.02),
    rotate: () => beep(330, 0.04, 'square', 0.025),
    lock: () => beep(140, 0.06, 'triangle', 0.06),
    clear: (n) => { for (let i = 0; i < n; i++) setTimeout(() => beep(520 + i * 140, 0.1, 'square', 0.05), i * 60); },
    crystal: () => { beep(1200, 0.08, 'sine', 0.06); setTimeout(() => beep(1600, 0.1, 'sine', 0.05), 70); },
    spell: () => { [392, 523, 659, 784].forEach((f, i) => setTimeout(() => beep(f, 0.12, 'sawtooth', 0.04), i * 60)); },
    garbage: () => beep(90, 0.15, 'sawtooth', 0.06),
    dead: () => { [330, 262, 196, 131].forEach((f, i) => setTimeout(() => beep(f, 0.18, 'triangle', 0.08), i * 120)); },
  };

  // ---- Game state ----
  const app = {
    mode: null,          // 'arcade' | 'free' | 'versus'
    chars: [null, null],
    human: [true, false],
    wins: [0, 0],
    stage: 0,            // arcade progress
    ladder: [],
    match: null,
    cpus: [null, null],
    paused: false,
    banners: [],         // { player, text, sub, t }
    flashes: [],         // { player, rows, t }
    beams: [],           // { player, x, t }
    roundOver: 0,
  };

  // ---- Input ----
  // In 1-player modes every key controls player 1.
  const KEYS_A = {
    KeyA: 'left', KeyD: 'right', KeyS: 'down', KeyW: 'spell',
    KeyZ: 'rotL', KeyX: 'rotR', KeyF: 'rotL', KeyG: 'rotR', KeyQ: 'wishPrev', KeyE: 'wishNext',
  };
  const KEYS_B = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'spell',
    KeyK: 'rotL', KeyL: 'rotR', KeyI: 'wishPrev', KeyO: 'wishNext',
  };
  const held = [{}, {}];      // held[player][button] = frames held (for auto-repeat)
  const DAS = 10, ARR = 2;

  function playerForKey(code) {
    if (KEYS_A[code]) return [0, KEYS_A[code]];
    if (KEYS_B[code]) return [app.mode === 'versus' ? 1 : 0, KEYS_B[code]];
    return null;
  }

  function buttonDown(pl, btn) {
    const m = app.match;
    if (!m || app.paused || app.roundOver || !app.human[pl]) return;
    if (held[pl][btn] !== undefined) return;
    held[pl][btn] = 0;
    if (btn === 'down') m.setSoft(pl, true);
    else m.press(pl, btn);
  }
  function buttonUp(pl, btn) {
    delete held[pl][btn];
    if (btn === 'down' && app.match) app.match.setSoft(pl, false);
  }
  function releaseAll() {
    for (let pl = 0; pl < 2; pl++) for (const b of Object.keys(held[pl])) buttonUp(pl, b);
  }
  function tickRepeat() {
    for (let pl = 0; pl < 2; pl++) {
      for (const b of ['left', 'right']) {
        if (held[pl][b] === undefined) continue;
        const f = ++held[pl][b];
        if (f >= DAS && (f - DAS) % ARR === 0) app.match.press(pl, b);
      }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') { toggleSound(); return; }
    if (app.match && !app.roundOver && (e.code === 'Enter' || e.code === 'KeyP') && !isMenuOpen()) {
      e.preventDefault(); pause(true); return;
    }
    if (isMenuOpen()) {
      menuKeys(e);
      return;
    }
    if (e.code === 'Escape' && app.match) { pause(true); return; }
    const k = playerForKey(e.code);
    if (k) { e.preventDefault(); buttonDown(k[0], k[1]); }
  });
  document.addEventListener('keyup', (e) => {
    const k = playerForKey(e.code);
    if (k) buttonUp(k[0], k[1]);
  });
  window.addEventListener('blur', releaseAll);

  function isMenuOpen() { return screens.some((s) => $(s).classList.contains('on')); }

  // Arrow keys / WASD move focus between menu buttons.
  function menuKeys(e) {
    const scr = screens.map($).find((s) => s.classList.contains('on'));
    const btns = Array.from(scr.querySelectorAll('button:not(.locked)'));
    if (!btns.length) return;
    let i = btns.indexOf(document.activeElement);
    const grid = scr.querySelector('.grid');
    const cols = grid && grid.contains(document.activeElement)
      ? Math.max(1, Math.round(grid.clientWidth / (btns[0].offsetWidth + 8))) : 1;
    const moves = { ArrowDown: cols, KeyS: cols, ArrowUp: -cols, KeyW: -cols, ArrowRight: 1, KeyD: 1, ArrowLeft: -1, KeyA: -1 };
    if (moves[e.code] !== undefined) {
      e.preventDefault();
      i = i < 0 ? 0 : Math.max(0, Math.min(btns.length - 1, i + moves[e.code]));
      btns[i].focus();
    } else if (e.code === 'Escape') {
      const back = scr.querySelector('[data-go="title"], #btnResume');
      if (back) back.click();
    }
  }

  // Touch pad (player 1).
  function setupTouch() {
    const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    $('touch').classList.toggle('on', isTouch);
    document.querySelectorAll('#touch button').forEach((b) => {
      const btn = b.dataset.t;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); buttonDown(0, btn); });
      const up = (e) => { e.preventDefault(); buttonUp(0, btn); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  // ---- Menus ----
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

  function go(where) {
    if (where === 'title') { app.match = null; refreshTitle(); show('scrTitle'); return; }
    if (where === 'options') { refreshOptions(); show('scrOptions'); return; }
    if (where === 'howto') { show('scrHowto'); return; }
    app.mode = where;
    app.wins = [0, 0];
    app.human = [true, where === 'versus'];
    pickCharacter(0);
  }

  function refreshTitle() {
    $('unlockNote').textContent = bossesUnlocked
      ? 'Dragon and Grand Princess are unlocked.'
      : 'Beat Story Battle to unlock the two hidden characters.';
  }

  function pickCharacter(pl) {
    const title = app.mode === 'versus' ? `Player ${pl + 1}: choose your character`
      : (pl === 0 ? 'Choose your character' : 'Choose your opponent');
    $('selTitle').textContent = title;
    const grid = $('selGrid');
    grid.innerHTML = '';
    for (const c of CHARACTERS) {
      const locked = c.boss && !bossesUnlocked;
      const b = document.createElement('button');
      b.className = 'card' + (locked ? ' locked' : '');
      b.innerHTML = `<b><span class="dot" style="background:${c.color}"></span>${locked ? '???' : c.name}</b>` +
        `<small>${locked ? 'Hidden character' : c.spells.map((s, i) => `${i + 1}. ${s}`).join('<br>')}</small>`;
      if (!locked) b.title = c.spells.map((s, i) => `${i + 1}. ${s}: ${SPELL_TEXT[s]}`).join('\n');
      b.addEventListener('click', () => {
        if (locked) return;
        app.chars[pl] = c.id;
        if (pl === 0 && app.mode !== 'arcade') { pickCharacter(1); return; }
        if (app.mode === 'arcade') startArcade();
        else startMatch();
      });
      grid.appendChild(b);
    }
    show('scrSelect');
  }

  // Story Battle: every other regular character, then the two hidden bosses.
  function startArcade() {
    app.ladder = CHARACTERS.filter((c) => !c.boss && c.id !== app.chars[0]).map((c) => c.id)
      .concat(['dragon', 'grandprincess'].filter((id) => id !== app.chars[0]));
    app.stage = 0;
    app.chars[1] = app.ladder[0];
    startMatch();
  }

  function cpuSkill() {
    if (app.mode !== 'arcade') return opts.cpu;
    const f = app.stage / Math.max(1, app.ladder.length - 1);
    return f < 0.3 ? 'easy' : f < 0.75 ? 'normal' : 'hard';
  }

  function startMatch() {
    app.wins = [0, 0];
    startRound();
  }

  function startRound() {
    const m = new E.Match({
      chars: app.chars.slice(), seed: (Math.random() * 1e9) | 0,
      crystalCost: opts.cost, startSpeed: opts.speed,
    });
    app.match = m;
    app.cpus = [null, app.human[1] ? null : new CPU(m, 1, cpuSkill())];
    app.banners = []; app.flashes = []; app.beams = [];
    app.roundOver = 0;
    app.paused = false;
    held[0] = {}; held[1] = {};
    show(null);
    const opp = CHAR_BY_ID[app.chars[1]];
    banner(-1, app.mode === 'arcade' ? `Stage ${app.stage + 1}` : 'Ready', `${CHAR_BY_ID[app.chars[0]].name} vs ${opp.name}`);
  }

  function endRound() {
    const m = app.match;
    const w = m.winner;
    app.wins[w]++;
    const need = opts.rounds;
    const names = app.chars.map((id) => CHAR_BY_ID[id].name);
    let title, text, next;
    if (app.wins[w] >= need) {
      if (app.mode === 'arcade') {
        if (w === 0) {
          app.stage++;
          if (app.stage >= app.ladder.length) {
            bossesUnlocked = true; save('bosses', true);
            title = 'Story Battle cleared!';
            text = `${names[0]} defeated every opponent. Dragon and Grand Princess are now playable.`;
            next = () => go('title');
          } else {
            title = `${names[0]} wins!`;
            text = `Next opponent: ${CHAR_BY_ID[app.ladder[app.stage]].name}`;
            next = () => { app.chars[1] = app.ladder[app.stage]; startMatch(); };
          }
        } else {
          title = 'You lost';
          text = `${names[1]} wins the match. Continue to try again.`;
          next = () => startMatch();
        }
      } else {
        const who = app.mode === 'versus' ? `Player ${w + 1}` : (w === 0 ? 'You' : 'Computer');
        title = `${who} (${names[w]}) wins the match!`;
        text = `Rounds ${app.wins[0]} - ${app.wins[1]}`;
        next = () => startMatch();
      }
    } else {
      title = `${names[w]} wins the round`;
      text = `Rounds ${app.wins[0]} - ${app.wins[1]} (first to ${need})`;
      next = () => startRound();
    }
    $('resTitle').textContent = title;
    $('resText').textContent = text;
    $('resNext').onclick = next;
    show('scrResult');
  }
  $('resQuit').addEventListener('click', () => go('title'));

  function pause(on) {
    if (!app.match) return;
    app.paused = on;
    releaseAll();
    show(on ? 'scrPause' : null);
  }
  $('btnResume').addEventListener('click', () => pause(false));
  $('btnQuit').addEventListener('click', () => go('title'));
  $('btnPause').addEventListener('click', () => { if (app.match && !app.roundOver && !isMenuOpen()) pause(true); });

  function toggleSound() {
    opts.sound = !opts.sound; save('opts', opts);
    $('btnMute').textContent = opts.sound ? '\u266A on' : '\u266A off';
  }
  $('btnMute').addEventListener('click', toggleSound);

  // Options cycle through values on click.
  const OPT_DEFS = {
    optCost: ['cost', [1, 2, 3, 4, 5], (v) => String(v)],
    optCpu: ['cpu', ['easy', 'normal', 'hard'], (v) => v[0].toUpperCase() + v.slice(1)],
    optSpeed: ['speed', [0, 2, 4, 6, 8], (v) => String(v / 2 + 1)],
    optRounds: ['rounds', [1, 2, 3], (v) => String(v)],
  };
  function refreshOptions() {
    for (const id of Object.keys(OPT_DEFS)) {
      const [key, , fmt] = OPT_DEFS[id];
      $(id).textContent = fmt(opts[key]);
    }
  }
  for (const id of Object.keys(OPT_DEFS)) {
    $(id).addEventListener('click', () => {
      const [key, vals] = OPT_DEFS[id];
      opts[key] = vals[(vals.indexOf(opts[key]) + 1) % vals.length];
      save('opts', opts);
      refreshOptions();
    });
  }

  // ---- Events from the engine -> effects and sounds ----
  function banner(player, text, sub) { app.banners.push({ player, text, sub: sub || '', t: 110 }); }

  function drainEvents() {
    const m = app.match;
    for (const e of m.events) {
      switch (e.type) {
        case 'move': if (app.human[e.player]) SFX.move(); break;
        case 'rotate': if (app.human[e.player]) SFX.rotate(); break;
        case 'lock': SFX.lock(); break;
        case 'clearStart': app.flashes.push({ player: e.player, rows: e.rows, t: 18 }); break;
        case 'clear': if (e.n) SFX.clear(Math.min(4, e.n)); break;
        case 'crystal': SFX.crystal(); break;
        case 'garbage': SFX.garbage(); break;
        case 'spell':
          SFX.spell();
          banner(e.player, e.spell, e.via ? `(by ${e.via})` : SPELL_TEXT[e.spell]);
          break;
        case 'mirrored': banner(e.player, 'Mirror!', `Stole ${e.spell}`); break;
        case 'blocked': banner(e.player, 'Shield', 'Blocked the attack'); break;
        case 'sol': app.beams.push({ player: e.player, x: e.x, t: 30 }); break;
        case 'dead': SFX.dead(); break;
        default: break;
      }
    }
    m.events.length = 0;
  }

  // ---- Main loop (fixed 60 steps per second) ----
  let last = performance.now();
  let acc = 0;
  const STEP = 1000 / 60;
  function frame(now) {
    acc += Math.min(250, now - last);
    last = now;
    while (acc >= STEP) { step(); acc -= STEP; }
    draw();
    requestAnimationFrame(frame);
  }

  function step() {
    const m = app.match;
    if (!m || app.paused) return;
    if (app.roundOver) {
      if (--app.roundOver === 0) endRound();
    } else {
      tickRepeat();
      for (const c of app.cpus) if (c) c.update();
      m.update();
      drainEvents();
      if (m.over) { app.roundOver = 120; releaseAll(); }
    }
    app.banners.forEach((b) => b.t--); app.banners = app.banners.filter((b) => b.t > 0);
    app.flashes.forEach((f) => f.t--); app.flashes = app.flashes.filter((f) => f.t > 0);
    app.beams.forEach((f) => f.t--); app.beams = app.beams.filter((f) => f.t > 0);
  }

  // ---- Drawing ----
  // Two layouts: wide (desktop / landscape) and tall (portrait phones).
  const VIS = H - HIDDEN;
  const LAYOUTS = {
    wide: { w: 760, h: 540, cell: 22, fy: 56, name: 17, small: 13, prev: [20, 16], box: [100, 56], gap: 64, stat: 12 },
    tall: { w: 470, h: 440, cell: 17, fy: 50, name: 13, small: 11, prev: [15, 12], box: [96, 44], gap: 50, stat: 10 },
  };
  let L = LAYOUTS.wide;
  function setLayout(tall) {
    L = LAYOUTS[tall ? 'tall' : 'wide'];
    const margin = tall ? 8 : 24;
    L.fw = W * L.cell; L.fh = VIS * L.cell;
    L.fx = [margin, L.w - margin - L.fw];
    L.cx = L.w / 2;
    if (cv.width !== L.w || cv.height !== L.h) { cv.width = L.w; cv.height = L.h; }
  }

  function drawBlock(x, y, s, color, kind, crystal) {
    const e = Math.max(2, Math.round(s / 7));
    ctx.fillStyle = color;
    ctx.fillRect(x, y, s, s);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(x, y, s, e); ctx.fillRect(x, y, e, s);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x, y + s - e, s, e); ctx.fillRect(x + s - e, y, e, s);
    if (kind === 's') {               // stone: cracks
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + s * 0.2, y + s * 0.25); ctx.lineTo(x + s / 2, y + s / 2); ctx.lineTo(x + s * 0.78, y + s * 0.8);
      ctx.moveTo(x + s / 2, y + s / 2); ctx.lineTo(x + s * 0.8, y + s * 0.28); ctx.stroke();
    }
    if (kind === 'star') {
      ctx.fillStyle = '#fff'; ctx.font = `${s - 6}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('★', x + s / 2, y + s / 2 + 1);
    }
    if (crystal) drawCrystal(x + s / 2, y + s / 2, s * 0.36);
  }

  function drawCrystal(cx, cy, r) {
    const t = performance.now() / 300;
    ctx.fillStyle = `hsl(${(t * 40) % 360}, 90%, 75%)`;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.75, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r * 0.75, cy);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  function drawPiecePreview(entry, cx, cy, s) {
    const cells = SHAPES[entry.type][0];
    const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
    const w = (Math.max(...xs) - Math.min(...xs) + 1) * s;
    const h = (Math.max(...ys) - Math.min(...ys) + 1) * s;
    cells.forEach(([x, y], i) => {
      drawBlock(cx - w / 2 + (x - Math.min(...xs)) * s, cy - h / 2 + (y - Math.min(...ys)) * s, s, COLORS[entry.type], 'n', i === entry.crystal);
    });
  }

  function text(str, x, y, size, color, align, bold, maxW) {
    ctx.font = `${bold ? 'bold ' : ''}${size}px "Trebuchet MS", "Segoe UI", sans-serif`;
    if (maxW) {
      while (size > 7 && ctx.measureText(str).width > maxW) {
        size -= 0.5;
        ctx.font = `${bold ? 'bold ' : ''}${size}px "Trebuchet MS", "Segoe UI", sans-serif`;
      }
    }
    ctx.fillStyle = color || '#fff';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x, y);
  }

  function drawField(p, i) {
    const m = app.match;
    const C = L.cell, FY = L.fy;
    const fx = L.fx[i];
    const fw = L.fw, fh = L.fh;
    ctx.fillStyle = '#0d0d22';
    ctx.fillRect(fx, FY, fw, fh);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 1; x < W; x++) { ctx.beginPath(); ctx.moveTo(fx + x * C, FY); ctx.lineTo(fx + x * C, FY + fh); ctx.stroke(); }
    for (let y = 1; y < VIS; y++) { ctx.beginPath(); ctx.moveTo(fx, FY + y * C); ctx.lineTo(fx + fw, FY + y * C); ctx.stroke(); }

    for (let y = HIDDEN; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = p.board[y][x];
        if (c) drawBlock(fx + x * C, FY + (y - HIDDEN) * C, C, c.c, c.k, c.cr);
      }
    }
    // Active piece (the original has no ghost piece).
    if (p.piece) {
      for (const c of E.pieceCells(p.piece)) {
        if (c.y < HIDDEN) continue;
        drawBlock(fx + c.x * C, FY + (c.y - HIDDEN) * C, C, COLORS[p.piece.type], 'n', c.cr);
      }
    }
    // Line-clear flash
    for (const f of app.flashes) {
      if (f.player !== i) continue;
      ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.5 * ((f.t >> 2) % 2)})`;
      for (const y of f.rows) if (y >= HIDDEN) ctx.fillRect(fx, FY + (y - HIDDEN) * C, fw, C);
    }
    // Sol beam
    for (const b of app.beams) {
      if (b.player !== i) continue;
      const g = ctx.createLinearGradient(fx + b.x * C, 0, fx + (b.x + 3) * C, 0);
      g.addColorStop(0, 'rgba(255,240,150,0)'); g.addColorStop(0.5, `rgba(255,250,200,${b.t / 30})`); g.addColorStop(1, 'rgba(255,240,150,0)');
      ctx.fillStyle = g; ctx.fillRect(fx + b.x * C, FY, 3 * C, fh);
    }
    // Dark: only a small area under the active piece stays visible.
    if (p.fx.dark > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(fx, FY, fw, fh);
      if (p.piece) {
        const px = fx + Math.max(0, p.piece.x - 1) * C;
        const py = FY + Math.max(0, p.piece.y - HIDDEN) * C;
        ctx.rect(px, py, Math.min(6 * C, fx + fw - px), Math.min(7 * C, FY + fh - py));
      }
      ctx.fillStyle = '#000';
      ctx.fill('evenodd');
      ctx.restore();
    }
    // Shield glow
    if (p.shield > 0) {
      ctx.strokeStyle = `rgba(120,200,255,${0.5 + 0.3 * Math.sin(performance.now() / 120)})`;
      ctx.lineWidth = 4; ctx.strokeRect(fx - 3, FY - 3, fw + 6, fh + 6);
    }
    ctx.strokeStyle = p.char.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(fx - 1, FY - 1, fw + 2, fh + 2);

    // Header: name, round wins
    const ch = p.char;
    const who = app.mode === 'versus' ? `P${i + 1}` : (app.human[i] ? 'YOU' : 'CPU');
    const dots = opts.rounds * 14;
    text(`${who}  ${ch.name}`, fx, FY - 28, L.name, ch.color, 'left', true, fw - dots - 4);
    for (let k = 0; k < opts.rounds; k++) {
      ctx.fillStyle = k < app.wins[i] ? '#ffd34d' : '#333356';
      ctx.beginPath(); ctx.arc(fx + fw - 6 - k * 14, FY - 33, 5, 0, Math.PI * 2); ctx.fill();
    }
    const lvl = m.level(p);
    text(`Crystals ${p.crystals}/${m.maxCrystals()}`, fx, FY - 9, L.small, '#bfe9ff', 'left');
    // Incoming garbage meter
    const pend = p.pendingGarbage.reduce((s, g) => s + (g.rows ? g.rows.length : g.n), 0);
    if (pend) {
      text(`Incoming ${pend}`, fx + fw, FY - 9, L.small, '#ff6b6b', 'right', true);
      ctx.fillStyle = '#ff4b4b';
      const bx = i === 0 ? fx + fw + 3 : fx - 7;
      ctx.fillRect(bx, FY + fh - Math.min(VIS, pend) * C, 4, Math.min(VIS, pend) * C);
    }
    // Spell slots
    const gy = FY + fh + 6;
    const sw = fw / 4;
    const gh = L.cell * 1.4;
    ch.spells.forEach((s, k) => {
      const on = k < lvl;
      const next = k === lvl - 1;
      ctx.fillStyle = on ? (next ? '#5a2ea0' : '#2c2350') : '#15152b';
      ctx.fillRect(fx + k * sw + 1, gy, sw - 2, gh);
      ctx.strokeStyle = next ? '#ffd34d' : '#34345c'; ctx.lineWidth = next ? 2 : 1;
      ctx.strokeRect(fx + k * sw + 1, gy, sw - 2, gh);
      text(`Lv${k + 1}`, fx + k * sw + sw / 2, gy + gh * 0.4, L.small - 3, on ? '#ffd34d' : '#666688', 'center');
      text(s, fx + k * sw + sw / 2, gy + gh * 0.84, L.small - 2, on ? '#fff' : '#666688', 'center', on, sw - 6);
    });
    if (m.other(p).remoteBy === i && p.piece) {
      text('Steering the opponent!', fx + fw / 2, FY + fh / 2, L.small + 2, '#ffd34d', 'center', true, fw - 8);
    }
    // Spell banners over the caster's field
    for (const b of app.banners) {
      if (b.player !== i) continue;
      const a = Math.min(1, b.t / 20);
      const by = FY + fh * 0.32;
      const bh = L.cell * 3.4;
      ctx.fillStyle = `rgba(20,10,50,${0.85 * a})`;
      ctx.fillRect(fx, by, fw, bh);
      ctx.globalAlpha = a;
      text(b.text, fx + fw / 2, by + bh * 0.45, L.name + 8, '#ffd34d', 'center', true, fw - 8);
      wrapText(b.sub, fx + fw / 2, by + bh * 0.7, fw - 10, L.small - 2, '#e6e0ff');
      ctx.globalAlpha = 1;
    }
    if (p.dead) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(fx, FY, fw, fh);
      text('K.O.', fx + fw / 2, FY + fh / 2, L.cell * 2, '#ff4b4b', 'center', true);
    }
  }

  function wrapText(str, cx, y, maxW, size, color) {
    ctx.font = `${size}px "Trebuchet MS", sans-serif`;
    const words = str.split(' ');
    let line = '';
    let yy = y;
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { text(line, cx, yy, size, color, 'center'); line = w; yy += size + 2; }
      else line = t;
    }
    if (line) text(line, cx, yy, size, color, 'center');
  }

  function statusLines(p) {
    const f = p.fx;
    const out = [];
    const add = (cond, s) => { if (cond) out.push(s); };
    add(p.shield > 0, `Shield ${Math.ceil(p.shield / 60)}s`);
    add(p.pals > 0, `Pals ${Math.ceil(p.pals / 60)}s`);
    add(p.mirror, 'Mirror ready');
    add(f.invert > 0, `Inverted x${f.invert}`);
    add(f.reverse > 0, `Reversed x${f.reverse}`);
    add(f.paralysis > 0, `No rotate x${f.paralysis}`);
    add(f.rotation > 0, `Spin x${f.rotation}`);
    add(f.noSoft > 0, `No drop x${f.noSoft}`);
    add(f.dark > 0, `Dark x${f.dark}`);
    add(f.ruin > 0, `Ruin x${f.ruin}`);
    add(f.fraud > 0, `Fraud x${f.fraud}`);
    add(f.curse > 0, `Curse x${f.curse}`);
    add(f.remote > 0, `Remote x${f.remote}`);
    add(f.wish > 0, `Wish x${f.wish}`);
    add(f.double > 0, 'Double!');
    add(f.thwack > 0, `Thwack x${f.thwack}`);
    if (f.roulette > 0 && p.rouletteMap) {
      out.push(`Roulette x${f.roulette}`);
      const names = { left: '←', right: '→', rotL: '⟲', rotR: '⟳' };
      out.push(Object.keys(p.rouletteMap).map((k) => `${names[k]}=${names[p.rouletteMap[k]]}`).join(' '));
    }
    return out;
  }

  function drawCenter() {
    const m = app.match;
    const cx = L.cx, FY = L.fy;
    const colW = L.fx[1] - (L.fx[0] + L.fw) - 12;
    text('NEXT', cx, FY + 4, L.name - 1, '#ffd34d', 'center', true);
    const [bw, bh] = L.box;
    m.queue.forEach((e, k) => {
      const y = FY + 14 + bh / 2 + k * L.gap;
      ctx.fillStyle = k === 0 ? '#1f1f40' : '#141430';
      ctx.fillRect(cx - bw / 2, y - bh / 2, bw, bh);
      drawPiecePreview(e, cx, y, k === 0 ? L.prev[0] : L.prev[1]);
    });
    let y = FY + 14 + 3 * L.gap + 14;
    if (m.fever > 0) { text(`FEVER x${m.fever}`, cx, y, L.small + 2, '#ff7fbf', 'center', true); }
    y += L.small + 8;
    text(`Speed ${m.speedLevel() + 1}`, cx, y, L.small, '#9a98b8', 'center');
    y += L.small + 14;
    // Active effects, listed per player in that player's color.
    for (const p of m.players) {
      const lines = statusLines(p);
      if (!lines.length) continue;
      text(p.char.name, cx, y, L.stat, p.char.color, 'center', true, colW);
      y += L.stat + 3;
      for (const s of lines) { text(s, cx, y, L.stat, '#ffb3b3', 'center', false, colW); y += L.stat + 3; }
      y += 4;
    }
    m.players.forEach((p, i) => {
      if (p.fx.wish > 0 && app.human[i]) {
        const keys = $('touch').classList.contains('on') ? '‹ ›' : (app.mode === 'versus' && i === 1 ? 'I / O' : 'Q / E');
        text(`Wish: ${keys} picks piece`, cx, FY + L.fh - 4, L.stat, '#ffd34d', 'center', true, colW);
      }
    });
    for (const b of app.banners) {
      if (b.player !== -1) continue;
      ctx.globalAlpha = Math.min(1, b.t / 20);
      ctx.fillStyle = 'rgba(10,10,30,0.9)';
      ctx.fillRect(0, L.h * 0.42, L.w, 80);
      text(b.text, cx, L.h * 0.42 + 40, 32, '#ffd34d', 'center', true);
      text(b.sub, cx, L.h * 0.42 + 64, 15, '#fff', 'center', false, L.w - 20);
      ctx.globalAlpha = 1;
    }
  }

  function drawTitleBackdrop() {
    const t = performance.now() / 1000;
    ctx.fillStyle = '#05050f';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const types = E.TYPES;
    for (let k = 0; k < 14; k++) {
      const type = types[k % types.length];
      const x = (k * 97) % cv.width;
      const y = ((t * (20 + k * 3) + k * 120) % (cv.height + 80)) - 40;
      ctx.globalAlpha = 0.25;
      drawPiecePreview({ type, crystal: k % 3 === 0 ? 1 : -1 }, x, y, 18);
      ctx.globalAlpha = 1;
    }
  }

  function draw() {
    const m = app.match;
    if (!m) { drawTitleBackdrop(); return; }
    ctx.fillStyle = '#05050f';
    ctx.fillRect(0, 0, cv.width, cv.height);
    m.players.forEach(drawField);
    drawCenter();
  }

  // ---- Boot ----
  $('btnMute').textContent = opts.sound ? '\u266A on' : '\u266A off';
  setupTouch();
  refreshTitle();
  fit();
  show('scrTitle');
  requestAnimationFrame(frame);
  window.__app = app;   // for debugging / automated checks
})();
