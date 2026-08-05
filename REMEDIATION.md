# PRIVÉE — what it takes to reach A+ shippable

Companion to `AUDIT.md`. Every line reference is to the **built** `index.html` in
this repo, which is the only artifact I have. You will apply these in the source
tree (`apps/privee/js/*.js`, `build/*.py`) that I have never seen, so each item is
described by **function name and behaviour** first and line number second. Where a
fix depends on build code I could not read, I say so rather than inventing it.

---

## What "A+" means for this specific app

Not a generic checklist. This app's stated constitution — no backend, no API keys,
one shipped file, fail-safe over plausible — is a good constitution. A+ means the
constitution is **enforced by machinery instead of by discipline**:

| Dimension | The A+ bar for *this* app |
|---|---|
| Correctness | A venue insert/delete cannot misalign anything, structurally — not "we remember to re-key" |
| Honesty | Every field the app displays is either verified-correct or not displayed. No third state |
| Build | The gate is non-bypassable and asserts data integrity, not just file presence |
| Tests | Tests cover the failure modes that have actually shipped, not the ones easy to write |
| Readability | A competent engineer joining cold is productive in one day |
| Performance | Per-frame cost is bounded and measured on real hardware, not asserted |

There are **17 items** below in four tiers. Tiers 0 and 1 are the difference
between "would not ship" and "would ship". Tiers 2 and 3 are the difference between
"ships fine" and A+.

---

# TIER 0 — Blockers. Do not ship until these are done.

## 0.1 — Repair the `losangeles|beach` misalignment
**Cost: 30 minutes + verification. Severity: live wrong data in production.**

Four sidecars kept the original numbering after a venue was deleted at index 0;
`VENUE_IMG`, `VENUE_LL` and `VENUE_HOURS` were correctly re-keyed. Confirmed by
three independent signals: hero asset `v_losangeles-beach-1.jpg` on the card at
index 0; gallery assets `g_losangeles-beach-0-*.jpg` on the same card; and
`VENUE_LL[losangeles|beach|0] = [34.038927, -118.670615]`, which is Little Beach
House's position, not Malibu Beach Inn's.

**The mechanical fix** — in `data.js`, for `losangeles|beach` only, in
`VENUE_TEL`, `VENUE_GALLERY`, `VENUE_BP` and `VENUE_RATING`: **delete key `|0`,
rename `|1` → `|0`, rename `|2` → `|1`.**

Resulting state:

| Key | Venue | `VENUE_TEL` | `VENUE_RATING` | Gallery |
|---|---|---|---|---|
| `losangeles\|beach\|0` | Little Beach House Malibu | `+1 310-456-2400` | `[4.7, 412]` | `g_…-1-0.jpg` |
| `losangeles\|beach\|1` | Malibu Beach Inn | `+1 310-651-7777` | `[4.7, 693]` | `g_…-2-*.jpg` (8) |

**Do not ship the shift blind.** You now have proof this cluster's provenance is
untrustworthy, so re-verify both phone numbers and both ratings against source
before publishing. The shift restores *internal consistency*; it does not prove
*external correctness*. Also delete the now-unreferenced
`assets/v_losangeles-beach-0.jpg`, `g_losangeles-beach-0-0.jpg` and
`g_losangeles-beach-0-1.jpg`.

**Then re-run the check across all 175 clusters** (script in item 1.2) — this is
the only cluster that currently fails, but that is a fact about today, not a
guarantee.

## 0.2 — Make `esc()` a real escaper
**Cost: 15 minutes. Severity: verified remote script execution.**

`index.html:2243`:

```js
const esc = (s) => s.replace(/"/g, '&quot;');            // ← escapes ONE character
```

Replace with:

```js
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
```

Two notes that make this safe to apply immediately:

- **`&` must be replaced first**, which the single-pass regex above guarantees.
  A naive chain of `.replace()` calls double-encodes.
