# tetris-battle-side-story

English-only browser recreation of the rules of Tetris Battle Gaiden (SNES, 1993), for Mishari to play on desktop or phone.

Stack: node (plain HTML/JS in the browser; Node is only used to run tests)

## Commands
- Install: nothing to install
- Run: open `index.html`, or `python3 -m http.server 8000` and visit http://localhost:8000
- Test: `node --test test/*.test.js`

## Layout
- `index.html` — page, menus (DOM overlays), touch pad, CSS
- `src/engine.js` — all rules: board, shared queue, crystals, garbage, the 40 spells. Node-testable, no DOM
- `src/ai.js` — computer opponent
- `src/main.js` — screens, canvas drawing (wide + portrait layouts), keyboard/touch input, sound
- `test/engine.test.js` — rule tests and CPU-vs-CPU smoke rounds

## Code style
- No build step, no dependencies. Keep it that way so the game opens straight from the file.
- Every rule not backed by a source is listed under "Assumptions" in README.md. Update that list when changing one.

## Repo etiquette
- Branch from `main`
- Never commit `.env`, `secrets/`, or generated output
- `git push` asks first (see `.claude/settings.json`)

## Gotchas
- English only: no Japanese words in names or UI (that's why "Nue" became "Chimera" and "Gaiden" became "Side Story").
- Do not add ROM data, sprites, music or text from the original game — copyright.
- The engine runs at a fixed 60 steps/second; timings are in frames.

## Notes
- Personal uncommitted notes → `CLAUDE.local.md` (gitignored)
- Machine-only settings → `.claude/settings.local.json` (gitignored)
