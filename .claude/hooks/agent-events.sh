#!/bin/sh
# SubagentStart / SubagentStop hook.
#
# Appends one line per agent lifecycle event so a long multi-agent session can
# be reconstructed afterwards. Records a timestamp and an event name only —
# no prompts, no file contents, no user data, no tool arguments.
#
# Test:
#   AURALIS_HOOK_EVENT=start printf '{}' | .claude/hooks/agent-events.sh; echo "exit=$?"
#   tail -1 .claude/logs/agent-events.log

set -u

cat >/dev/null 2>&1 || true   # drain stdin; its contents are deliberately unused

log_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../logs" 2>/dev/null && pwd) || exit 0
event=${AURALIS_HOOK_EVENT:-event}

printf '%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$event" >> "$log_dir/agent-events.log" 2>/dev/null || true

exit 0
