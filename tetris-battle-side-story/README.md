# Tetris Battle: Side Story

An English-only browser recreation of the rules of **Tetris Battle Gaiden** (Bullet-Proof Software, Super Famicom, 1993).
"Gaiden" is Japanese for "side story", hence the name.

Unofficial fan project for personal use. It contains **no code, graphics, music or text from the original game**:
the original's source code has never been published, so it was rebuilt from public descriptions of how the game plays.
Tetris is a trademark of The Tetris Company.

## Play

Open `index.html` in a browser. No install, no build step.
To serve it locally (needed by some browsers for local files): `python3 -m http.server 8000` then open http://localhost:8000.

Modes: **Story Battle** (1P against every other character in turn, then the two hidden bosses),
**Free Battle** (1P, pick any opponent), **Versus** (2 players, one keyboard). Phones get on-screen buttons.

| Action | Player 1 | Player 2 (Versus) |
|---|---|---|
| Move | A / D (1P: also arrows) | Arrow Left / Right |
| Soft drop | S (1P: also Arrow Down) | Arrow Down |
| Rotate | Z / X or F / G (1P: also K / L) | K / L |
| Cast spell | W (1P: also Arrow Up) | Arrow Up |
| Wish: choose piece | Q / E | I / O |
| Pause / sound | Enter or P / M | |

## Tests

`node --test test/*.test.js` (Node 18+). Covers the shared queue, crystals, garbage, top-out, stone blocks, every spell,
Mirror, Remote, and full CPU-vs-CPU rounds for every character.

## How faithful is it?

### Taken from sources (TetrisWiki; web search summaries; Wikipedia for release facts)

- 10 x 20 field plus a 2-row hidden "vanishing zone"; blocks pushed into it are deleted; you lose only when a piece locks there.
- Both players draw from **one shared 3-piece Next queue**.
- Some pieces carry a crystal; clear its line to collect it. Crystals unlock 4 spell levels.
- Crystals needed per level is configurable (default 1, up to 5).
- Casting throws away both players' current pieces.
- No hold, no hard drop. Clearing 2+ lines at once sends garbage.
- Stone blocks need to be cleared twice.
- 8 characters plus 2 hidden bosses (Dragon, Grand Princess), 4 spells each, with the effects described on TetrisWiki.

### Assumptions (not documented anywhere I could find — change them in `src/engine.js`)

- Garbage per clear: 2 lines -> 1, 3 -> 2, 4 -> 4. Garbage arrives when the receiver next locks a piece.
- 25% of pieces carry a crystal. The spell key casts the **highest** level you can afford.
- Speed curve, lock delay (30 frames), auto-repeat timing, and rotation (simple rotation, no wall kicks).
  The original uses its own "BPS" rotation; this is an approximation.
- Durations the sources call "a short time": Shield 10 s, Pals 10 s. Dark lasts 3 pieces. Bomb destroys 12 blocks.
- Stone: the first clear turns stone into ordinary grey blocks and the row stays.
- Unclear spells, interpreted as: Prayer = casts a random level-4 spell from another character;
  Thwack = your cleared blocks drop onto the opponent; Remote = your own piece freezes while you steer theirs;
  Inversion = left/right and rotation swapped; Reverse = only left/right swapped; Sol = hits your 3 fullest columns.
- Story order, match length (first to 2 rounds, configurable), boss unlock (beat Story Battle), and CPU behaviour are my own.
- Story/plot text, character art and music are not included.

### English-only name changes

- Mirurun's level 1 has no documented name; it is called **Drain** here.
- Wolf-man's level 2 was "Nue" (a creature from Japanese folklore); it is called **Chimera** here.
- "Mirurun" is kept as a character name because no official English name was found.
