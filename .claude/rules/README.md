# Rules

Every `.md` file in this directory becomes a project instruction Claude Code
reads. Use it to keep guidance out of the root `CLAUDE.md` when it only matters
for some of the code.

Add YAML frontmatter to scope a rule to matching files:

```markdown
---
paths:
  - "src/api/**/*.ts"
---

Instructions that only apply to the API layer.
```

Without frontmatter the rule always loads.

## The catch, and it matters

A path-scoped rule loads when Claude *reads* a matching file, and it lives in
the message history from that point on — which means `/compact` can drop it.
Anything that must survive for the whole session belongs in the root
`CLAUDE.md` instead, not here.

Also worth being accurate about: none of this is enforcement. `CLAUDE.md` and
these rules are context — Claude reads them and tries to follow them, but
nothing guarantees compliance. To actually *block* an action, use
`permissions.deny` in `.claude/settings.json`, or a hook.