- **I verified there is nothing to double-escape.** Across all 876 venues I
  scanned `n`, `a`, `ad`, `b`, `w`, `p` for pre-existing HTML entities and raw
  angle brackets: **0 entities, 0 angle brackets.** 22 records contain a raw `&`
  (`Nobu Lounge & Terrace`, `One&Only The Palm`, `Hauser & Wirth’s`) which becomes
  `&amp;` and renders identically. **No copy will visibly change.**
- The `String(s == null ? '' : s)` wrapper also fixes a latent crash: the current
  `esc` throws on `undefined` because it calls `.replace` directly.

**Then verify the fix** with the reproduction from the audit:

```
#/week/eyJuIjoiPGltZyBzcmM9eCBvbmVycm9yPWFsZXJ0KGRvY3VtZW50LmRvbWFpbik-IiwiZCI6e319
```

Before: `alert` fires, `document.querySelectorAll('h1 img').length === 1`.
After: the literal text `<img src=x onerror=alert(document.domain)>’s week` renders
and no element is created.

**Scope note — I checked the other candidate paths and they are clean, so don't
over-fix:**
- `toast()` uses `textContent`. Safe.
- `parseTravelText()` builds `hl` only from regex-matched flight codes
  (`[A-Z]{2}\d{2,4}`, IATA `[A-Z]{3}`) and the literal `'Chauffeur'`. A pasted
  confirmation email **cannot** inject. The trip rows at 3614/3673 render from the
  local `trips` store, which only this parser writes.
- The live vector is **`viewWeek()` only** (3501): `p.n` (3549, 3550), `tr.hl`
  (3529), `tr.sub` (3530), `tr.tm`/`tm` (3521, 3530) all come from the base64 URL
  payload. It renders but does not persist.

## 0.3 — Harden the two attribute-context interpolations
**Cost: 20 minutes. Do it with 0.2 — a correct `esc` does not cover these.**

Escaping fixes text nodes. Two sites interpolate into **CSS `url()` inside a
`style` attribute**, where HTML-escaping is the wrong defence:

```js
// 3518 (viewWeek), 6699 (map card), 7257 (list row)
${img ? `<span class="thumb" style="background-image:url('${im}')"></span>` : …}
```

`im` comes from `venueImg()` → `VENUE_IMG`, which is author-controlled, so this is
not currently exploitable. It is one data-entry mistake away from being so, and a
single `'` in a filename breaks the style silently. Fix by validating rather than
escaping:

```js
const safeUrl = (u) => (/^assets\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(u) ? u : null);
```

Render the monogram fallback when it returns `null`. This also enforces the
"real photo or nothing" rule mechanically instead of by convention.

## 0.4 — Replace frozen UTC offsets with IANA zone names
**Cost: 1 day. Hard deadline: 25 October 2026.**

`openState()` at `index.html:2164`:

```js
const local = new Date(Date.now() + (h.o + new Date().getTimezoneOffset()) * 60000);
```

The viewer's offset is live; the venue's `h.o` is frozen at build time, and all
537 entries carry the **summer** value. On 25 Oct (EU) / 1 Nov (US) every badge in
18 of 20 cities is wrong by exactly one hour, in the most dishonest direction —
`OPEN · UNTIL 23:00` displayed after closing.

**Fix.** This is a 22-row city→zone table, not 537 hand edits:

```
marbella/madrid → Europe/Madrid     london → Europe/London
paris → Europe/Paris                monaco,sttropez,courchevel → Europe/Paris
milan,capri,portocervo → Europe/Rome   ibiza → Europe/Madrid
mykonos → Europe/Athens             bodrum → Europe/Istanbul
dubai → Asia/Dubai                  newyork,miami,hamptons → America/New_York
losangeles → America/Los_Angeles    aspen → America/Denver
stbarths → America/St_Barthelemy
```

Emit `"tz": "Europe/Madrid"` per entry at build time and compute local time with
`Intl.DateTimeFormat` (universally available in every WebKit this app targets):

```js
const VENUE_NOW = (tz) => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(g('weekday')),
           min: +g('hour') * 60 + +g('minute') };
};
```

**Keep `h.o` as a fallback** for one release so a missing `tz` degrades to today's
behaviour rather than crashing.

