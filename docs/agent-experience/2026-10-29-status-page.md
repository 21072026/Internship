# 2026-10-29 — public /status page (#1604)

- **A second worktree shares `node_modules` by symlink** (`ln -s ../Internship/node_modules`),
  but then `prisma generate` in either tree rewrites the ONE generated client — never run it
  while the other tree is mid-`next build`. Wait, then generate in the tree you test next.
- **Self-measured uptime is honest only if gaps count**: the sampler writes from inside the
  app, so a missing 5-minute slot is the downtime signal. That is why its schedule has
  `catchUp: 'none'` and `maxAttempts: 1` — a back-filled slot would hide the outage.
- A new top-level `src/app/<dir>` needs a `layout.tsx` with `<I18nScope scope="<dir>">`
  (`check:i18n-scopes`); a server-only page still gets a scope (with 0 namespaces).
- `docs/secrets-and-rotation.md`'s "Switches and tuning" line is a merge-conflict magnet:
  put a new variable on its own line before the `KLAVIYO_*` line instead of mid-line.
- `pkill -f "next dev"` inside a Bash call can kill that call's own shell (its command line
  matches); use `pgrep` then `kill <pid>` in a separate call.
