# Public demo instance

A separate deployment that anyone can sign into and actually use, running the
same image as production against its **own** database full of synthetic data
(`prisma/seed-demo.mjs`). Tracking issue: **#966**.

| | |
|---|---|
| URL | `https://crm-demo.ersah.in` |
| Container | `internship-crm-demo` |
| Port | 3203 |
| Database | `internship_crm_demo` (its own — **not** the shared preview DB) |
| Env file | `/etc/internship-crm/demo.env` |
| Reset | `.github/workflows/demo-reset.yml` — 02:00 and 14:00 UTC, plus manual |

## The design in one paragraph

`DEMO_MODE=true` turns the demo on. Writes are allowed **by default** — a demo
where every button returns 403 demonstrates nothing — and only a short, explicit
list is refused (`DEMO_BLOCKED_WRITES` in [`src/lib/demoMode.ts`](../src/lib/demoMode.ts)).
Email is never delivered: `sendEmail()` records a `SKIPPED` row instead, so the
invite and reminder flows stay clickable and the admin email log even shows what
would have gone out. Resetting is an **operational job**, not an endpoint: a
scheduled workflow runs `prisma/reset-demo.mjs` on the server.

## Why there is no `/api/demo/reset`

A reset truncates every table in the database it is pointed at. Exposing that
over HTTP means a secret in an env file, a route that can be called by anyone who
learns it, and a path that could be aimed at the wrong database if `DEMO_MODE`
were ever copied into the wrong env file. None of that buys anything: the
scheduler already runs on the box. So the destructive path stays off the public
internet entirely.

`prisma/reset-demo.mjs` additionally refuses unless **both** hold:

1. `DEMO_MODE=true`, and
2. the database **name ends in `_demo`**.

(2) is the guard that matters, and it has no override flag. An env flag can be
copied into the wrong file by accident; a database name cannot be, because
production's is `internship_crm` and the shared preview's is
`internship_crm_preview`. Neither can ever satisfy the check, whatever
`DEMO_MODE` says. [`infra/test/reset-demo-guard.test.sh`](../infra/test/reset-demo-guard.test.sh)
asserts exactly that, against those two real names, and runs in CI.

## What the demo refuses, and why

Three categories, all in `DEMO_BLOCKED_WRITES`:

1. **Account takeover / lockout** — the logins are shared, so one visitor
   changing a password or erasing an account would end the demo for everyone
   until the next reset. (`/api/account`, `/api/account/2fa`,
   `/api/account/sign-out-all`, admin erase + reset-password.)
2. **Reach outside the demo** — a webhook POSTs from the production host to any
   URL the caller names, an API key is a real credential, and the mail tester
   takes an arbitrary recipient. (`/api/admin/webhooks`, `/api/admin/api-keys`,
   `/api/admin/email-test`, `/api/admin/import`.)
3. **Arbitrary file storage** — uploads let an anonymous visitor park whatever
   they like on the box. (`/api/cv`, `/api/avatar`, `/api/documents`,
   `/api/support/attachments`, announcement images.)

Everything else — the pipeline, interactions, projects, offers, requisitions,
reports — is genuinely writable. That is the point of the demo.

`npm run check:demo-blocklist` runs in CI and fails the build if a pattern stops
matching any real route (i.e. a route was renamed and the demo quietly started
accepting it again), or if one of the must-block routes is left uncovered.

## Server prerequisites

The app side ships with this document; the environment itself is one-time setup:

```bash
# 1. the demo's own database
mysql -e "CREATE DATABASE internship_crm_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql -e "GRANT ALL ON internship_crm_demo.* TO 'crm-demo'@'%' IDENTIFIED BY '<password>'"

# 2. /etc/internship-crm/demo.env  (chmod 600)
#    DATABASE_URL=mysql://crm-demo:<password>@host.docker.internal:3306/internship_crm_demo
#    NEXTAUTH_URL=https://crm-demo.ersah.in
#    NEXTAUTH_SECRET=<a secret of its own — never production's>
#    DEMO_MODE=true
#    SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME
#    NEXT_PUBLIC_APP_ENV=preview
#    Deliberately NO SMTP_*: mail is skipped in demo mode anyway, and leaving the
#    credentials off the box means a mistake cannot send anything.

# 3. Plesk vhost for crm-demo.ersah.in -> 127.0.0.1:3203

# 4. first fill
gh workflow run demo-reset.yml
```

Once `/etc/internship-crm/demo.env` and the container exist, nothing else is
manual: the scheduled workflow keeps the **data** fresh, and every preview
deploy puts the demo on the **image** it just shipped (#1249).

## How it stays current

Both halves run the same script, `infra/server/demo-refresh.sh`, so the two
paths cannot drift into doing different things to the same environment:

| | Trigger | What it does |
|---|---|---|
| `--data-only` | `demo-reset.yml`, 02:00 and 14:00 UTC | wipe → schema → seed |
| `--image <ref>` | `deploy-preview.yml`, after every preview deploy | recreate the container on that image, **then** wipe → schema → seed |

The image path re-seeds too, deliberately: a new image can move the schema, so
the data has to be rebuilt against it rather than left in place. It is a no-op
when the demo already runs that image.

Two properties worth keeping if this is ever rewritten:

- **Not provisioned is not a failure.** If `demo.env` or the container is
  missing the script exits 0 saying so. The demo is optional; a preview deploy
  must not go red because an optional environment was never set up here. The
  job is `continue-on-error` for the same reason — the deploy's verdict is
  about *preview*.
- **Nothing is passed in from CI.** The container is started with
  `--env-file /etc/internship-crm/demo.env`, so the demo's own configuration
  never enters an Actions log, and the tools run *inside* the container with
  exactly the image, Prisma client and `DATABASE_URL` the demo itself uses.

Why this exists: the container was provisioned on 2026-08-19 and nothing
updated its image again, while `demo-reset.yml` refreshed the data twice a day
— so the demo *looked* maintained as the software inside it aged. Measured on
2026-08-24 before the fix: **0.78.0-beta on the demo against 0.105.0-beta on
prod and preview**, 27 minor versions apart, with the landing page sending
visitors straight to it.

## Not included yet

- ~~**A link from the landing page.**~~ Shipped: the environment was provisioned
  on 2026-08-19 (DB + `/etc/internship-crm/demo.env` + container on :3203 +
  Plesk vhost, exactly the prerequisites above) and the landing page now links
  to the demo from the hero (`hero-demo-cta`), the bottom CTA block and the
  public footer, plus a `features.ts` catalogue entry. All of them read
  `DEMO_URL` from `src/lib/demoMode.ts` and are hidden on the demo instance
  itself.
- **OpenGraph social cards and product analytics.** These arrived in the same
  original PR (#1221) but are separate concerns with their own trade-offs (a
  permanently widened CSP, and third-party trackers on authenticated CRM pages
  that would need wiring into the existing `UserConsent` model). They are not
  part of the demo and were left for their own review.
