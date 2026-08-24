# Infra — Wildcard TLS & topic-based preview environments

Runbook for the automation behind [#583](https://github.com/21072026/Internship/issues/583)
(per-topic ephemeral preview environments at `crm-<topic>.ersah.in`).

The whole design rests on **three one-time foundations**, after which spinning a
topic environment up or down is *only* a container + database operation — no DNS
and no certificate work per topic.

| Foundation | Set up once | Per-topic cost afterwards |
|---|---|---|
| Wildcard DNS `*.ersah.in` | 1 Cloudflare A record | none |
| Wildcard TLS `*.ersah.in` | `acme-issue-wildcard.sh` | none |
| Reverse-proxy routing | see "Routing" below | tiny generated vhost (CI) |

---

## 1. Wildcard DNS (Cloudflare)

Add a single record so **every** subdomain resolves to the server:

```
Type: A    Name: *    Content: <server IP>    Proxy: on (orange)    TTL: Auto
```

Now `crm-preview.ersah.in`, `crm-topic5.ersah.in`, `crm-topic9.ersah.in`, … all
resolve without ever touching DNS again.

> Keep the existing explicit records (`crm`, `crm-preview`, …); the wildcard only
> answers names that have no explicit record.

## 2. Wildcard TLS certificate

The error you hit —

```
No TXT record found at _acme-challenge.ersah.in
```

— is because a wildcard cert must be validated with the **DNS-01** challenge, and
nobody had put the challenge TXT there. `infra/acme-issue-wildcard.sh` automates
that end to end with acme.sh + the Cloudflare API (creates the TXT, validates,
removes it), and installs a cron job so **renewals are automatic**.

```bash
# Create a SCOPED Cloudflare API token (My Profile → API Tokens → Custom):
#   Zone → DNS  → Edit
#   Zone → Zone → Read
#   Zone resources → Include → Specific zone → ersah.in
export CF_Token="<scoped token>"        # never commit this; not stored in the repo

./infra/acme-issue-wildcard.sh          # DOMAIN/CERT_DIR/RELOAD_CMD overridable
```

acme.sh saves the token under `~/.acme.sh` (chmod 600) so future auto-renewals
don't need it again.

> **Secret hygiene:** if a Cloudflare token is ever pasted into chat, a commit, or
> any code, treat it as compromised and roll it in Cloudflare immediately. The
> token lives only in the server environment (or a GitHub Actions secret,
> `CF_API_TOKEN`) — never in this repo.

### Alternative: Cloudflare Origin CA
If traffic always goes through Cloudflare's proxy (orange cloud), you can skip
Let's Encrypt entirely: generate a Cloudflare **Origin Certificate** (`*.ersah.in`,
15-year, free), install it once, set SSL mode **Full (strict)**. Lowest
maintenance, but it's dashboard-driven and requires the proxy to stay on. We use
the acme.sh path above because it's fully scripted and proxy-independent.

## 3. Routing `crm-<topic>.ersah.in` → the right container

**Decision: Plesk-native nginx routing** (Plesk keeps owning 80/443, so production
`crm.ersah.in` is untouched). Each topic runs its own container on a derived port
(3300–3399; `topic5` → `3305`). On deploy, `infra/server/topic-deploy.sh` writes a
self-contained nginx server block for `crm-<topic>.ersah.in` into `$NGINX_CONF_DIR`
(default `/etc/nginx/conf.d`) that terminates TLS with the **one** wildcard cert
from step 2 and `proxy_pass`es to the topic's port; teardown removes it. Both
reload nginx afterwards.

### Proxy hops and `TRUSTED_PROXY_COUNT` (#858)

Every vhost sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which **appends**
the peer address to whatever the client sent. The header therefore reads
`<whatever the client made up>, <what nginx actually saw>` and only the
right-hand entries can be trusted. The rate limiter counts back from the right
by `TRUSTED_PROXY_COUNT` hops (`src/lib/rateLimit.ts`).

