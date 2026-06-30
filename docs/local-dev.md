# Local development — running the app and logging in

The production/preview database (`crm-preview.ersah.in:3306`) is **closed to the
public internet by design** — that's why a fresh local checkout shows:

> Can't reach database server at `crm-preview.ersah.in:3306`

You do **not** need to open that port (doing so would be a security regression).
Use a **local database** instead. Two options, recommended first.

---

## Option A — Local MySQL via Docker (recommended)

A throwaway MySQL on your machine, isolated from the shared preview data. The
container binds to `127.0.0.1` only, so it is never reachable from the network.

```bash
# 1. Start the local DB (first run pulls mysql:8).
docker compose -f docker-compose.dev.yml up -d

# 2. Point the app at it. Create .env.local (gitignored) with:
#    DATABASE_URL="mysql://crm:crm@127.0.0.1:3306/internship_crm"
#    NEXTAUTH_URL="http://localhost:3000"
#    NEXTAUTH_SECRET="dev-secret-change-me"
cp .env.example .env.local   # then edit DATABASE_URL as above

# 3. Create the schema and a first admin. Prisma's CLI reads .env, so pass the
#    local URL inline (keeps your real .env untouched):
DATABASE_URL="mysql://crm:crm@127.0.0.1:3306/internship_crm" npx prisma db push

DATABASE_URL="mysql://crm:crm@127.0.0.1:3306/internship_crm" \
  SEED_ADMIN_EMAIL="admin@local.test" \
  SEED_ADMIN_PASSWORD="admin12345" \
  SEED_ADMIN_NAME="Local Admin" \
  npx prisma db seed

# 4. Run the app and log in with the seeded admin.
npm run dev
```

Sign in at <http://localhost:3000> with `admin@local.test` / `admin12345`.

Stop the DB with `docker compose -f docker-compose.dev.yml down` (add `-v` to
also wipe the data volume and start fresh).

> **Why `.env.local`?** Next.js loads `.env.local` ahead of `.env`, so the app
> uses your local DB while your committed-nowhere `.env` (if any) is left alone.
> The Prisma **CLI** only reads `.env`, hence the inline `DATABASE_URL=` prefix
> on the `prisma` commands above.

---

## Option B — SSH tunnel to the preview DB (quick, but shared data)

If you specifically need the **preview data**, forward the remote DB over SSH
instead of exposing the port. The tunnel rides your existing authenticated SSH
session; nothing new is opened to the internet.

```bash
# Forward local 127.0.0.1:3307 → the DB's localhost:3306 on the server.
ssh -N -L 3307:127.0.0.1:3306 root@ersah.in
```

Then in `.env.local`:

```
DATABASE_URL="mysql://<preview-user>:<preview-pw>@127.0.0.1:3307/internship_crm_preview"
```

⚠️ This is the **shared preview DB**. Do **not** run `prisma db push` against it
(it mutates everyone's preview), and don't use it for tests. Prefer Option A for
day-to-day development. (Port `3307` avoids clashing with a local DB on `3306`.)

---

## E2E tests

`npm run test:e2e` boots its own dev server and needs a reachable DB — point it
at the local DB (Option A). CI runs the suite against an isolated MySQL service,
so the shared preview DB is never required for tests.
