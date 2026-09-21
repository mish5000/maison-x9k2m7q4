# substack-brief

Phone-friendly reader plus a scheduled GitHub Actions job that turns every new
SemiAnalysis Substack article into a briefing a 10-year-old could follow.
Lives inside the PRIVÉE repository so it can share its GitHub Pages site; it
is otherwise self-contained and can be moved to its own repo by copying this
folder and `.github/workflows/substack-brief.yml`.

Stack: python (backend script) + a single static HTML page (app)

## Commands
- Install: `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
- Dry run (no Claude call, no write): `python brief.py --dry-run`
- Real run: `python brief.py` (needs the env vars in `.env.example`)
- Lint: `python -m pyflakes brief.py`
- Preview the app: `python3 -m http.server 8765` in this folder, open http://localhost:8765/
- Test: no automated test suite yet. Manual check: dry run shows `words: X of Y declared -> FULL` for a paid post.

## Layout
- `brief.py` — fetch (Substack API), summarise (Claude, structured JSON), encrypt (AES-GCM), notify (ntfy), write
- `data/briefs.json` — output; committed by the workflow; encrypted when `BRIEF_PASSPHRASE` is set
- `index.html` — the whole app; no build step, no dependencies
- `sw.js`, `manifest.webmanifest`, `icon*.{svg,png}` — PWA bits, scoped to this folder
- `../.github/workflows/substack-brief.yml` — the schedule

## Code style
- Keep `index.html` a single file with no external libraries.
- Keep `brief.py` dependency-light: `anthropic`, `requests`, `cryptography` only.
- The encryption format in `encrypt_payload` and the app's `decrypt` must stay identical.

## Repo etiquette
- Never commit `.env`. Secrets live in GitHub Actions secrets.
- Do not edit files outside this folder except the workflow and the one
  exclusion line in the root `sw.js` (it stops PRIVÉE's worker from hijacking this app).
- `data/briefs.json` is bot-written; expect the workflow to commit to `main`.

## Gotchas
- Substack is magic-link by default; email/password login only works after a
  password is set, and may hit a captcha. The `substack.sid` cookie is the
  reliable path. Password login is untested end to end (no credentials available when this was built).
- Unauthenticated post fetches return a free preview (about 80% of words on
  the sample checked). `post_is_full` compares against the declared `wordcount`.
- `newsletter.semianalysis.com` is a custom domain: cookies must be set for
  that host, not `substack.com`. `semianalysis.substack.com` redirects to it.
- GitHub scheduled workflows only run on the default branch and are disabled
  after 60 days without repository activity.
- The root PRIVÉE service worker serves its cached shell for any navigation
  under the repo path; the exclusion line in root `sw.js` is load-bearing.

## Notes
- Personal uncommitted notes → `CLAUDE.local.md` (gitignored)
