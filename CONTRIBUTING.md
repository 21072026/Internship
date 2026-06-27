# Contributing

Thanks for contributing to Internship CRM. This guide covers the workflow.

## Workflow

1. **Branch** off `main`: `feat/<issue>-slug`, `fix/<issue>-slug`, `docs/...`, `test/...`.
2. **Commit** in small, focused changes. Reference the issue (`Closes #123`).
3. **Open a PR** into `main`. CI must pass before merge (see below).
4. `main` is protected: merging requires the **CI**, **Playwright smoke** and
   **Preview Deploy** checks to be green and the branch to be up to date.

## Local checks (run before pushing)

```bash
npm run lint          # ESLint
npx tsc --noEmit      # type check
npx prisma validate   # schema check
npm run build         # production build
npm run test:e2e      # Playwright (starts the app; needs a DB)
```

## Database & schema

- This project uses **`prisma db push`** — there is **no `migrations/` folder**.
- Change `prisma/schema.prisma`, then `npx prisma generate`. After switching
  branches, regenerate so the client matches the schema.
- Do **not** run `db push` against the shared preview/prod DB — CI does it on deploy.

## Tests

- E2E tests live in `e2e/` (Playwright). Add one for each user-facing change.
- Tests seed their own data via `e2e/helpers/db.ts` and clean up after.

## Conventions

- Match the surrounding code's style; keep components small.
- User-facing strings go through the i18n dictionary (`src/i18n/dictionaries.ts`)
  via `useT()` (client) or `getServerDictionary()` (server).
- Co-author trailer on commits when pairing with an assistant.

## Deployment

Push to `main` deploys production; every PR deploys a preview. See
[CLAUDE.md](CLAUDE.md) for the full architecture and deploy topology.

## Project board

New issues/PRs should appear on the board automatically. If they don't, enable
the built-in **Auto-add to project** workflow in the Project's *Workflows*
settings (no token needed) — this is preferred over a GitHub Action (which would
require a PAT with `project` scope).
