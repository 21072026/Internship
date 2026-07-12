# Infra — Wildcard TLS & topic-based preview environments

Runbook for the automation behind [#583](https://github.com/mersahin/Internship/issues/583)
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

`.github/workflows/topic-preview.yml` parses a `topicN` token from the branch name:

- **no token** → this workflow no-ops; `deploy.yml` deploys the shared
  `crm-preview.ersah.in` as before. (deploy.yml now **skips** topic branches so a
  topic PR isn't deployed twice.)
- **token present** (`me/branch_name_topic5`) → build image, then over SSH run
  `infra/server/topic-deploy.sh`: start `internship-crm-topic5` on its port, write
  the nginx route, reload. Posts the `crm-topic5.ersah.in` URL on the PR.
- **PR merged/closed** → `infra/server/topic-teardown.sh` stops/removes the
  container + image and the nginx route, then reloads.

**Database: a single shared preview DB** (`DATABASE_URL_PREVIEW`). No per-topic DB,
so no DB-admin secret is needed. ⚠️ Trade-off: all topics share schema/data — two
concurrent topics with divergent schema changes can drift (`prisma db push` is
global). Coordinate schema changes across simultaneous topics, or switch to
per-topic DBs later (would need a `CREATE/DROP DATABASE`-capable secret).

### Secrets / vars used (already present unless noted)
`SSH_HOST`, `SSH_USER`, `SSH_PORT`, `SSH_PRIVATE_KEY`, `DATABASE_URL_PREVIEW`,
`NEXTAUTH_SECRET`, `SMTP_*`, `GITHUB_TOKEN`. Base domain is the `BASE_DOMAIN` env in
the workflow (default `ersah.in`).

### Still needs a real-topic test
The scripts follow standard Plesk/nginx conventions but haven't been run against
the live box. First validation: open a PR from a `…_topicN` branch and confirm the
container comes up, `crm-topicN.ersah.in` serves over TLS, and closing the PR tears
it down (`docker ps` + `$NGINX_CONF_DIR` clean). Adjust `NGINX_CONF_DIR` /
`NGINX_RELOAD_CMD` / `CERT_DIR` if paths differ.
