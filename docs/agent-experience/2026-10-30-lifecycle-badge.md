# 2026-10-30 — lifecycle badge (#1774), and a smoke break from #3448

- **`e2e/text-limits-columns.unit.spec.ts` has a rule the registry check does
  not:** every VARCHAR-backed TEXT_LIMITS constant must also refuse a
  250-character paste. `check:text-limits` passed for a 500 cap on a
  VARCHAR(500) column; the smoke spec failed on main. Run that spec (it is a
  browserless `*.unit.spec.ts`, ~3 s with `BASE_URL=http://localhost:9`)
  whenever you add a TEXT_LIMITS entry.
- **Don't change a query parameter many callers share.** `/api/mentorship?status=`
  is read by boards, dashboards and composers; the lifecycle filter got its own
  `lifecycle=` parameter instead of redefining `status=COMPLETED`.
- **Replacing ad-hoc chips**: existing specs targeted their testids; move them
  to the new component's testid (and `data-state`) in the same PR.
