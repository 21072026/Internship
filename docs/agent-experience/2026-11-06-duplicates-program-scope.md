## 2026-11-06 — duplicates and the program scope (#1577)

- **Before narrowing a route for a PROGRAM_ADMIN, check whether the tier reaches it at all.**
  `requirePermission(perm)` without `listing` and without a subject already refuses the tier
  (`unscoped_subject`), and `scripts/authz-baseline.json` has no `pending` role-string checks left —
  so a route is only open to the tier where it says `listing: true` or passes a subject. `grep -rln
  "listing: true" src` lists every route that must narrow; that is the whole audit surface.
- **After main moves on, run `npm ci`, not `npm install`.** A dependency bump on main (zod here)
  leaves `node_modules` stale and `tsc` fails on APIs that exist; `npm install` also rewrites
  `package-lock.json` locally and turns `check:licenses` red for a reason that is not yours.
