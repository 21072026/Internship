# 2026-10-12 — never touch `prisma` at module load (#1608)

- **`src/lib/prisma.ts` is in some client bundles.** A few client components reach it
  through a shared import graph (the CV-review card and the profile-enrichment panel did
  in #2890). In a browser bundle `prisma` is Prisma's stub, which throws on ANY property
  access — so it is harmless only while nothing reads it when the module is evaluated.
  #2890's first push called `prisma.$use(...)` at module load and crashed `/portal/profile`
  and `/mentor/profile` client-side ("PrismaClient is unable to run in this browser
  environment"); the server log showed nothing, because the error never reached the server.
  Anything added to `prisma.ts` at module level must be behind `typeof window === 'undefined'`.
- **How it was found:** two @smoke specs failed with "element not found" and an error
  boundary in the page snapshot, and no server error. A one-off Playwright probe with
  `page.on('pageerror')` printed the real exception in seconds — do that before reading
  server logs when a page shows "Something went wrong" and the server is quiet.
- **Local smoke runs against an external `BASE_URL` skip Playwright's mock servers**
  (audit sink, HIBP mock, Google mock), so `audit-stream` and `password-policy` fail locally
  for that reason alone. Read their failures as environment, not regression.
