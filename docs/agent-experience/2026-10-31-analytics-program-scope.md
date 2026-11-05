## 2026-10-31 — analytics overview for a program admin (#1577)

- **An existing filter is the cheapest scope.** `loadAdminAnalytics()` already narrowed every
  relation-based number by `?program=`; a PROGRAM_ADMIN's grants became one more conjunct on the
  same `relWhere` (`filtered = true`), so interactions, meetings, projects and mentor workload
  followed without new queries. Check what the filter does NOT cover — here the signup funnel and
  the programme picker were tenant-wide and needed their own narrowing.
- **Open one aggregate route at a time.** Each analytics sub-route computes its own numbers; a
  route opened without its own narrowing leaks tenant totals. Until narrowed, `requirePermission`
  without `listing` keeps it a 403 for the tier.
