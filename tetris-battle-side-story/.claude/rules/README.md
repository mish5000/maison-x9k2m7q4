# Rules

Each `.md` file in this folder becomes a project instruction for Claude Code.

Add YAML frontmatter to scope a rule to matching files only:

```markdown
---
paths:
  - "src/**/*.js"
---
```

Path-scoped rules load when Claude reads a matching file and live in message history, so `/compact` can drop them.
Anything that must always apply belongs in the root `CLAUDE.md` instead.
