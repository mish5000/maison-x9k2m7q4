# QuickCal

Paste a message, get calendar events. A single-page web app for iPhone.

- Finds dates and times with [chrono-node](https://github.com/wanasit/chrono) (rules, not AI)
- Shows an editable card per event, with guesses labelled as guesses
- Adds to iPhone Calendar (.ics) or Google Calendar (template link)
- No backend, no API keys, no analytics, no network requests after load

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## Test

```sh
node tests/parse.test.js
```

See `CLAUDE.md` for how the parsing rules work and the known gotchas.
