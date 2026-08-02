#!/bin/sh
# PreToolUse hook for Write / Edit.
#
# Rejects content containing high-confidence secret material. Deliberately
# narrow: a hook that cries wolf gets disabled, and a disabled hook protects
# nothing. Only shapes that are almost never legitimate in source are matched.
#
# Reads the tool payload as JSON on stdin. Exits 0 quietly when nothing matches,
# 2 with a message on stderr to block.
#
# Test:
#   printf '{"tool_input":{"file_path":"/tmp/x.ts","content":"const k = \"AKIAIOSFODNN7EXAMPLE\";"}}' \
#     | .claude/hooks/block-secrets.sh; echo "exit=$?"

set -u

payload=$(cat 2>/dev/null || true)
[ -n "$payload" ] || exit 0

# Extract the fields we care about without needing a JSON parser.
path=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
body=$(printf '%s' "$payload" | tr -d '\000')

case "$path" in
  # Documentation about secret handling necessarily mentions these shapes.
  */docs/security/*|*/.claude/hooks/*|*/.claude/rules/secrets.md|*/.env.example) exit 0 ;;
esac

case "$path" in
  *.env|*.env.local|*.env.production)
    printf 'blocked: refusing to write %s — environment files must not be committed.\n' "$path" >&2
    exit 2
    ;;
esac

fail() {
  printf 'blocked: %s appears to contain %s.\n' "${path:-this edit}" "$1" >&2
  printf 'If this is a placeholder, make it obviously fake (for example EXAMPLE_KEY).\n' >&2
  exit 2
}

printf '%s' "$body" | grep -Eq 'AKIA[0-9A-Z]{16}' && fail 'an AWS access key id'
printf '%s' "$body" | grep -Eq 'BEGIN (RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY' && fail 'a private key'
printf '%s' "$body" | grep -Eq 'gh[pousr]_[A-Za-z0-9]{30,}' && fail 'a GitHub token'
printf '%s' "$body" | grep -Eq 'xox[baprs]-[A-Za-z0-9-]{10,}' && fail 'a Slack token'
printf '%s' "$body" | grep -Eq 'sk-[A-Za-z0-9]{32,}' && fail 'an API secret key'
printf '%s' "$body" | grep -Eiq '(password|passwd|secret|api_?key)[[:space:]]*[:=][[:space:]]*.[A-Za-z0-9/+_-]{12,}.' \
  && ! printf '%s' "$body" | grep -Eiq '(EXAMPLE|PLACEHOLDER|CHANGE_?ME|process\.env|import\.meta\.env|\{\{|\$\{)' \
  && fail 'a hard-coded credential'

exit 0
