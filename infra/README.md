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

`.github/workflows/topic-preview.yml` runs on the **self-hosted runner** (no
GitHub-hosted Actions minutes) and gives **every open PR** its own environment,
keyed by PR number — no branch-naming convention needed:

- **PR opened / pushed to / reopened** → build the image locally on the server,
  then `infra/server/topic-deploy.sh` starts `internship-crm-pr<N>` on its derived
  port (3300–3399, `3300 + N%100`), writes the nginx route for
  `crm-pr<N>.ersah.in`, and reloads. A bot comment on the PR carries the URL
  (updated on every push).
- **PR merged/closed** → `infra/server/topic-teardown.sh` stops/removes the
  container + image and the nginx route, then reloads.

Because the runner is on the server, there is **no SSH and no GHCR round-trip**:
`topic-deploy.sh` is called with `SKIP_PULL=1` (image already built locally) and
`ENV_FILE=/etc/internship-crm/preview.env` (secrets sourced directly, same file
`deploy-preview.yml` uses). The script still supports the old hosted flow (GHCR
`IMAGE` + `ACTOR`/`B64_TOKEN` + `B64_*` secrets) for backward compatibility.

**Database: a single shared preview DB.** No per-topic DB, so no DB-admin secret
is needed. ⚠️ Trade-off: all topics share schema/data — two concurrent PRs with
divergent schema changes can drift (`prisma db push` is global). Coordinate schema
changes across simultaneous topics, or switch to per-topic DBs later (would need a
`CREATE/DROP DATABASE`-capable secret).

### Prerequisites on the server
- Self-hosted runner registered; its user can run `docker` **and** write
  `$NGINX_CONF_DIR` + reload nginx. If the runner user isn't root, set
  `NGINX_RELOAD_CMD` to a sudo-wrapped command and add the matching sudoers entry.
- Wildcard DNS `*.ersah.in` → the server, and a wildcard TLS cert in `$CERT_DIR`.
- `/etc/internship-crm/preview.env` (chmod 600) with `DATABASE_URL` (the shared
  preview DB), `NEXTAUTH_SECRET`, `SMTP_*`.

### Still needs a real-PR test
The scripts follow standard Plesk/nginx conventions but haven't been run against
the live box in this self-hosted shape. First validation: open a PR and confirm
the bot comments a `crm-pr<N>.ersah.in` URL, the container comes up, the URL serves
over TLS, and closing the PR tears it down (`docker ps` + `$NGINX_CONF_DIR` clean).
Adjust `NGINX_CONF_DIR` / `NGINX_RELOAD_CMD` / `CERT_DIR` if paths differ.

---

## CI-independent operations (when the Actions quota is exhausted, #636)

Everything CI does is just scripts, and the server is reachable over SSH — so
production deploys and the topic-preview foundations can run **without any
GitHub Actions minutes**.

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
ENV
sudo chmod 600 /etc/internship-crm/prod.env
```

### Deploy `main` to production (builds from source — no ghcr pull needed)
```bash
# from your laptop, in one line:
ssh <user>@<server> 'cd /path/to/Internship && sudo ENV_FILE=/etc/internship-crm/prod.env ./infra/deploy-prod.sh'
```
`deploy-prod.sh` mirrors the `Production Deploy` job exactly: sync `main`, build
the image (stamping `GIT_SHA`), `prisma db push --accept-data-loss`, seed +
backfill, swap the `internship-crm` container (host net, :3200), health-check.

### Push-to-deploy without a webhook (optional)
Add a cron entry on the server — every 5 min it deploys only if `main` moved:
```cron
*/5 * * * * cd /path/to/Internship && ENV_FILE=/etc/internship-crm/prod.env ./infra/autodeploy.sh >> /var/log/internship-autodeploy.log 2>&1
```
No inbound port, no listener — just `git fetch` + the deploy script, lock-guarded.

### Topic-preview foundations without Actions
```bash
# DNS (from anywhere): wildcard *.ersah.in A record
export CF_Token="<scoped Cloudflare token>"
SERVER_IP=<server ip> ./infra/setup-dns-cloudflare.sh
# TLS (on the server): wildcard cert + auto-renew
export CF_Token="<scoped Cloudflare token>"
./infra/acme-issue-wildcard.sh
```

### Permanent fix: self-hosted runner
The always-on Plesk server can register as a **self-hosted GitHub Actions
runner** (Settings → Actions → Runners → New self-hosted runner). Self-hosted
minutes do **not** count against the 2000-min quota, so the existing workflows
(deploy, e2e, infra-setup) all run again for free — flip `runs-on: ubuntu-latest`
to `runs-on: self-hosted` on the workflows you want off the hosted quota. This
is the structural cure; the scripts above are the immediate, dependency-free path.
