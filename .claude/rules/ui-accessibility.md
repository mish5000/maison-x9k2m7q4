---
description: Rules for the browser client.
globs: ['auralis/packages/web/**/*.{ts,tsx,css}']
---

# Interface and accessibility

## Tokens

Every colour, space, radius, shadow, duration and z-index comes from
`src/styles/tokens.css`. No raw hex, no magic pixel values in components. One
accent colour, used sparingly.

## Accessibility — WCAG 2.2 AA, verified not asserted

- One `h1`; headings in order; correct landmarks
- Every interactive element reachable and operable by keyboard
- Visible `:focus-visible` ring using the focus token
- Labels tied to inputs with `htmlFor`/`id`; errors linked with `aria-describedby`
- Streaming updates announced through a polite live region, throttled so it does
  not chatter
- Status is never conveyed by colour alone — a badge always carries text
- `prefers-reduced-motion` disables transforms and animations
- Touch targets at least 44px on mobile
- Body text at least 4.5:1; large text and UI borders at least 3:1

`npm run e2e` runs axe-core on the initial screen and on the results screen. A
critical or serious violation fails the build.

## Security in the client

- No `dangerouslySetInnerHTML`, ever
- Source-supplied strings render as text nodes
- External links carry `rel="noopener noreferrer"`
- Artwork uses `referrerPolicy="no-referrer"` and degrades gracefully
- Actions are derived **only** from `result.access.actions`. Never render a
  download control because a result "looks downloadable"

## Responsiveness

Mobile first, 320px upward. The body never scrolls horizontally; wide content
scrolls inside its own container. The e2e suite asserts this at 320, 768 and 1280.

## Imports

`@auralis/core` is a Node package. Import **types only**, with `import type`. A
runtime constant you need in the browser is redeclared locally in
`src/api/vocabulary.ts`, annotated with the core type it must stay assignable to
so drift becomes a compile error.
