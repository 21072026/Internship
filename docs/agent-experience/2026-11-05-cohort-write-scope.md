# 2026-11-05 — Cohort writes scoped to tenant and grant (#3576)

- **`requirePermission(permission)` without a subject checks the tier only.**
  A route that then writes `where: { id }` is a cross-tenant write while
  `MT_ENFORCE_ISOLATION` is off. Load the row inside `tenantWhere(session)`
  and pass it as the subject, or use a gate that does both
  (`programWriteGate()` for programmes).
- **Reproduce before fixing.** The new @smoke spec was run against the old
  build first: the cross-tenant PATCH answered 200. A test that only ever ran
  against the fix proves nothing about the hole.
- **`check:route-auth` counts only four guard calls in the route file.** A
  shared gate in `src/lib` does not count; read the session in the route
  (`getServerSession(authOptions)`) and pass it in — the guard list is narrow
  on purpose, so don't widen it.
- **MariaDB stops when the worker restarts.** `Can't reach database server`
  in the WebServer log means `service mariadb start`, not a test failure.
