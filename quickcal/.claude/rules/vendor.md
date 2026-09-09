---
paths:
  - "vendor/**"
---
Files in `vendor/` are generated from a pinned upstream release. Never hand-edit
them. To upgrade, follow `vendor/README.md`, update the version everywhere it is
written, and re-run `node tests/parse.test.js`.
