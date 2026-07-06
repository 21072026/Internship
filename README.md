# Internship CRM

Mentor ↔ Mentee CRM & internship management system. Tracks each mentee through a hiring
pipeline (first contact → internship → hired), with interaction logging, role-based
dashboards, and email reminders. Built to replace a spreadsheet-based mentoring workflow.

## Features

- **Role-based access** — Admin, Mentor, Mentee, each with its own dashboard.
- **Mentorship pipeline** — granular status per mentee (`APPLICATION_100` … `EMPLOYED_700`).
- **Interaction logs** — meetings / feedback / emails per mentorship.
- **Candidate browsing & matching** — search/filter mentees, assign mentors & companies.
- **Invitation-based registration** — email tokens with role assignment.
- **Email reminders** — cron nudges mentors with stale (14-day) mentees.

## Tech stack

Next.js 15 (App Router) · React 19 · TypeScript · Prisma 5 · MySQL · NextAuth 4 ·
Tailwind CSS · Nodemailer · Docker.

## Architecture

```mermaid
flowchart LR
  U[Browser] --> P[Next.js App Router]
  P --> API[/api routes/]
  API --> PR[Prisma]
  PR --> DB[(MySQL)]
  AUTH[NextAuth JWT] --- API
  CRON[node-cron] --> MAIL[SMTP / Nodemailer]
  CRON --> PR
```

## Pipeline stages

```mermaid
stateDiagram-v2
  [*] --> APPLICATION_100
  APPLICATION_100 --> APPROVAL_PENDING_220
  APPROVAL_PENDING_220 --> INTERVIEW_PENDING_250
  INTERVIEW_PENDING_250 --> INTRODUCTION_PENDING_270
  INTRODUCTION_PENDING_270 --> INTERNSHIP_STARTING_300
  INTERNSHIP_STARTING_300 --> INTERNSHIP_IN_PROGRESS_450
  INTERNSHIP_IN_PROGRESS_450 --> INTERNSHIP_COMPLETED_490
  INTERNSHIP_IN_PROGRESS_450 --> INTERNSHIP_DROPPED_460
  INTERNSHIP_IN_PROGRESS_450 --> INTERNSHIP_FOUND_ELSEWHERE_800
  INTERNSHIP_COMPLETED_490 --> JOB_SEEKING_500
  JOB_SEEKING_500 --> HIREABLE_600
  HIREABLE_600 --> HIRED_660
  INTERNSHIP_COMPLETED_490 --> EMPLOYED_700
  HIRED_660 --> [*]
  EMPLOYED_700 --> [*]
```

## Local setup

```bash
# 1. Install
npm install

# 2. Configure env
cp .env.example .env        # then fill DATABASE_URL, NEXTAUTH_SECRET, etc.

# 3. Sync DB schema (this project uses db push, not migrations)
npx prisma db push

# 4. Create the first admin
npx prisma db seed          # uses SEED_ADMIN_* env (default admin@example.com / ChangeMe123!)

# 5. Run
npm run dev                 # http://localhost:3000
```

### Required environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | MySQL connection string |
| `NEXTAUTH_URL` | App base URL |
| `NEXTAUTH_SECRET` | NextAuth signing secret |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Email (invites, reminders) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME` | First admin (seed, optional) |

See [`.env.example`](.env.example) for the full list.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | Lint (`next lint`) |
| `npm run check:i18n` | Verify EN/TR/DE dictionary key parity and catch empty translations |
| `npm run test:e2e` | Playwright smoke tests (add `:headed` to watch) |
| `npm run test:e2e:headed` | Run the same Playwright smoke tests in a visible browser |
| `npm run import:csv` | Dry-run or apply the legacy mentoring CSV import; pass `--file` or `--url` |
| `npm run postinstall` | Generate the Prisma client after dependency installs |
| `npm run seed:templates` | Seed starter document templates when an admin user exists |
| `npm run db:dev:up` | Start the local MySQL Docker Compose database |
| `npm run db:dev:down` | Stop the local MySQL Docker Compose database |
| `npx prisma db push` | Sync schema to DB |
| `npx prisma db seed` | Seed first admin |

## Testing

Several kinds of test guard the app — functional E2E, accessibility, security,
XSS/injection, and a nightly **stress/load** test. See [`docs/testing.md`](docs/testing.md)
for the full map and configuration.

End-to-end tests live in [`e2e/`](e2e/) (Playwright). They cover the home page,
sign-in, admin login, and that the admin pages render without server errors.

```bash
npm run test:e2e            # starts the app and runs headless
npm run test:e2e:headed     # visible browser
BASE_URL=https://crm-preview.ersah.in npm run test:e2e   # against a deployed env

npm run test:stress         # load test (see docs/testing.md for thresholds/env)
```

CI runs the E2E suite on every PR ([`.github/workflows/e2e.yml`](.github/workflows/e2e.yml))
against an isolated MySQL service, so a regression fails the check before merge. A
scheduled workflow ([`.github/workflows/stress.yml`](.github/workflows/stress.yml)) runs
the stress test nightly and **emails the team on failure**.

## Deployment

CI/CD via GitHub Actions ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)):
push to `main` deploys **production**; every PR deploys a **preview**.

| Environment | URL | Trigger |
|-------------|-----|---------|
| Production | https://crm.ersah.in | push to `main` |
| Preview | https://crm-preview.ersah.in | pull requests |

The pipeline builds a Docker image, pushes it to GitHub Container Registry, then SSHes to the
Plesk host to run the container and apply the schema with `prisma db push`.

## Project structure

```
src/app/        # App Router pages + /api routes (admin, mentor, portal, auth, onboarding)
src/components/ # UI primitives + forms
src/lib/        # auth + prisma client
src/services/   # email + cron
prisma/         # schema.prisma + seed
```

## Contributing

Work is planned on a GitHub Project board as Epics (#5–#11) and Stories (#12+). Branch per
issue (`feat/<issue>-slug`), open a PR, reference `Closes #N`. For AI-agent guidance see
[CLAUDE.md](CLAUDE.md).
