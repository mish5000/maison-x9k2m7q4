# SemiAnalysis Brief

A small phone app that reads every new SemiAnalysis article from your paid
Substack subscription and rewrites it as a briefing a curious 10-year-old could
follow. Nothing runs on your phone except the reader; a GitHub robot does the
fetching and summarising.

## How it works

1. Every 30 minutes GitHub Actions runs `brief.py`.
2. The script logs into Substack with your credentials (stored as GitHub
   secrets, never in the code), lists the newest SemiAnalysis posts, and pulls
   the full text of any it has not seen.
3. Claude writes the briefing (big idea, the story in order, why it matters,
   the exact numbers, words to know).
4. The result is saved to `data/briefs.json` in this repository. If you set a
   passphrase, that file is encrypted so nobody browsing the public repo can
   read the paid content.
5. The app (`index.html`, served by GitHub Pages) shows the briefs. Add it to
   your home screen and it behaves like a normal app.
6. Optional: a push notification through the free ntfy app when a new brief
   lands. The notification carries only the public title, never the summary.

## Setup (once, about 10 minutes)

### 1. Get the secrets ready

| Secret | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | From console.anthropic.com → API keys. Each article costs roughly 10 to 20 US cents to summarise with Claude Opus 5. |
| `SUBSTACK_COOKIE` | recommended | See "Getting your Substack cookie" below. Most reliable way to log in. |
| `SUBSTACK_EMAIL` + `SUBSTACK_PASSWORD` | alternative | Only works if you have set a password on Substack (Settings → Account → Set password). Substack is magic-link only by default. Can be blocked by a captcha. |
| `BRIEF_PASSPHRASE` | strongly recommended | Any long phrase you choose. Encrypts the briefs file. You type the same phrase once into the app. Without it, summaries of paid articles sit readable in a public repo. |
| `NTFY_TOPIC` | optional | A long random name, e.g. `mish-semi-7f3k9q2x`. Install the ntfy app on your phone and subscribe to the same topic. |

Add them in GitHub: the repository → Settings → Secrets and variables →
Actions → New repository secret.

### 2. Getting your Substack cookie

1. On a computer, log into https://newsletter.semianalysis.com in Chrome or Safari.
2. Open developer tools (Chrome: View → Developer → Developer Tools; Safari:
   enable the Develop menu in Settings → Advanced first).
3. Go to Application (Chrome) or Storage (Safari) → Cookies →
   `https://newsletter.semianalysis.com`.
4. Copy the value of the cookie named `substack.sid`. It is a long string.
5. Paste that as the `SUBSTACK_COOKIE` secret.

The cookie lasts a long time but not forever. When briefs start showing
"preview only", repeat these steps with a fresh cookie.

### 3. Turn it on

- GitHub Pages is already enabled for this repository and serves the `main`
  branch, so once this folder is on `main` the app is at
  `https://mish5000.github.io/maison-x9k2m7q4/substack-brief/`.
- The schedule only runs on the `main` branch. To run it by hand: Actions tab →
  "SemiAnalysis brief" → Run workflow.
- Open the app URL on your phone, tap Share → Add to Home Screen (iPhone) or
  the browser menu → Install app (Android).
- If you set a passphrase, tap the gear in the app and enter it once.

### 4. Optional: notifications

Install "ntfy" from the App Store or Play Store, tap +, and subscribe to the
exact topic name you put in `NTFY_TOPIC`. Anyone who guesses the topic name
can see the notifications, which is why it should be long and random and why
the script sends only the article title.

## Running it on your own computer

```bash
cd substack-brief
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then fill in the values
python brief.py --dry-run   # fetch only, no Claude call, nothing written
python brief.py             # the real thing
```

## What can go wrong

- **Every brief says "preview only".** The login did not work or the cookie
  expired. Fetch a fresh `substack.sid` cookie. The workflow log prints
  `words: X of Y declared` for each post so you can see exactly what it got.
- **"data/briefs.json is encrypted but BRIEF_PASSPHRASE is not set".** You
  set a passphrase once, then removed the secret. Put it back, or delete the
  data file to start over.
- **The app says "Locked" or "Wrong passphrase".** Tap the gear and enter the
  exact phrase from the GitHub secret.
- **Nothing new appears.** Check the Actions tab for a red run. Scheduled runs
  can be delayed by GitHub, and the schedule pauses automatically after 60
  days with no commits to the repository; pressing Run workflow re-enables it.

## Honest limitations

- Summaries are written by an AI and can contain mistakes. The original
  article is the source of truth; every brief links to it.
- The script cannot solve a captcha. If Substack starts demanding one for
  password login, use the cookie method.
- Push notifications on iPhone need the ntfy app. The web app itself cannot
  wake your phone on its own.
- Storing summaries of a paid newsletter, even encrypted, is for your personal
  use. Do not share the passphrase or the repository with others.
