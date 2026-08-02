# Hooks

Five small POSIX shell scripts. Each does one thing, exits fast, and can be run
by hand with a one-line command. They exist to catch a specific, known mistake
at the moment it is made — not to enforce process.

The design constraints were deliberate:

- **Fast.** No network, no `npm`, no repository walk. The slowest is
  `post-edit-checks.sh`, which runs Prettier on exactly one file.
- **Deterministic.** Same input, same exit code. No timestamps in decisions, no
  sampling, no state.
- **Debuggable.** Every script carries its own test command in a header comment.
  Pipe a JSON payload in, read the exit code out.
- **Quiet when nothing is wrong.** A hook that prints on every edit gets
  ignored, and an ignored hook is worse than none.
- **Narrow.** Each blocker matches shapes that are almost never legitimate.
  False positives are the failure mode that gets hooks disabled.

They are a safety net, not the enforcement. ESLint, `tsc`, the test suite and
`npm run verify` are the enforcement. A hook catches the mistake earlier, when
it is cheapest to fix.

---

## Wiring

`.claude/settings.json` binds them:

| Event          | Matcher       | Scripts                                                        |
| -------------- | ------------- | -------------------------------------------------------------- |
| `PreToolUse`   | `Write\|Edit` | `block-secrets.sh`, `protect-generated.sh`, `network-guard.sh` |
| `PostToolUse`  | `Write\|Edit` | `post-edit-checks.sh`                                          |
| `SubagentStop` | `*`           | `agent-events.sh`                                              |

A `PreToolUse` hook exiting `2` blocks the tool call and shows its stderr as the
reason. Exiting `0` allows it. Nothing else is treated as a decision.

Each script reads the tool payload as JSON on stdin and pulls out `file_path`
with `sed` rather than a JSON parser, so there is no dependency to install and
nothing to break when a payload gains a field.

---

## The scripts

### `block-secrets.sh` — blocks

Rejects content that contains high-confidence secret material, and refuses to
write `.env`, `.env.local` or `.env.production` at all.

