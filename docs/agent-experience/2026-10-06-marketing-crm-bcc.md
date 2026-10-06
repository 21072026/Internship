## 2026-10-06 — marketing backlog: postal campaigns, sales channels, deal value, BCC-to-CRM (#2697, #2408, #2424, #2809)

- **`findUserInWorld` / `findUsersInWorld` only normalise case and whitespace — pass a bare
  address.** A mail header `From: Rep <rep@x.de>` went straight in and matched nobody, so the
  sender check rejected real staff (e2e 403 "not staff"). Extract the address first
  (`addressesIn()` in `src/lib/crmBccRule.ts`, or `emailOf()` in `src/lib/inboundEmail.ts`).
- **Pick a new Prisma field name no longer than the model's longest existing one.** `prisma
  format` re-aligns every field of the model when a longer name lands, so a one-column change
  showed as a 20-line diff. `sourceRef` instead of `externalRef` kept it to the added lines.
- **Adding a `@@unique` to an existing table makes local `db push` stop and ask for
  `--accept-data-loss`.** That is a warning about possible duplicates, not data loss; the deploy
  already runs with the flag, and `npm run check:schema-push` is the guard that matters (a
  nullable column + composite unique passes it).
- **A route file may export only HTTP handlers, and a lib that imports `next/headers` cannot be
  loaded by `node --test`.** Keep zod schemas in a `*Input.ts` beside the route, and split any
  request-bound wrapper into its own file (`imprint.ts` vs `imprintRequest.ts`).
- **Running a whole e2e file at once in this container can OOM-kill the worker (exit 137).**
  Commit and push first, then run specs one at a time.
