#!/bin/sh
# PreToolUse hook for Write / Edit.
#
# Blocks edits to generated output and to the preserved PRIVÉE application.
# Editing build output is always a mistake — the change is lost on the next
# build and the real source stays wrong.
#
# Test:
#   printf '{"tool_input":{"file_path":"/repo/auralis/packages/core/dist/index.js"}}' \
#     | .claude/hooks/protect-generated.sh; echo "exit=$?"

set -u

payload=$(cat 2>/dev/null || true)
[ -n "$payload" ] || exit 0

path=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$path" ] || exit 0

block() {
  printf 'blocked: %s\n' "$1" >&2
  exit 2
}

case "$path" in
  */dist/*|*/dist-types/*)
    block "$path is build output. Edit the TypeScript source and rebuild." ;;
  */node_modules/*)
    block "$path is an installed dependency. Change package.json instead." ;;
  */coverage/*|*/playwright-report/*|*/test-results/*)
    block "$path is a generated report." ;;
  *.tsbuildinfo)
    block "$path is a TypeScript build artefact." ;;
esac

# The preserved PRIVÉE static app at the repository root. Unrelated to Auralis.
case "$path" in
  */maison-x9k2m7q4/index.html|*/maison-x9k2m7q4/sw.js|*/maison-x9k2m7q4/manifest.json| \
  */maison-x9k2m7q4/version.json|*/maison-x9k2m7q4/dishes.json|*/maison-x9k2m7q4/lineups.json| \
  */maison-x9k2m7q4/icon-*.png|*/maison-x9k2m7q4/assets/*)
    block "$path belongs to the preserved PRIVÉE application and must not be modified." ;;
esac

exit 0
