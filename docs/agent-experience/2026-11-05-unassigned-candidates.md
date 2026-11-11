# 2026-11-05 — Unassigned candidates (#1440)

- **Check what a count actually counts before you label it.** The dashboard's
  stage bars group relations of any status, not only active ones. A note that
  said "active pairings" would have been wrong, so it says "pairings, not people".
- **A filter value that shares a parameter with stage keys must be impossible
  as a key.** `unassigned` is reserved lower-case; stage keys are upper-case
  enum names or a tenant's own `[A-Za-z0-9_]+`.
- **Issues can be stale in both directions.** #1700 (timeline API) is still
  open although the route and its UI (#1702) shipped. Check the tree before you
  pick a task.
