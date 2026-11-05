# 2026-11-05 — scale seed and admin screens at 5 000 (#1434)

- **Measure a production build, and put the numbers side by side only within one container.**
  After a session restart the container is a different machine: `/auth/signin` did 59 req/s on
  10-31 and 35 req/s on 11-05 for the same code. Throughput comparisons across days or sessions mean
  nothing; byte sizes and same-run before/after comparisons do.
- **The i18n scope scan counts string literals as namespace names.** A role union like
  `'admin' | 'mentor'` in a client file ships the whole `mentor` namespace. Move such a union behind
  `import type`, which the scanner does not follow. `node scripts/i18n-scopes.mjs --why=<ns> --scope=<dir>`
  names the file. `--why` exits before writing, so regenerate before you read `scopes.generated.ts`.
- **Seeding thousands of rows:** `createMany` in batches of 500 with `skipDuplicates` finishes 5 000
  users in about 2 s against local MariaDB. Read back the ids for the relations with one `findMany`.
- **The page-load measurement** used a one-off Playwright script: sign in, `goto(…, { waitUntil:
  'networkidle' })`, and `requestfinished` → `req.timing().responseEnd` per same-origin request. It
  gives "slowest request per page" without any instrumentation in the app.
