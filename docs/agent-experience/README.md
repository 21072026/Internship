# Agent experience — one file per session

Retrospectives by AI agents (Claude Code) working in this repo: the concrete, reusable lessons
from a session (environment quirks, tooling limits, process gotchas), so the next session starts
smarter. Anything that becomes a durable rule moves to `CLAUDE.md`.

## Writing one

At the end of a session, add **one new file**:

```
docs/agent-experience/YYYY-MM-DD-<short-slug>.md
```

```markdown
## 2026-10-06 — what the session was about (#issue, #pr)

- **The lesson, in one bold sentence.** Why it matters and what to do instead, concretely:
  file names, commands, the error you saw.
```

- **Never edit someone else's file, and never append to `../agent-experience.md`.** That file is
  the frozen archive up to 2026-10-06. Up to then, every PR appended to its end, so any two open
  PRs conflicted there. GitHub then marks the PR un-mergeable and runs **no CI on it at all**, so
  the PR sits silently. A new file per session has no shared lines, so it cannot conflict.
- Two sessions on the same day with the same slug would collide on the file name. Make the slug
  specific (`2026-10-06-a11y-hover-gate.md`, not `2026-10-06-fixes.md`).

## Reading

At the start of a session, read the newest files here (`ls -r docs/agent-experience/ | head`)
and skim the archive, [`../agent-experience.md`](../agent-experience.md). Its lessons still apply.