**This same offset drives `venueTonight()` (1977)**, which decides a club night
belongs to the day it opens via `getUTCHours() < 6`. Fix both in one pass or the
DJ board serves the wrong night's bill between 05:00 and 06:00 local all winter.

## 0.5 — Stop the service worker leaking a cache entry per launch
**Cost: 1 hour.**

`sw.js` stores under the full request URL while the app fetches with a
cache-buster (`index.html:1930`, `1947`, `5242`), so **every launch misses,
fetches, and stores a permanently-unreachable entry.** `dishes.json` alone is
137,951 bytes — roughly 15 MB of garbage per 100 launches, against the ~50 MB iOS
quota that `sw.js`'s own header comment names as its design constraint. Nothing
evicts it: `activate` deletes other *cache names*, not entries.

Two changes, both in `sw.js`:

```js
// 1. normalise the key — strip the cache-busting query before storing
const keyFor = (req) => { const u = new URL(req.url); u.search = ''; return u.toString(); };

// 2. in BOTH the sidecar branch and the generic branch:
cache.put(keyFor(req), net.clone());       // was: cache.put(req, …)
// and on read:
const cached = await caches.match(keyFor(req));   // was: caches.match(req)
```

This also **fixes offline mode**, which is currently broken for these files: the
fallback `caches.match(req)` can never hit, because the `?ts=` value at read time
never equals the one at write time. Offline, `lineups.json` falls through to
`new Response('{}')` and `dishes.json` to `Response.error()`. Today the baked
seeds cover for it, which is why nobody noticed.

Add a bounded sweep in `activate` for existing installs:

```js
const c = await caches.open(CACHE);
for (const r of await c.keys()) if (new URL(r.url).search.includes('ts=')) await c.delete(r);
```

---

# TIER 1 — Structural. This is what actually moves the grade to A.

## 1.1 — Give every venue a stable `id` and demote positional keys to a build artifact
**Cost: 2–4 days. The single highest-value change in this document.**

This removes an entire class of failure rather than an instance. Everything in
Tier 0 item 0.1 is a symptom of this.

**Step 1.** Add `id` to each of the 876 records. Derive it once, then freeze it:
`id: 'la-little-beach-house-malibu'` (city prefix + slugified name). Frozen means
frozen — a rename of the venue must not change its id.

**Step 2.** Re-key all 10 sidecars and both JSON feeds from `city|cat|index` to
`id`. The build can generate the mapping from the current arrays, so this is
mechanical — but do it in **one commit with no other changes**, so the diff is
reviewable and a regression bisects cleanly.

**Step 3 — the part with a deadline.** Ship a one-time `localStorage` migration
for `privee_saved`, `privee_plans` and `privee_plan_times`:

```js
const MIGRATED = 'privee_keyfmt_v2';
if (!localStorage.getItem(MIGRATED)) {
  const map = POSITIONAL_TO_ID;         // baked by the build for THIS release only
  // rewrite savedSet, plans[iso][], and planTimes' "iso|key" composite keys
  localStorage.setItem(MIGRATED, '1');
}
```

**This window closes.** The mapping is only recoverable while the current
positional numbering is still the live one. The moment another renumber ships,
every member's saved list and dated plans are silently re-pointed and the
migration can no longer be written correctly. If you do only one thing from Tier 1,
do this, and do it before the next data edit.

**Step 4.** Make the bots that write `lineups.json` and `dishes.json` emit `id`.
Until they do, those two files remain positional and remain coupled to build
ordering — which is the coupling that makes an out-of-band regeneration dangerous.

**Step 5.** Once ids land, keep `venueByKey(id)` as the only resolver and delete
every ad-hoc `k.split('|')` — there are **17** of them (2063, 2434, 3487, 3510,
3560, 3593, 3653, 3752, 4155, 4195, 4201, 4246, 4329, 4603, 6422, 7710 and the
`viewWeek` one at 3515). Each is an independent chance to get the parse wrong.

## 1.2 — Put a real integrity assertion in the ship gate
**Cost: half a day. Best value-per-hour on this list — do it first, before 1.1.**

This is the machinery that makes the constitution self-enforcing, and it protects
you *while* the 1.1 refactor is in flight.