**One hop today**, so the default of `1` is correct for all three environments.
The wildcard DNS record in step 1 is orange-clouded, but the explicit `crm`
record is not — `curl -sI https://crm.ersah.in` returns no `cf-ray`, i.e. the
request reaches nginx directly. **If a hostname is ever moved behind
Cloudflare's proxy, bump `TRUSTED_PROXY_COUNT` to `2` for it in the same
change**, or every visitor will be bucketed as the Cloudflare edge and one
person's rate limit will throttle everyone.

`0` disables the header entirely — right for a container reached directly, and
what `playwright.config.ts` sets for the e2e webServer.

### One-time server setup this requires
- The stock `include /etc/nginx/conf.d/*.conf;` must be active (default on Plesk).
  These hostnames are **not** Plesk-managed domains (only `crm`/`crm-preview` are),
  so Plesk never rewrites the topic files. If your install uses a different include
  dir, set `NGINX_CONF_DIR` in the deploy step / server env.
- The SSH deploy user must be able to write to `$NGINX_CONF_DIR` and reload nginx
  (a sudoers rule for `NGINX_RELOAD_CMD`, default `nginx -t && systemctl reload nginx`).
- Wildcard cert installed at `$CERT_DIR/ersah.in.cer` + `.key` (step 2 default).

> Alternative considered: a standalone Traefik proxy (container-label auto-routing).
> Rejected for now because it needs to own 80/443, which Plesk holds. If Plesk ever
> stops fronting these, Traefik would remove the nginx-file generation entirely.

---

## How this is wired (#583)

`.github/workflows/topic-preview.yml` gives **every open PR** its own environment,
keyed by PR number — no branch-naming convention needed. The image is **built on a
GitHub-hosted runner** and pushed to ghcr; only the container swap + routing runs
on the server:

- **PR opened / pushed to / reopened** → `build-image.yml` builds and pushes
  `ghcr.io/21072026/internship:topic-pr<N>` on `ubuntu-latest`, then (on the
  self-hosted runner) `infra/server/topic-deploy.sh` pulls it, starts
  `internship-crm-pr<N>` on its derived port (3300–3399, `3300 + N%100`) and
  **routes it through a Plesk subdomain** `crm-pr<N>.ersah.in` (see below). A bot
  comment on the PR carries the URL (updated on every push).
