# maison-x9k2m7q4

This repository holds two independent applications.

## Auralis — [`auralis/`](./auralis/)

**Find the sound. Verify the file.**

A universal audio discovery engine. One search field; results stream in from
public archives, open-data repositories, feeds, directory listings and any
storage you connect. Every candidate is verified by reading a bounded sample of
its actual bytes, so the technical metadata shown is measured rather than
claimed, and nothing unverified is ever offered as a download.

- Getting started: [`auralis/README.md`](./auralis/README.md)
- Architecture, ADRs, threat model and provider notes: [`docs/`](./docs/)
- Contributor and agent guidance: [`CLAUDE.md`](./CLAUDE.md)

```bash
cd auralis && npm install && npm run build && npm run dev
# then open http://localhost:5174
```

## PRIVÉE — repository root

A pre-existing static progressive web app (`index.html`, `sw.js`,
`manifest.json`, `assets/`, `dishes.json`, `lineups.json`, the icons and
`version.json`). It is unrelated to Auralis, has no build step, and is preserved
here unchanged. Serve the repository root statically to run it.

Do not mix the two: nothing in `auralis/` is part of PRIVÉE, and nothing at the
repository root is part of Auralis.
