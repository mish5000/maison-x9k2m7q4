# Project rules

Any `.md` file in this folder becomes a project instruction for Claude Code.

Add YAML frontmatter to scope a rule to certain files, so it only loads when
Claude reads one of them:

```markdown
---
paths:
  - "vendor/**"
---
Never edit files in vendor/ by hand. See vendor/README.md for how to upgrade.
```

Path-scoped rules load when Claude *reads* a matching file and live in message
history, so `/compact` can drop them. Anything that must always survive belongs
in the root `CLAUDE.md` instead.
