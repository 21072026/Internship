## 2026-10-27 — triage of the red scheduled nets: backup-verify, k6 nightly, stress weekly (#3166, #2987, #2707)

- **Read the timestamp in a dump's file name before trusting the runbook.** The prod dump was
  `prod-…T024128Z`, i.e. the bootstrap's systemd timer (02:40 + jitter), not the 03:15 root cron the
  README described. The timer runs `/opt/internship-crm/bin/backup-db.sh`, a copy fetched once at
  bootstrap — so the #2989 `chown --reference` fix was in the repo for weeks and never ran on the box.
  A repo fix to a script the server *copies* is not deployed until someone re-fetches it.
- **Preview has no daily backup at all — only its deploy hook.** Four days without a merge to `main`
  (the drift gate turns every scheduled deploy into a no-op) made preview "93h stale". That is a
  schedule gap, not a broken backup; the fix is on the server (a preview timer), not in the check.
- **Find the last green run before reading thresholds.** `actions_list list_workflow_runs` with
  `perPage: 30` overflows the tool output; parse the saved JSON with `python3 -c 'json.load(…)'`
  for `created_at/conclusion`. k6 was green through 10-19 and red from 10-20 with p95 1171 → 1600–1900ms
  on the SSR pages only (`/features`, `/auth/signin`, `/`) while `/api/health*` and the cached JSON
  stayed inside budget — that shape says "Node render saturation", not network and not DB.
- **Every SSR page ships the whole client dictionary.** `src/app/layout.tsx` passes
  `toClientDictionary(...)` to the client on every page: `/features` is ~686 KB uncompressed
  (~214 KB gzip), most of it dictionary. The 10-19 commits grew it only ~1.3%, so it is not *the*
  regression, but it is the per-request cost that makes a shared ARM box tip over. Splitting the
  client dictionary by namespace is the real lever; loosening the budgets would only hide it.
- **One anonymous `curl -w '%{size_download} %{time_starttransfer}'` per page is allowed and tells a
  lot** (k6 rules: GET only, never authenticated, never a rate-limited route) — don't ramp prod from
  a session.
