## 2026-10-30 — program-scoped delegated admin (#1577)

- **An ADMIN builder returning `{}` is a tier decision, not a role one.** `scopeForRole()` answered
  "the whole tenant" for every ADMIN, so the first PROGRAM_ADMIN with a grant read every relation
  through `GET /api/mentorship`. The tier and grants are now loaded live inside `scopeForRole()`;
  the pure half (`roleScope`) takes them as `adminLevel` / `grants` on the user and is unit-tested
  without a database.
- **`can(actor, perm, undefined)` is already fail-closed for a PROGRAM_ADMIN** (`unscoped_subject`).
  Before calling a route "leaky", check whether it asks the rule with no subject — then it is a
  403, not a leak, and the work is to *open* it with a subject, not to close it.
- **A retarget write needs the subject checked twice.** Checking only the row before the write let a
  scoped admin move a relation out of (or strip the cohort from) its own scope; check the merged
  after-state with the same rule.
- **`npm run build` OOMs at the default heap here.** Run it with
  `NODE_OPTIONS=--max-old-space-size=8192`.
- **Read the tier table before opening a route to a tier.** Bulk edit asks `user.write`, which
  PROGRAM_ADMIN does not hold; a grant check there would be dead code. The one rule
  (`TIER_PERMISSIONS`) decides *whether*, the grants only decide *where*.
- **Server components and cron mails are the forgotten readers.** `grep -rl "@/lib/prisma"
  src/app/admin` found the dashboard and the re-engagement page; following
  `getSystemMenteeActivity` found the daily digest mail. Fan-outs to "every active ADMIN" are
  a whole class of their own (#3485).