Matched shapes: AWS access key ids (`AKIA…`), PEM private key headers, GitHub
tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`), Slack tokens (`xox…`), `sk-` API
keys, and a `password`/`secret`/`api_key` assignment with a long literal value.

That last rule is the only fuzzy one, so it is suppressed when the content also
contains `EXAMPLE`, `PLACEHOLDER`, `CHANGE_ME`, `process.env`,
`import.meta.env`, `{{` or `${` — the shapes that indicate a placeholder or an
interpolation rather than a literal.

Exempt paths, because documenting secret handling requires naming these shapes:
`docs/security/**`, `.claude/hooks/**`, `.claude/rules/secrets.md`, `.env.example`.

```sh
# should block (exit 2)
printf '{"tool_input":{"file_path":"/tmp/x.ts","content":"const k = \"AKIAIOSFODNN7EXAMPLE\";"}}' \
  | .claude/hooks/block-secrets.sh; echo "exit=$?"

# should pass (exit 0)
printf '{"tool_input":{"file_path":"/tmp/x.ts","content":"const k = process.env.KEY;"}}' \
  | .claude/hooks/block-secrets.sh; echo "exit=$?"
```

### `protect-generated.sh` — blocks

Refuses edits to build output and to the preserved PRIVÉE application.

Blocked: `*/dist/*`, `*/dist-types/*`, `*/node_modules/*`, `*/coverage/*`,
`*/playwright-report/*`, `*/test-results/*`, `*.tsbuildinfo`, and the PRIVÉE
root files (`index.html`, `sw.js`, `manifest.json`, `version.json`,
`dishes.json`, `lineups.json`, `icon-*.png`, `assets/**`).

Editing `dist/` is always a mistake: the change disappears on the next build and
the real source stays wrong. The PRIVÉE rule exists because those files are an
unrelated application that shares no code with Auralis, and the instinct to tidy
a repository root is exactly the instinct that would damage them.

```sh
# should block (exit 2)
printf '{"tool_input":{"file_path":"/repo/auralis/packages/core/dist/index.js"}}' \
  | .claude/hooks/protect-generated.sh; echo "exit=$?"

# should block (exit 2)
printf '{"tool_input":{"file_path":"/home/user/maison-x9k2m7q4/index.html"}}' \
  | .claude/hooks/protect-generated.sh; echo "exit=$?"
```

### `network-guard.sh` — blocks

Auralis has exactly one outbound HTTP path. This rejects code that builds a
request any other way — the mistake that reintroduces SSRF.

Matched: a bare `fetch(` call, an import of `axios`/`node-fetch`/`got`/
`superagent`, `http.request(`/`https.request(`, and an import of
`node:http`/`node:https`.

Scoped to `auralis/packages/**/*.ts{,x}` only, with three exemptions:
`packages/core/src/net/**` (which _is_ the egress layer), `packages/web/**` (the
browser's `fetch` is a different thing entirely and never leaves the origin),
and tests and fixtures.

The `fetch` pattern requires a non-word character before the identifier, so
`context.fetch(...)` and `deps.fetch(...)` pass while `fetch(...)` does not.
ESLint's `no-restricted-syntax` rule enforces the same boundary at lint time;
this catches it a few minutes earlier.

```sh
# should block (exit 2)
printf '{"tool_input":{"file_path":"/r/auralis/packages/core/src/providers/x.ts","content":"await fetch(url)"}}' \
  | .claude/hooks/network-guard.sh; echo "exit=$?"

# should pass (exit 0) — the bound, policy-carrying fetch
printf '{"tool_input":{"file_path":"/r/auralis/packages/core/src/providers/x.ts","content":"await context.fetch(url)"}}' \
  | .claude/hooks/network-guard.sh; echo "exit=$?"

# should pass (exit 0) — the egress layer itself
printf '{"tool_input":{"file_path":"/r/auralis/packages/core/src/net/safe-fetch.ts","content":"https.request(o)"}}' \
  | .claude/hooks/network-guard.sh; echo "exit=$?"
```

### `post-edit-checks.sh` — advisory, never blocks

Runs `prettier --check` on the single file that just changed and prints the fix
command if it drifts. Always exits `0`.

It is advisory on purpose. Formatting is enforced by `npm run verify`, and
blocking an edit mid-thought over whitespace makes the tooling adversarial. It
skips silently if `node_modules/.bin/prettier` is not installed, so a fresh
clone before `npm install` is not noisy.

```sh
printf '{"tool_input":{"file_path":"/repo/auralis/packages/core/src/index.ts"}}' \
  | .claude/hooks/post-edit-checks.sh; echo "exit=$?"
```

### `agent-events.sh` — records, never blocks

Appends one line to `.claude/logs/agent-events.log` per agent lifecycle event:
a UTC timestamp and an event name, tab separated. Nothing else.

It explicitly drains and discards stdin. The payload contains prompts and tool
arguments, and a log of those is a log of the work — which may contain a query,
a path, or a connector setting. The point of this hook is to answer "how many
agents ran and when", which needs neither.

The log directory is `.gitignore`d.

```sh
AURALIS_HOOK_EVENT=start printf '{}' | .claude/hooks/agent-events.sh; echo "exit=$?"
tail -1 .claude/logs/agent-events.log
```

---

## Changing one

1. Edit the script.
2. Run its test command from this file. Check both the blocking case and the
   passing case — a hook that blocks everything passes the first test.
3. If you added a blocking rule, add its passing counter-example to this file.
   A rule with no documented false-positive check is a rule nobody will trust
   enough to leave enabled.

If a hook is getting in the way, fix its rule or delete it. Do not work around
it, and do not leave it in place while routinely ignoring what it says.

## Known limitations

- The `file_path` extraction takes the first match in the payload. A payload
  that embedded a second `"file_path"` string inside file _content_ would be
  read using the first one, which is the tool's own field — correct here, but it
  is a `sed` heuristic and not a parse.
- `block-secrets.sh` sees only the content being written. A secret assembled
  across two edits is not detected. `npm run audit` and review cover what a
  regex cannot.
- `network-guard.sh` matches text, so a request constructed through a computed
  property name would pass. ESLint's AST rule is the stronger check; this is the
  earlier one.
- Hook event names are set by the harness. If an event in `settings.json` is
  renamed upstream, the binding silently stops firing — the scripts themselves
  keep working, and `.claude/logs/agent-events.log` going quiet is the signal.