**It must load `data.js` by executing it, never by parsing it with regex.** Your
own note says regex-parsing of `data.js` has bitten twice; I could not read the
build scripts to confirm where, but the principle is right and the fix is trivial —
`node -e "require('./data.js')"` or a `json.dumps` round-trip via a Node
subprocess. A regex cannot know about a comma inside a string literal, an escaped
quote, or a nested object; an evaluator cannot get it wrong.

Then assert, and **fail the build** on any violation:

| # | Assertion | Catches |
|---|---|---|
| A | Every sidecar key resolves to an in-range `(city, cat, index)` | **Today's `losangeles\|beach` bug, in under a second** |
| B | For every asset matching `v_<city>-<cat>-<N>.jpg` / `g_<city>-<cat>-<N>-<k>.jpg`, `N` equals the key's index | All 18 historical shift sites |
| C | Every hostname-derived image matches its venue's `w` field | 39 checks, all currently passing — free regression net |
| D | Every key in `lineups.json` and `dishes.json` resolves | Out-of-band bot drift |
| E | Every referenced asset exists on disk; report unreferenced ones | Broken images; the 203 orphan files |
| F | Every `VENUE_HOURS` entry has a valid IANA `tz` | Regression on 0.4 |
| G | Cross-sidecar cardinality: no sidecar has keys for a cluster that another sidecar lacks, without an explicit allow-list entry | **The exact partial-edit signature that produced 0.1** |

Assertion G is the one that would have caught this class at the source. Four
sidecars having an index-2 entry while three do not is a two-line check.

**Then, separately: prove the gate is non-bypassable.** I could not audit
`build/gate.py` or `build/hook_shipgate.py` — they are not in this repo. Answer
these yourself and treat any "yes" as a Tier 0 blocker:
1. Can `rebuild.py` produce a deployable `privee-standalone.html` if the gate
   fails, or does it refuse to write the output file?
2. Is deploy a separate `cp`/`git push` that a human can run without the gate?
3. Is the hook a git hook? Git hooks are **not** version-controlled and are
   bypassed by `--no-verify`. If that is the only enforcement, the gate is
   advisory, not a gate.
4. Does the gate fail closed on its own exception, or does a crash read as a pass?

On the evidence available, a gate doing its job would have caught 0.1 before
deploy. It did not. That is not proof of theatre, but it is proof that whatever it
checks, it does not check data integrity.

## 1.3 — Make the honesty rules mechanical instead of aspirational
**Cost: 1 day.**

The code states excellent rules in comments — *"a plausible-but-wrong photo is
worse than no photo"* (1989), *"the fire mark must not promise what it cannot
deliver"* (1955). Nothing enforces them. Convert each into a runtime invariant:

- **Provenance on every displayed fact.** Give sidecar values a `checked` date
  (`DISHES` already has one — extend the pattern). Any fact older than a
  threshold is either not shown or shown with its date. This is what stops a
  stale line-up from being asserted as tonight's.
- **A dev-mode integrity panel.** Behind the existing `bbTap()` black-box gesture
  (2356), run assertions A–G from 1.2 in the browser and list failures. The
  gate catches this pre-deploy; this catches data that arrived post-deploy from
  the two runtime JSON feeds, which the gate never sees.
- **Never display an unverifiable join.** With ids (1.1), a `lineups.json` record
  whose id is unknown is *droppable with a log*. Today, a wrong positional key is
  indistinguishable from a right one — which is the definition of confidently wrong.

## 1.4 — Fix `LINEUPS` wholesale replacement
**Cost: 1 hour.**

`index.html:1932` — `LINE = j` replaces the baked seed entirely. The live
`lineups.json` covers 13 venues; the baked seed covers 18. Every successful fetch
**silently drops line-ups for DC-10 · Circoloco, Tibu Banús, Pangea, VOID and Club
Space.**

Decide explicitly, then encode the decision:
- If the bot is authoritative, keep the replace but **log the delta** and assert in
  the gate that the bot's venue set is a superset of the seed's, or that each
  omission is deliberate.
