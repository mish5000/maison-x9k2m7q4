#!/bin/sh
# PostToolUse hook for Write / Edit.
#
# Reports formatting drift on the single file that just changed. Deliberately
# non-blocking (always exits 0) so development stays usable — the release gate
# is where formatting is enforced.
#
# Test:
#   printf '{"tool_input":{"file_path":"/repo/auralis/packages/core/src/index.ts"}}' \
#     | .claude/hooks/post-edit-checks.sh; echo "exit=$?"

set -u

payload=$(cat 2>/dev/null || true)
[ -n "$payload" ] || exit 0

path=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$path" ] || exit 0

case "$path" in
  *auralis/*.ts|*auralis/*.tsx) ;;
  *) exit 0 ;;
esac

[ -f "$path" ] || exit 0

root=${path%%/auralis/*}/auralis
[ -x "$root/node_modules/.bin/prettier" ] || exit 0

if ! "$root/node_modules/.bin/prettier" --check "$path" >/dev/null 2>&1; then
  printf 'note: %s is not formatted. Run: cd auralis && npx prettier --write "%s"\n' "$path" "$path" >&2
fi

exit 0