- **Fork PRs get no topic environment** — GitHub keeps their `GITHUB_TOKEN`
  read-only (the image can't be pushed) and withholds repo secrets, and building
  unreviewed fork code on the production host isn't worth working around. `ci.yml`
  + `e2e.yml` still gate them.
- **PR merged/closed** → `infra/server/topic-teardown.sh` removes the Plesk
  subdomain, stops/removes the container + image, and cleans any legacy route.

**Routing is Plesk-native (mirrors crm-preview).** Every site on this box is a
Plesk vhost bound to the server IP (`listen <IP>:443 ssl`); a raw all-addresses
`listen 443 ssl` block in `conf.d` loses the nginx address-group match, so its
`server_name` is never evaluated and requests fall to Plesk's default vhost
(`login_up.php` / 404). So `topic-deploy.sh` instead:
1. `plesk bin subdomain --create crm-pr<N> -domain ersah.in -ssl true` (idempotent),
2. writes the same reverse proxy crm-preview uses into Plesk's supported custom
   include `/var/www/vhosts/system/<fqdn>/conf/vhost_nginx.conf`:
   `location ~ ^/.* { proxy_pass http://0.0.0.0:<port>; … }`,
3. `plesk sbin httpdmng --reconfigure-domain <fqdn>`.
TLS is handled by Plesk (+ Cloudflare at the edge). Teardown does
`plesk bin subdomain --remove`.

Because the runner is on the server, there is **no SSH hop**: `topic-deploy.sh` is
called with `GHCR_USER`/`GHCR_TOKEN` (the run's `GITHUB_TOKEN`, for the pull) and
`ENV_FILE=/etc/internship-crm/preview.env` (secrets sourced directly, same file
`deploy-preview.yml` uses — they never leave the box). It also still accepts
`SKIP_PULL=1` for a locally built image, and the old base64-over-SSH credential
form (`ACTOR`/`B64_TOKEN` + `B64_*`), for a manual deploy from a shell.

**Database: one per topic** (`internship_pr<N>`, #1185). The env file supplies the
MySQL host and credentials; `topic-deploy.sh` creates the topic's own database on
the same server, points the container at it, and fills a *fresh* one with the
synthetic demo set (`prisma/seed-demo.mjs`). A re-push keeps whatever the reviewer
has been clicking on and only brings the schema up to date. `topic-teardown.sh`
drops it when the PR closes; the daily topic sweep drops any that leak.

Two consequences worth stating: a `prisma db push` on one PR no longer reshapes the
schema under every other PR, and **no real preview data is reachable from a topic
environment** — sign in with `admin.demo@demo.example.com` / `DemoPass123!`. The
shared preview env at `crm-preview.ersah.in` keeps its own single database.

Privileges usually need no setup: the script runs as root on the database host,
so if the app user cannot create databases it falls back to the local root
socket and grants the app user access to the one database it just made. If
neither route works the deploy **stops** with the grant to run —

```sql
GRANT ALL PRIVILEGES ON `internship\_pr%`.* TO '<preview-user>'@'%';
```

— rather than falling back to the shared database. Isolation is the point.

### Prerequisites on the server
- Self-hosted runner registered; its user (root here) can run `docker` and the
  `plesk` CLI (`plesk bin subdomain`, `plesk sbin httpdmng`).
- Wildcard DNS `*.ersah.in` → the server (Cloudflare-proxied), so `crm-pr<N>`
  resolves. Plesk issues/uses the subdomain's TLS; Cloudflare terminates at the edge.
- `/etc/internship-crm/preview.env` (chmod 600) with `DATABASE_URL` (the shared
  preview DB), `NEXTAUTH_SECRET`, `SMTP_*`.

### Verified live
Confirmed end-to-end on the live box: opening a PR builds the image, creates the
`crm-pr<N>.ersah.in` Plesk subdomain proxying to the container, comments the URL,
and serves the app (`/api/health` → 200); closing the PR removes the subdomain and
container.

---

## Where the work runs (2026-07-29)

The repo is **public**, so GitHub-hosted standard runners are free and unmetered.
Everything that can run there, does — the server only does what has to happen on
the server:

| Runs on GitHub-hosted | Runs on the server (self-hosted runner) |
|---|---|
| `docker build` + push to ghcr (`build-image.yml`) | read `127.0.0.1:<port>/api/health` for the drift gate |
| lint / typecheck / build (`ci.yml`) | `docker pull` the prebuilt image |
| Playwright smoke gate + 4×/day full suite | `prisma db push` + idempotent seeds/backfills |
| weekly stress test, runner watchdog | stop/start the container, Plesk route, health check |

Nothing on the box compiles anymore. Between 2026-06 and 2026-07-29 it did: with
the private repo's Actions quota exhausted (#636) the builds were moved onto the
self-hosted runner, so the production host ran `npm ci` + `next build` for every
merge **and every push to every open PR**.

### No `uses:` in a self-hosted job (#1239)

Every `uses:` makes the runner download that action's archive from
`codeload.github.com`. From this box's IP those downloads started answering
**429**, three attempts and a backoff apart, and the job died in *Set up job* —
before a line of repo code ran. Every topic preview and every deploy failed at
the same point while the identical `ubuntu-latest` jobs passed, so the throttle
is on the address, not the workflow.

So the self-hosted jobs use **no actions at all**. They fetch what they need
with plain git over HTTPS:

```bash
git init -q .                       # workspace persists between runs
git remote add origin https://github.com/$GITHUB_REPOSITORY.git
git fetch --no-tags --depth=1 origin "$SHA"
git checkout -q --force --detach FETCH_HEAD
git clean -qfdx
```

Anything that needs an action — posting the topic-preview comment, sending an
alert email — is a separate GitHub-hosted job. **Keep it that way**: adding a
`uses:` to a self-hosted job reintroduces the failure, and it fails before your
step ever runs, which makes it look like the runner is broken rather than the
workflow.

---

## CI-independent operations (deploying without Actions, #636)

Everything CI does is just scripts, and the server is reachable over SSH — so
production deploys and the topic-preview foundations can also run **without
GitHub Actions at all** (an Actions outage, or the runner being wedged).
These paths build on the server, so use them deliberately, not on a timer.

### One-time: production secrets on the server
Create an env file (same values as the GitHub secrets), readable only by root:

```bash
sudo mkdir -p /etc/internship-crm
sudo tee /etc/internship-crm/prod.env >/dev/null <<'ENV'
DATABASE_URL=mysql://...
NEXTAUTH_SECRET=...
NEXTAUTH_URL=https://crm.ersah.in
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=...
# Optional second outbound channel (docs/EMAIL_DELIVERABILITY.md § "Two channels").
# Unset ⇒ everything goes over SMTP_* above, which is the historical behaviour.
#SMTP_BULK_HOST=...
#SMTP_BULK_PORT=465
#SMTP_BULK_USER=...
#SMTP_BULK_PASS=...
#SMTP_BULK_FROM=...
ENV
sudo chmod 600 /etc/internship-crm/prod.env
```

> **This file — not GitHub secrets — is what the running container reads.**
> `deploy-prod.sh` builds the container's env from `ENV_FILE` (falling back to
> the values already on the running container when it is missing). The
> `secrets.SMTP_*` entries in `deploy-prod.yml` / `deploy-preview.yml` are used
> only by the "Email alert on failure" job, which runs on a GitHub-hosted runner
> and never touches the app. Changing the app's mail configuration means editing
> this file and redeploying.

### Deploy `main` to production (builds from source — no ghcr pull needed)
```bash
# from your laptop, in one line:
ssh <user>@<server> 'cd /path/to/Internship && sudo ENV_FILE=/etc/internship-crm/prod.env ./infra/deploy-prod.sh'
```
`deploy-prod.sh` mirrors the `Production Deploy` job exactly: sync `main`, build
the image (stamping `GIT_SHA`), `prisma db push --accept-data-loss`, seed +
backfill, swap the `internship-crm` container (host net, :3200), health-check.

### Push-to-deploy without a webhook (⚠️ not recommended anymore)
`infra/autodeploy.sh` polls `main` and runs `deploy-prod.sh` when it moves, so a
cron entry gives push-to-deploy with no inbound port and no listener:
```cron
*/5 * * * * cd /path/to/Internship && ENV_FILE=/etc/internship-crm/prod.env ./infra/autodeploy.sh >> /var/log/internship-autodeploy.log 2>&1
```

> **Don't leave this on a cron.** It is redundant — `deploy-prod.yml` already
> follows `main` — and unlike the workflow it **builds the image on the server**,
> which is exactly the load that was moved to GitHub-hosted runners. If the entry
> exists, remove it:
> ```bash
> crontab -l | grep -v autodeploy.sh | crontab -
> ```
> It is at least *safe* to run alongside the workflow: `deploy-prod.sh`'s
> `FORWARD_ONLY=1` guard stops the two from deploying out of order.

### Automatic deploys: hosted build → server swap
`main` reaches both long-lived environments by itself — no dispatch, no SSH:

| Workflow | Env | Container | Port | Image | Triggers |
|----------|-----|-----------|------|-------|----------|
| `deploy-preview.yml` | https://crm-preview.ersah.in | `internship-crm-preview` | 3201 | `…:preview-<sha>` | push to `main`, every 6h (`:23`), manual |
| `deploy-prod.yml` | https://crm.ersah.in | `internship-crm` | 3200 | `…:prod-<sha>` | push to `main`, every 6h (`:53`), manual |

Each runs three jobs — **gate** (self-hosted, one curl + one `ls-remote`) → **build**
(`ubuntu-latest`, via `build-image.yml`) → **deploy** (self-hosted,
`deploy-prod.sh --no-pull --pull-image`). Both wrap the same `deploy-prod.sh`;
preview just overrides `CONTAINER`/`PORT`/`ENV_FILE` and sets `NETWORK=bridge` (its
DB user is granted from the docker gateway, not localhost). Prod builds with
`NEXT_PUBLIC_APP_ENV=production`, preview and topics with `preview` (green accent +
"preview" badge, `src/lib/appEnv.ts`).

Everything downstream of the gate is pinned to the **one sha the gate resolved**, so
the image, its baked `GIT_SHA`, the deployed checkout and the forward-only state file
can't disagree. Automatic runs target the *tip* of `origin/main` rather than the
triggering commit, so a run that queued behind a newer one can't land an older commit
on top of it (#794).

**Drift gate.** Automatic runs read the live container's `/api/health` `sha` and
compare it to `origin/main`. Equal → the run stops before the build, so the 6-hourly
schedule is free unless something was actually missed (a push that arrived while the
runner was offline — see `runner-watchdog.yml`) or the container is unreachable, which
counts as drift so the deploy also repairs it. A manual `workflow_dispatch` skips the
gate entirely: it always rebuilds, and accepts any branch/tag/SHA.

**Registry.** Images live in `ghcr.io/21072026/internship`, pushed with the run's
`GITHUB_TOKEN` (`packages: write`) and pulled on the server with the same token
(`packages: read`) — no PAT, no extra secret. Application secrets are still read from
`/etc/internship-crm/*.env` on the server and never enter a workflow.

**Preview secrets** live in `/etc/internship-crm/preview.env`, same shape as `prod.env`
but with `NEXTAUTH_URL=https://crm-preview.ersah.in`. There is no need to write it by
hand: when absent, `deploy-prod.sh` derives it from the running preview container. The
workflow keeps a valid file and only deletes one that fails to `source` or has no
`DATABASE_URL`, so an automatic run can never destroy the only copy of those values.

> **Future:** prod moves to a weekly release train while preview keeps tracking `main`.
> The switch is one edit in `deploy-prod.yml` — drop the `push:` block, uncomment the
> weekly `schedule:` entry.

### Topic-preview foundations without Actions
```bash
# DNS (from anywhere): wildcard *.ersah.in A record
export CF_Token="<scoped Cloudflare token>"
SERVER_IP=<server ip> ./infra/setup-dns-cloudflare.sh
# TLS (on the server): wildcard cert + auto-renew
export CF_Token="<scoped Cloudflare token>"
./infra/acme-issue-wildcard.sh
```

### The self-hosted runner
The always-on Plesk server is registered as a **self-hosted GitHub Actions runner**
(Settings → Actions → Runners → New self-hosted runner), kept alive by
`runner-watchdog.yml`. It exists so a deploy can touch the box's docker daemon,
its `preview.env`/`prod.env` and its Plesk config **without an SSH key in GitHub
secrets** — not to dodge a billing quota.

Keep it to that. `runs-on: self-hosted` belongs only on steps that need something
that exists only on this machine; anything that merely needs a Linux box with node
and docker (builds, tests, linting) goes to `ubuntu-latest`, which is free for this
public repo. Moving builds onto the runner in 2026-06 was a quota workaround
(#636), and it made the production host compile on every PR push.

---

## 5. Database backups & the destructive-schema gate

Every deploy runs `prisma db push --accept-data-loss`, so **the moment before a
deploy is the last moment the current database exists in full**. Two gates sit
there (#1179):

| Gate | prod | preview | topic (`internship-crm-pr<N>`) |
|---|---|---|---|
| `infra/backup-db.sh` — dump before the schema sync | ✔ | ✔ | skipped (disposable, shares the preview DB) |
| `infra/schema-guard.sh` — refuse a data-destroying diff | **blocks** | warns | warns |

Both are wired into `infra/deploy-prod.sh` (which is also what deploys preview
and the topic envs — only `CONTAINER` differs), so there is nothing to call by
hand on a normal deploy.

### Daily backup (cron)

The deploy-time dump only covers deploys. Everything else — a bad bulk delete, a
disk failure — needs a scheduled one. On the server:

```bash
sudo install -m 755 infra/backup-db.sh /usr/local/bin/internship-backup-db
sudo crontab -e
```

```cron
# 03:15 UTC daily, production
15 3 * * * set -a; . /etc/internship-crm/prod.env; set +a; /usr/local/bin/internship-backup-db --env prod >> /var/log/internship-backup.log 2>&1
```

Dumps land in `/var/backups/internship-crm` (override with `BACKUP_DIR`), are
kept for `KEEP_DAYS` (default 7) and are written `0600` in a `0700` directory —
**they contain real personal data** (CVs, phone numbers, mentor notes). Never
copy one into the repo, a preview environment or a ticket.

A dump is rejected (and the deploy stops) if it is under `MIN_BYTES`, is not a
valid gzip stream, or contains no `CREATE TABLE`. A backup that looks fine but
restores nothing is worse than no backup at all.

### Is it still running? (#1183)

`infra/backup-db.sh` validates the dump it writes; nothing validated that it is
still *running*. `.github/workflows/backup-verify.yml` does, **daily at 06:20
UTC** on the self-hosted runner, via `infra/check-backups.sh`: is there a dump,
is it fresher than `MAX_AGE_HOURS`, is it a well-formed non-trivial gzip, and
does the set still cover `MIN_HISTORY_DAYS` distinct days. A failure emails
`ALERT_EMAIL_TO` from a GitHub-hosted job — an alert that needs the failing
server to be healthy may never send.

```bash
./infra/check-backups.sh --env prod --env preview
```

### Restoring

See [`docs/disaster-recovery.md`](../docs/disaster-recovery.md) for the full
runbook. The short version:

```bash
gzip -dc /var/backups/internship-crm/prod-<stamp>.sql.gz | mysql -h <host> -u <user> -p <db>
```

The rehearsal is scripted: `infra/restore-drill.sh` restores the newest dump
into a throwaway database, verifies the row counts that matter, prints the
measured RPO/RTO and drops the copy. It runs monthly (1st) from the same
workflow, or on demand via *Run workflow* → *Also run the restore drill*.

### Rolling back (#961)

The swap is blue/green: the new image runs first as `<container>-canary` on
`PORT+100`, and only when it answers `/api/health?db=1` with `status: ok`, a
reachable database and the sha that was just built does the live container get
touched. A bad image therefore fails the deploy without taking the environment
down — which is what happened on 2026-07-28, when all three environments served
503 because the old container was removed before the new one was proven.

The image that was replaced is tagged `<container>:previous` and is deliberately
kept out of the prune, so putting the last release back is a `docker run`, not a
rebuild:

```bash
CONTAINER=internship-crm ./infra/deploy-prod.sh --rollback
```

That path runs **before** the git sync, the image pull and the schema push: when
a deploy has just gone wrong, the way back must not depend on the machinery that
broke. It health-checks what it started (without asserting a sha — a rollback
wants whatever the old image serves) and records the served commit in the state
file so the next deploy's forward-only guard compares against reality.

Two consequences worth knowing:

- **No `docker image prune -af` anywhere any more.** `-a` removes every image no
  container is using, which includes `:previous`. `deploy-prod.sh`,
  `topic-deploy.sh` and `topic-teardown.sh` now prune dangling layers and remove
  app images by name instead. (The legacy `deploy.yml` still has a blanket
  prune; it is superseded and not on any trigger, but if it is ever revived it
  will eat the rollback targets.)
- **A fresh environment has no rollback target** until its first deploy under
  this scheme replaces something. `--rollback` says so rather than guessing.

### Overrides (use knowingly)

| Variable | Effect |
|---|---|
| `FORCE_NO_BACKUP=1` | deploy without taking a backup |
| `ALLOW_DESTRUCTIVE=1` | apply a data-destroying schema change — **refused unless a backup was taken in the same run** |
| `BACKUP_DIR`, `KEEP_DAYS`, `MIN_BYTES` | where/how long/how small |