- If it is a partial feed, merge per-venue with the fresher `generated` winning.

Either is defensible. Silently doing the first while the comment implies the
second is not.

## 1.5 — Make the update check ordered, not just unequal
**Cost: 30 minutes.**

`index.html:5245` — `if (v.build === COLLECTION_UPDATED) return;` compares a
human-formatted string (`"2 August 2026 · 04:42 CEST"`) for inequality. A stale or
rolled-back `version.json` is "different", so it triggers a reload **once per
session, forever**. `version.json` already carries a monotonic `"v": 484`. Use it:

```js
if (!v || typeof v.v !== 'number' || v.v <= APP_BUILD_N) return;
```

Also note `swFlush()` (5253) wipes the entire cache on every update, discarding
every photo the member had accumulated offline. Once 0.5 normalises cache keys,
scope the flush to the shell entry and leave `assets/*` intact.

---

# TIER 2 — What separates A from A+

## 2.1 — Tests that map to what actually breaks
**Cost: 2 days.**

I cannot grade `build/tests/` — it is not in this repo, so I do not know what the
WebKit harnesses assert. What I *can* do is name the blind spots from the evidence,
because **every defect in this audit is a defect no paint-level harness can see.**
A WebKit rendering harness proves pixels; none of these are pixel bugs:

| Blind spot | Test that closes it | Evidence it is needed |
|---|---|---|
| Sidecar/array alignment | Assertions A–G run as unit tests, not just in the gate | 0.1 shipped |
| DST rollover | Freeze the clock to 2026-11-01 and 2026-07-01; assert `openState()` for one venue per zone | 0.4; 537 entries affected |
| Club-night rollover | Clock at 05:30 local, winter; assert `venueTonight()` returns the right date | Same root cause |
| XSS on untrusted routes | Load `#/week/<payload>`; assert no element is created and no dialog fires | 0.2, reproduced |
| SW cache growth | Load N times; assert cache entry count is bounded | 0.5 |
| Offline sidecar fallback | Go offline; assert `lineups.json` resolves from cache | Currently broken by the `?ts=` key |
| localStorage survives a renumber | Save a venue, renumber, reload; assert it still points at the same venue | 1.1; **no test today** |

The clock-dependent ones need injectable time. Replace direct `Date.now()` calls
in `openState`, `venueTonight` and `prunePlans` with a `NOW()` seam — that one
change makes four of the seven testable at all.

## 2.2 — Readability: get a cold engineer productive in a day
**Cost: 2 days.**

The commenting is genuinely good — it explains *why*, with dates and provenance
(*"IO, NEVER a scroll listener: the old rAF handler ran getBoundingClientRect"*,
*"'Nightclub' was the one false entry"*). Keep all of it. Three specific costs:

1. **Document the venue record schema.** Single-letter keys — `n, a, ad, b, w, p,
   t, wa, img, r` — with no schema anywhere in the artifact. A newcomer infers that
   `b` is the blurb and `ad` the street address by reading call sites. One 20-line
   comment block above `CITIES` fixes this permanently. Do it even if you do
   nothing else in this tier.
2. **Split the 7,774-line script** along the seams that already exist: data,
   data-access helpers, routing, views, map, service-worker glue. The build
   concatenates them anyway — this costs nothing at runtime and is the difference
   between navigable and not.
3. **Delete the `typeof X !== 'undefined'` guard on every sidecar read** — ~30
   occurrences (1973, 1991, 2035, 2113, 2124, 2136, 2147, 2159, 2248, 2872, …).
   In a single-file build those symbols cannot be undefined. The guard is noise
   that trains readers to skim past exactly the kind of check that will one day
   matter. If the concern is a partial build, assert once at startup instead.

## 2.3 — Performance: bound the two real costs
**Cost: 1 day, mostly measurement.**

The mechanisms are already right and I would not change them: 2
`getBoundingClientRect` calls in app code, 8 `IntersectionObserver`s replacing
scroll handlers, **21 `@keyframes` blocks with zero animating a layout- or
paint-triggering property**, `content-visibility` in use, DOM lean at 250 nodes
(home) / 869 (largest feed). That is better than most production CSS.

