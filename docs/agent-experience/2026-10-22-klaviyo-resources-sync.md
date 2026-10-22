## 2026-10-22 — Klaviyo connector beyond profiles (lists, segments, events, campaigns, flows)

- **A brief can describe code that is not in this repo.** The task said the app called
  `GET /api/segments/{id}/profiles` with `revision: 2024-10-15`; neither the endpoint nor the
  date appeared anywhere in the tree or in 2 758 commits of history (`git log --all -S`). The
  real connector already existed (#2985/#2986, revision 2026-07-15). Say so in the plan
  before designing against the brief's picture.
- **Klaviyo filters events by when they happened, not when it received them.** A clock-based
  cursor (`since = pass start − 5 min`) silently misses an event an integration delivers hours
  late. The e2e caught it (an event dated "yesterday" never arrived). Fix: a daily catch-up pass
  that re-reads from the previous catch-up's start (`eventsWindowStart`), with `skipDuplicates`.
- **The reporting API is POST-only.** `campaign-values-reports` is a read-only query by body,
  and the steady limit is 2/min (225/day). "GET only" needed one explicit, allowlisted
  exception (`KLAVIYO_QUERY_POST_PATHS`); pace it ≥ 31 s and never let a manual "sync now"
  force it.
- **`npx tsc --noEmit` dies of OOM here at the default heap.** Run it with
  `NODE_OPTIONS=--max-old-space-size=8192`; it then finishes in a few minutes.
- **`prisma validate` needs `DATABASE_URL` even for a pure schema check.** Any dummy
  `mysql://…` value works.
- **A Prisma `updateMany` can be guarded through a required relation**
  (`where: { id, connection: { sealedKey } }`). That is how a per-resource cursor write refuses
  to land after the connection's key was replaced mid-run, without a second lookup.
- **The Playwright 1248 headless-shell link from the 2026-10-21 note works for `chromium-1248`
  too:** link `/opt/pw-browsers/chromium-1194/chrome-linux` as `chromium-1248/chrome-linux64`
  and touch `INSTALLATION_COMPLETE`.
