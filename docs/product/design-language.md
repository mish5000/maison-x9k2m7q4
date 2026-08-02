# Design language

Auralis looks the way it does because of what it claims. It tells you what a
file actually is, and how confident it is about each part of that. An interface
making careful claims should look careful — quiet, dense where density helps,
and unwilling to decorate a fact it has not established.

The whole visual system is in
[`packages/web/src/styles/tokens.css`](../../auralis/packages/web/src/styles/tokens.css).
No component declares a colour, space, radius, shadow, duration or z-index of
its own.

---

## Principles

**Evidence has a visual weight; assertion does not.** A verified duration is set
in the same type as an unverified one, but it carries a state and a source. The
card never uses emphasis to make an uncertain value look certain.

**One accent, spent carefully.** Copper appears on the focus ring, the primary
action, the active filter and a single badge state. When everything is
highlighted, nothing is. The accent is a pointer, not a mood.

**Hairlines, not boxes.** Structure comes from a 1px border at 10% opacity and
from spacing. Heavy containers make a results list feel like a spreadsheet.

**Progressive disclosure.** A result card shows what a person scanning needs.
The full technical record — every field, its confidence, and how it was
established — is one keyboard-reachable disclosure away and closed by default.

**Motion confirms, never entertains.** 150–220ms, ease-out, opacity and small
translations only. `prefers-reduced-motion` removes all of it.

---

## Palette

A warm near-black canvas rather than a blue-black one; warm white type rather
than pure white. Pure `#000` on `#fff` at this density is fatiguing, and a cool
palette reads as a developer tool rather than a considered instrument.

| Token                    | Value     | Used for                            |
| ------------------------ | --------- | ----------------------------------- |
| `--color-canvas`         | `#0b0b0c` | The page                            |
| `--color-canvas-sunken`  | `#070708` | Wells and inset regions             |
| `--color-surface`        | `#141416` | Cards, panels                       |
| `--color-surface-raised` | `#1b1b1e` | Popovers, drawers, expanded detail  |
| `--color-surface-hover`  | `#212125` | Hover on an interactive surface     |
| `--color-text-primary`   | `#f2f0ed` | Titles, values                      |
| `--color-text-secondary` | `#b4afa8` | Supporting text, labels             |
| `--color-text-tertiary`  | `#8e8983` | Metadata, captions                  |
| `--color-accent`         | `#d08a4e` | Focus, primary action, active state |
| `--color-success`        | `#7bb894` | Verified                            |
| `--color-warning`        | `#efa94a` | Partially verified, estimated       |
| `--color-danger`         | `#e4746b` | Failed, refused, corrupt            |

Contrast ratios are recorded at the top of `tokens.css` and were measured, not
estimated. Body text is 17.3:1 on canvas; the weakest pairing in the system is
tertiary text on a raised surface at 4.9:1, still above the 4.5:1 requirement.
Interactive borders use `--color-border-control` at 3.0:1.

Status colour is always accompanied by text. `StatusChip` renders a label in
every state, so the four verification states are distinguishable without colour
perception — which is both a WCAG 2.2 requirement and, for a product about
honest reporting, the obviously correct default.

---

## Typography

System stack. No web fonts, no font CDN, nothing fetched from a third party at
render time — which is a privacy property as much as a performance one.

The scale is narrow: `0.6875rem` to `1.0625rem` for interface text, with two
fluid steps above it (`--text-2xl`, `--text-hero`) for the search field and page
titles. A search product earns one moment of scale, at the input, and should be
uniform everywhere else.

Numbers and identifiers — bitrates, sample rates, hashes, hosts, byte counts —
are set in `--font-mono` so columns align down a list of results and a hash is
visibly a hash.

Prose is capped at `--measure` (68ch).

---

## Layout

Mobile first from 320px. `--page-max` is 1180px; the search column is narrower
than the results column because a search field wider than about 60 characters
stops looking like a place to type a phrase.

The body never scrolls horizontally. Anything intrinsically wide — the technical
detail table, a long URL, an evidence list — scrolls inside its own container.
The e2e suite asserts this at 320, 768 and 1280.

There is no sidebar. Navigation is: search, then results, then optionally detail.
A persistent chrome rail would spend permanent screen width on a product whose
primary interaction is one field.

---

## Components

| Component                     | Role                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `LandingHero`, `Wordmark`     | First screen; the wordmark is inline SVG, no image request                           |
| `SearchForm`, `AdvancedPanel` | The single field, plus filters that stay collapsed until asked for                   |
| `RecentSearches`              | Local only, with a clear control                                                     |
| `SearchProgress`              | Per-provider state during a run; a failed provider is a line here, not a failed page |
| `ResultList`, `ResultCard`    | Streaming results; each card is a self-contained claim                               |
| `StatusChip`                  | Verification and access state, always with text                                      |
| `TechnicalDetails`            | The full record, collapsed by default                                                |
| `PreviewPlayer`               | Playback, only where the access decision permits it                                  |
| `Notice`                      | Degraded states and errors, in plain language                                        |
| `ConnectorsView`              | Connect, test, disconnect                                                            |
| `DiagnosticsView`             | Provider health and timing                                                           |
| `SavedDrawer`, `Popover`      | Overlays; both trap focus and close on `Escape`                                      |

Actions on a card are derived **only** from `result.access.actions`. There is no
code path that renders a download control because a result looks downloadable.

---

## Accessibility

Verified with `@axe-core/playwright` on the initial screen and the results
screen, at desktop and mobile viewports. A critical or serious violation fails
the build.

- One `h1`; headings in order; `header`/`main`/`nav` landmarks correct.
- Every action reachable and operable by keyboard, in a sensible order.
- `:focus-visible` ring, 2px accent with a 2px offset, never removed.
- Inputs labelled with `htmlFor`/`id`; errors linked with `aria-describedby`.
- Streaming results announce through a polite live region, throttled so it
  summarises rather than reads out every arrival.
- Targets are at least 44px; `--control-height-sm` widens to 44px below 640px.
- `prefers-reduced-motion` disables transforms and transitions.

---

## Copy

Public strings are plain sentences. "That source could not be reached" rather
than a status code. Diagnostic detail lives in `evidence[]` and `firedRules[]`,
visible in the technical panel, never in the sentence a person reads first.

Where Auralis does not know something it says so — `unknown`, not a blank and
not a plausible guess. The interface is allowed to be less impressive in
exchange for being accurate, and that trade is the product.

---

## What this deliberately is not

No neon, no glassmorphism beyond a single frosted sticky surface, no full-bleed
gradient, no animated background, no dashboard sidebar, no charts on the landing
screen. Those signal a data product. Auralis is an instrument: it should look
like something you would trust to tell you a file is not what it claims to be.