Two things to bound:

1. **42 `backdrop-filter` rules, 6 on elements that also transition/animate/
   transform** — `#sheet-backdrop`, `#gzoom`, `.pulsebtn`, `.fchip`, the bottom
   nav, the map home pill. On WebKit a moving element over a backdrop root
   re-samples its backdrop every frame; these six are the dominant compositing
   cost. The project already removed exactly this pattern from `.vcard .save`
   after a prior audit. **Measure the remaining six on real hardware** — this
   container is software-rendered and any number from it is fiction — and set an
   explicit budget (e.g. "at most two composited backdrop layers on screen at
   once"). Also add the missing `-webkit-` prefix on `.herosearch`, which silently
   no-ops on iOS Safari < 16.
2. **1.14 MB of JavaScript parsed before first paint** — 876 venue literals, 4,598
   sidecar entries, and a fully inlined Leaflet. This is the largest startup cost
   and the reason the boot loader exists. Leaflet is only needed on the map route:
   **defer it** behind the first map open. That is the single biggest startup win
   available and it does not violate the one-file constraint (keep it inline,
   just don't `eval` it until needed — or accept a second file for it).

## 2.4 — Garbage-collect assets
**Cost: 1 hour.** 203 of 2,004 asset files are unreferenced. Have the build
report orphans (assertion E) and fail on a threshold. Ship size and repo weight
both benefit; more importantly, an orphan is often the fingerprint of a deletion
whose sidecars were not cleaned up — which is precisely how 0.1 announced itself.

---

# TIER 3 — Things I could not specify, and why

I am not going to guess at these. Each needs the source tree.

1. **Where `data.js` is regex-parsed.** You flagged it as the thing that bit twice
   and I agree it is the right thing to distrust — but `build/rebuild.py` is not
   in this repo, so I cannot point at the line. The fix is stated in 1.2: execute,
   never parse.
2. **Whether the ship gate is real.** Four specific questions listed in 1.2.
3. **What `build/tests/` asserts.** Blind spots named in 2.1 from evidence, but I
   have not read the harnesses and cannot say which are already covered.
4. **Whether `CLAUDE.md`'s constraints are otherwise honoured.** I verified the
   two I could observe from the artifact: no API keys or backend in the shipped
   app (confirmed — no credentials, no fetch to any third-party origin), and the
   WebKit paint discipline (confirmed, and good). The rest I have not seen.
5. **The `+34 682 11 22 33` phone number**, shared by six unrelated Marbella
   venues. A Spanish *mobile* prefix with a sequential 11-22-33 body reads like a
   placeholder. I did not call it. Verify or remove.

---

# Sequencing and honest cost

Order matters — 1.2 before 1.1, because the integrity check protects you during
the refactor that is most likely to introduce a misalignment.

| Order | Item | Cost | Why here |
|---|---|---|---|
| 1 | 0.2 + 0.3 escaping | 35 min | One line, verified reproduction, no reason to wait |
| 2 | 1.2 gate assertions | 0.5 d | Protects everything after it |
| 3 | 0.1 LA repair | 0.5 d | Gate now proves it worked, and that nothing else is wrong |
| 4 | 0.5 SW cache | 1 h | Independent; also repairs offline |
| 5 | 0.4 timezones | 1 d | **Hard deadline 25 Oct 2026** |
| 6 | 1.1 stable ids + migration | 2–4 d | **Migration window closes on the next renumber** |
| 7 | 1.4, 1.5 | 1.5 h | Small, independent |
| 8 | 1.3 honesty invariants | 1 d | Needs ids from 1.1 |
| 9 | 2.1 tests | 2 d | Needs the `NOW()` seam |
| 10 | 2.2, 2.3, 2.4 | 4 d | Quality, not correctness |

**≈ 6 working days to shippable** (items 1–7). **≈ 13 to A+** (all of it).

Two of these have real deadlines and they are the two most likely to be deferred:
the timezone fix expires on **25 October 2026**, and the localStorage migration
window closes **the next time anyone inserts or deletes a venue**. Everything else
can wait; those two cannot.
