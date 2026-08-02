---
name: verify-release
description: Run the Auralis release gate and report the real results. Use before declaring work complete or preparing a release.
---

# Release verification

Run these in order, from `auralis/`. Report actual output — a summary that was
not produced by a command that ran is not a result.

```bash
cd auralis

npm ci                 # from a clean clone; npm install otherwise
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e
npm run audit
```

`npm run verify` chains format, lint, typecheck, test, build and e2e.

## Pass criteria

| Step           | Passes when                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `format:check` | No files listed                                                        |
| `lint`         | Zero errors and zero warnings                                          |
| `typecheck`    | No diagnostics; strict mode, no suppressions added                     |
| `test`         | All tests pass, and no unhandled errors are reported after the summary |
| `build`        | All three packages emit; `packages/web/dist/index.html` exists         |
| `e2e`          | All journeys pass on both desktop and mobile projects                  |
| `audit`        | No high or critical advisories in production dependencies              |

An unhandled error printed after a green test summary is a failure. It means
something escaped a lifecycle, and it will escape in production too.

## Optional

```bash
npm run test:live      # opt-in, hits real services; a failure here is news
                       # about the world, not necessarily about the code
npx playwright test captures   # regenerate docs/product/screenshots
```

## Before declaring done

- [ ] Every command above ran, and the output was read
- [ ] `docs/` and `CLAUDE.md` still describe what the code does
- [ ] No `TODO`, placeholder, or fabricated data was introduced
- [ ] No secrets committed
- [ ] Known limitations are written down, not left implied
