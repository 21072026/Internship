# Onboarding — Internship CRM

Welcome 👋 This guide takes you from zero to *running the app locally and understanding how it
works*. Plan for ~30 minutes. If you only read one other file afterwards, read
[`CLAUDE.md`](CLAUDE.md) — it is the dense architecture reference.

> **Goal of this app:** replace a spreadsheet-based mentoring workflow. Mentors follow each
> mentee through a hiring pipeline (first contact → internship → hired) and log every
> interaction. Three roles — **Admin**, **Mentor**, **Mentee** — each with its own dashboard.

---

## 1. Prerequisites

- **Node.js 20+** and npm
- **Docker** (easiest way to get a local MySQL) — or any MySQL 8 you can reach
- **git** and a GitHub account with access to the repo

## 2. Clone

```bash
git clone https://github.com/21072026/Internship.git
cd Internship
npm install        # postinstall runs `prisma generate` for you
```

## 3. Start a local database

The app needs MySQL. The quickest local option is a throwaway Docker container:

```bash
docker run --name crm-mysql -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=internship_crm -p 3306:3306 -d mysql:8
```

That gives you `mysql://root:root@localhost:3306/internship_crm`.

## 4. Configure environment

```bash
cp .env.example .env
```

Then edit `.env`. The minimum to boot the app:

| Variable | Local value |
|----------|-------------|
| `DATABASE_URL` | `mysql://root:root@localhost:3306/internship_crm` |
| `NEXTAUTH_URL` | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | any random string — `openssl rand -base64 32` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | e.g. `admin@example.com` / `ChangeMe123!` |

SMTP vars are only needed if you want invites/reminder emails to actually send — leave the
placeholders for local work; email just no-ops/logs.

## 5. Create the schema and the first admin

This project uses **`prisma db push`** (there is **no `migrations/` folder** — don't write SQL
migrations).

```bash
npx prisma db push    # creates the tables from prisma/schema.prisma
npx prisma db seed    # creates the first ADMIN (from SEED_ADMIN_* above) + 4 seed companies
```

## 6. Run it

```bash
npm run dev           # http://localhost:3000
```

Open http://localhost:3000, sign in with your `SEED_ADMIN_*` credentials → you land on
`/admin`. 🎉

### Want realistic data to click around?

```bash
node scripts/seed-dummy.mjs --count=30
```

Generates fake mentors + mentees with cities, universities, skills, pipeline stages, companies,
and interaction history. (It refuses to wipe a DB literally named `internship_crm` without
`--force`, so it's safe to run locally for *adding* data.)

---

## 7. A 5-minute tour of the code

```
src/
  app/
    api/            # backend: route handlers (auth, register, invite, mentorship, account, ...)
    admin/          # Admin pages — invite users, browse candidates, assign mentorships, companies
    mentor/         # Mentor pages — own mentees, board, interaction logs
    portal/         # Mentee pages — own profile, assigned mentor/company
    auth/           # sign-in
    layout.tsx      # root layout: reads locale, wires providers
  components/ui/    # Button, Card, Input, Select, Badge, ... (the design primitives)
  components/       # ResponsiveShell (app shell), LanguageSwitcher, forms
  lib/
    auth.ts         # NextAuth config (Credentials + JWT) — start here for "how login works"
    prisma.ts       # Prisma client singleton
    pipeline.ts     # the pipeline stages + their EN/TR labels
  i18n/             # the EN/TR translation system (cookie-based locale, default English)
  services/
    emailService.ts # SMTP + node-cron reminders
prisma/
  schema.prisma     # ⭐ the source of truth for the data model — read this first
  seed.mjs          # first-admin + companies seeder
e2e/                # Playwright smoke tests (run as a CI gate on every PR)
```

**Where to start reading, in order:**
1. [`prisma/schema.prisma`](prisma/schema.prisma) — the data model: `User` (role), `MentorshipRelation`, `InteractionLog`, `Company`, `InvitationToken`, `StatusChange`.
2. [`src/lib/pipeline.ts`](src/lib/pipeline.ts) — the core domain concept (see below).
3. [`src/lib/auth.ts`](src/lib/auth.ts) — authentication & sessions.
4. [`src/app/admin/page.tsx`](src/app/admin/page.tsx) — a real page that ties it together (dashboard with the pipeline distribution).

## 8. The one concept to understand: the pipeline

`MentorshipRelation.pipelineStatus` mirrors the original spreadsheet's status column. A mentee
moves through these stages (the number is the legacy spreadsheet code):

```
APPLICATION_100 → APPROVAL_PENDING_220 → INTERVIEW_PENDING_250 → INTRODUCTION_PENDING_270
→ INTERNSHIP_STARTING_300 → INTERNSHIP_IN_PROGRESS_450 → INTERNSHIP_COMPLETED_490
→ JOB_SEEKING_500 → HIREABLE_600 → HIRED_660 → EMPLOYED_700
   (+ INTERNSHIP_DROPPED_460, INTERNSHIP_FOUND_ELSEWHERE_800)
```

- Default is `APPLICATION_100`.
- An admin/mentor can move a mentee **forward or backward** (e.g. 700 → 200); every change is
  recorded append-only in the `StatusChange` table, so the history is preserved.
- The UI labels are localized (EN/TR) in `src/lib/pipeline.ts` — the enum *ids* stay English.

## 9. Run the tests

```bash
npm run test:e2e          # Playwright smoke tests (boots the app, headless)
npm run test:e2e:headed   # same, with a visible browser — nice for learning the flows
```

These also run in CI on every PR against an isolated MySQL service, so a regression fails the
check before merge.

---

## 10. How we work (so your first PR fits in)

- **Schema first:** change `prisma/schema.prisma`, then
  `npx prisma format && npx prisma validate && npx prisma generate`. Sync with `db push`.
- **Branch + PR per change.** Branch names: `feat/<issue>-slug`, `fix/<issue>-slug`,
  `docs/...`. Reference the issue with `Closes #N`.
- **Never commit secrets** — real values live only in server env / GitHub secrets.
- Work is tracked on the **GitHub Project board** (Epics #5–#11, stories #12+); move your issue
  to the matching column as you go.
- Merging to `main` **deploys to production** — leave merges to a human unless told otherwise.
- See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full checklist.

## 11. Stuck?

| Symptom | Fix |
|---------|-----|
| Schema-drift 500s after switching branches | `npx prisma generate` (stale client vs schema) |
| `db push` / queries can't connect | Check the MySQL container is up and `DATABASE_URL` host/port match |
| Login fails right after seeding | Make sure `SEED_ADMIN_*` in `.env` match what you type |
| Special chars in DB password | URL-encode them in `DATABASE_URL` (e.g. `&` → `%26`) |

Welcome aboard — clone it, run it, click around as the admin, then read `schema.prisma` and
`pipeline.ts`. That's 90% of the mental model. 🚀
