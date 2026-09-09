# quickcal

Personal iPhone web app: paste a message (group chat, email, invite), it finds
the dates and times, shows editable event cards, and gives one-tap buttons to
add each event to iPhone Calendar (.ics) or Google Calendar (template link).
No AI, no API keys, no backend, no fees. Built for one person (Mishari).

Stack: node (label only: the page is plain HTML/CSS/JS with no build step;
node is used solely to run the tests and the icon script)

## Commands
- Run locally: `python3 -m http.server 8000` in this folder, then open
  http://localhost:8000/ (don't open index.html as a file; the manifest and
  CSP behave differently from `file://`)
- Test: `node tests/parse.test.js` (no npm install needed, node 18+)
- Regenerate icons: `node tools/make-icons.js`
- Deploy: push to `main`; Cloudflare Pages builds from GitHub automatically
- Live URL: TODO — fill in after the Cloudflare Pages step (will be
  `https://<project>.pages.dev`)

## Layout
- `index.html` — the page, styles, and the strict Content-Security-Policy
- `app.js` — parsing rules, .ics builder, Google URL builder, and the UI
  (the parsing half also runs under node for the tests)
- `vendor/chrono-en.min.js` — chrono-node 2.10.1, English only, bundled once.
  Never hand-edit; see `vendor/README.md` to upgrade
- `manifest.webmanifest`, `icons/` — Add to Home Screen support
- `tests/parse.test.js` — parser, .ics and Google URL tests
- `tools/make-icons.js` — dependency-free PNG icon generator

## How parsing works (rules only)
1. chrono-node finds every date/time phrase (`forwardDate: true`, so a date
   with no year is the next time it comes round).
2. A phrase with a date and a time is an event. A time-only phrase attaches to
   the nearest date phrase before it (or after it if none before). A date with
   no time and no attached times becomes an all-day event.
3. A range ("3 to 6", "3pm-6pm") gives start and end. A bare time gets 1 hour.
4. Two phrases with the same start on the same day merge into one card, and the
   one with an explicit end wins ("3pm" + "3 to 6" = 3pm–6pm).
5. Bare hours 1–6 with no am/pm are assumed pm and flagged. 7–11 are left as
   chrono read them and flagged "check it".
6. Title = first non-empty line minus emoji and `$TAGS`, cut at the first
   sentence end. If a short activity word sits right before the time
   ("Drinks @ 3pm") the title becomes "Drinks · <title>".
7. Location = "at <Proper Name>" / "@ <Proper Name>". Matched to an event first
   by the word before "at" ("Drinks at Casa Del Mar" → the Drinks card), else
   by nearest position within 250 characters.
8. Timezone = device timezone; per-card dropdown; never inferred from venues.
Every guess is labelled "guessed" in the UI and listed in the amber flag box.

## Repo etiquette
- Branch from `main`
- Never commit `.env`, `secrets/`, or generated output
- `git push` asks first (see `.claude/settings.json`)
- Commit small, with plain messages

## Gotchas
- **Never add external scripts to this project.** The CSP in index.html is
  `script-src 'self'; connect-src 'none'`. A CDN `<script>` or a `fetch()`
  will be silently blocked, and it would break the "nothing leaves the phone"
  promise. Verified 2026-09-09 in headless Chromium: 3 requests at load
  (page, chrono, app.js), 0 requests afterwards.
- JS lives in `app.js`, not inline, so the CSP can stay `script-src 'self'`
  without hash bookkeeping. Inline styles are allowed (`style-src
  'unsafe-inline'`); inline `<script>` is not. Keep it that way.
- The `.ics` writes timed events as `DTSTART;TZID=<zone>:<local time>` with
  no VTIMEZONE block. Apple and Google both accept this for IANA zone names.
  If times ever come out shifted on the phone, switch "Advanced → Times
  inside the .ics" to UTC; that path converts with `Intl` and needs no data.
- iOS .ics behaviour: NOT YET CONFIRMED ON A REAL IPHONE. Two methods are
  built: (A) the button opens a `blob:` URL (switchable to `data:` in
  Advanced), (B) "Share .ics" uses the Web Share API with a File. Record
  here which one actually opened the Calendar sheet, in Safari and from the
  Home Screen icon.
- Google link behaviour on iPhone: NOT YET CONFIRMED. Record here whether
  `calendar.google.com/calendar/render?action=TEMPLATE` opens the Google
  Calendar app or Safari, and whether the timezone (`ctz`) is respected.
- Google has no batch-add link; "All events → Google" is a list of links.
- Safari needs iOS 15.4+ for the full timezone list
  (`Intl.supportedValuesOf`). Older versions get a short built-in list.
- No service worker on purpose: it can interfere with opening files and with
  seeing fresh deploys. Add to Home Screen works without one.
- `$TPAK`-style tags are removed from the title on purpose. If you want them
  kept, change `guessTitle` in app.js and the test.
- The rules are tuned on one example message. When a new message parses
  badly, add it to `tests/parse.test.js` first, then fix the rule.

## Notes
- Personal uncommitted notes → `CLAUDE.local.md` (gitignored)
- Machine-only settings → `.claude/settings.local.json` (gitignored)
- Hosting plan: Cloudflare Pages (free) from the private GitHub repo, with
  Cloudflare Access (one-time email code, free for up to 50 users) in front.
