#!/bin/sh
# PreToolUse hook for Write / Edit.
#
# Auralis has exactly one outbound HTTP path: createSafeFetch. This hook rejects
# new code that builds a request any other way, which is the mistake that
# reintroduces SSRF. ESLint enforces the same rule; this one just catches it
# earlier, at edit time.
#
# Test:
#   printf '{"tool_input":{"file_path":"/repo/auralis/packages/core/src/providers/x.ts","content":"await fetch(url)"}}' \
#     | .claude/hooks/network-guard.sh; echo "exit=$?"

set -u

payload=$(cat 2>/dev/null || true)
[ -n "$payload" ] || exit 0

path=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$path" ] || exit 0

# Only applies to Auralis TypeScript.
case "$path" in
  *auralis/packages/*.ts|*auralis/packages/*.tsx) ;;
  *) exit 0 ;;
esac

# The egress layer itself, the browser client, and tests are exempt.
case "$path" in
  */packages/core/src/net/*) exit 0 ;;
  */packages/web/*) exit 0 ;;
  */tests/*|*/testing/*|*/e2e/*|*.test.ts) exit 0 ;;
esac

body=$(printf '%s' "$payload" | tr -d '\000')

fail() {
  printf 'blocked: %s introduces %s.\n' "$path" "$1" >&2
  printf 'All outbound requests go through createSafeFetch (or context.fetch in a\n' >&2
  printf 'provider). See .claude/rules/network-egress.md\n' >&2
  exit 2
}

printf '%s' "$body" | grep -Eq '(^|[^.[:alnum:]_])fetch[[:space:]]*\(' && fail 'a raw fetch() call'
printf '%s' "$body" | grep -Eq "from[[:space:]]+['\"](axios|node-fetch|got|superagent)['\"]" && fail 'an HTTP client dependency'
printf '%s' "$body" | grep -Eq 'https?\.request[[:space:]]*\(' && fail 'a direct http/https request'
printf '%s' "$body" | grep -Eq "from[[:space:]]+['\"]node:(http|https)['\"]" && fail 'a direct node:http import'

exit 0
