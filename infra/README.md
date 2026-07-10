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

Each topic runs its own container on its own port (e.g. `topic5` → `3305`). The
reverse proxy maps the hostname to that port. Pick the option that fits the box:

- **Plesk-managed (recommended on this server):** the domain is on Plesk, which
  owns ports 80/443. Add topic vhosts via Plesk's *nginx additional directives* or
  a dedicated proxy domain, rendered per topic by CI. Do **not** hand-drop files
  into `/etc/nginx/conf.d` — Plesk regenerates its config and will clobber them.
- **Standalone reverse proxy:** run a single long-lived nginx (or Traefik)
  container that owns 80/443 and routes by `Host`. With **Traefik + Docker
  provider** you don't even generate config: CI starts the topic container with a
  `Host(\`crm-<topic>.ersah.in\`)` label and Traefik picks it up instantly; on
  teardown the container disappears and so does the route. Cleanest automation,
  but needs 80/443, so only viable if Plesk isn't already holding them.

Whichever is chosen, it terminates TLS with the **one** wildcard cert from step 2 —
no per-topic certificate.

> This is the piece that depends on the live server layout, so it's intentionally
> left as a decision rather than a committed config. Once the routing layer is
> chosen, the per-topic deploy/teardown scripts (container + DB + route) can be
> finalized against real paths — that's the remaining work in #583.

---

## How this plugs into #583

CI parses a `topicN` token from the branch name (`github.head_ref`):

- **no token** → deploy to the shared `crm-preview.ersah.in` (today's behavior).
- **token present** (`me/branch_name_topic5`) → deploy `internship-crm-topic5`
  (own container + own DB `crm_topic5`) and route `crm-topic5.ersah.in` to it.
- **PR merged/closed** → tear the topic's container, image, DB, and route down so
  it stops consuming server resources.

With steps 1–2 done once, that flow never touches DNS or certificates again.
