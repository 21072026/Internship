# Infra — Wildcard TLS & topic-based preview environments

Runbook for the automation behind [#583](https://github.com/21072026/Internship/issues/583)
(per-topic ephemeral preview environments at `<topic>.<domain>`; the hostnames
carried a `crm-` prefix until #2166 retired it).

The whole design rests on **three one-time foundations**, after which spinning a
topic environment up or down is *only* a container + database operation — no DNS
and no certificate work per topic.

| Foundation | Set up once | Per-topic cost afterwards |
|---|---|---|
| Wildcard DNS `*.interncrm.com` | 1 Cloudflare A record | none |
| Wildcard TLS `*.interncrm.com` | `acme-issue-wildcard.sh` | none |
| Reverse-proxy routing | see "Routing" below | tiny generated vhost (CI) |

---

## 1. Wildcard DNS (Cloudflare)

Add a single record so **every** subdomain resolves to the server:

```
Type: A    Name: *    Content: <server IP>    Proxy: on (orange)    TTL: Auto
```

Now `preview.interncrm.com`, `pr5.interncrm.com`, `pr9.interncrm.com`, … all
resolve without ever touching DNS again.

> Keep the existing explicit records (`@`, `www`, `preview`, …); the wildcard only
> answers names that have no explicit record.

## 2. Wildcard TLS certificate

The error you hit —

```
No TXT record found at _acme-challenge.interncrm.com
```

— is because a wildcard cert must be validated with the **DNS-01** challenge, and
nobody had put the challenge TXT there. `infra/acme-issue-wildcard.sh` automates
that end to end with acme.sh + the Cloudflare API (creates the TXT, validates,
removes it), and installs a cron job so **renewals are automatic**.

```bash
# Create a SCOPED Cloudflare API token (My Profile → API Tokens → Custom):
#   Zone → DNS  → Edit
#   Zone → Zone → Read
#   Zone resources → Include → Specific zone → interncrm.com
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
Let's Encrypt entirely: generate a Cloudflare **Origin Certificate** (`*.interncrm.com`,
15-year, free), install it once, set SSL mode **Full (strict)**. Lowest
maintenance, but it's dashboard-driven and requires the proxy to stay on. We use
the acme.sh path above because it's fully scripted and proxy-independent.

## 3. Routing `pr<N>.interncrm.com` → the right container

> **Rewritten by the 2026-09 server migration (#2166).** The box now runs **Caddy**,
> and `infra/server/topic-deploy.sh` detects it and writes
> `$CADDY_SITES_DIR/<fqdn>.caddy` instead of an nginx vhost. The Plesk/nginx
> description below is kept because the script still supports that path, but it
> describes the retired host — read `topic-deploy.sh` for what actually runs.

**Decision: Plesk-native nginx routing** (Plesk keeps owning 80/443, so production
`interncrm.com` is untouched). Each topic runs its own container on a derived port
(3400–3499; `pr5` → `3405`). On deploy, `infra/server/topic-deploy.sh` writes a
self-contained nginx server block for `pr<N>.interncrm.com` into `$NGINX_CONF_DIR`
(default `/etc/nginx/conf.d`) that terminates TLS with the **one** wildcard cert
from step 2 and `proxy_pass`es to the topic's port; teardown removes it. Both
reload nginx afterwards.

### The marketing hosts (`MARKETING_HOSTS`, #2540, epic #2348)

The MARKETING vertical's public landing is served **from the same containers** as
the internship product — two urls, two products, one deployment (#2355). Prod's
marketing host is answered on `:3200` and preview's on `:3201`; which names those
are is environment data (`MARKETING_HOSTS`, the env files and the Caddy site
files on the box), not something this repo writes down. They replaced the
earlier marketing names on 2026-09-23 (#2540); that apex now does **mail only**,
and the two retired names redirect to the current hosts.

What makes the box answer for them:

- **DNS** — an explicit `A` record per host → `92.5.120.186`, created on the
  marketing domains directly (the old apex's wildcard and its MX records were
  deliberately left alone: mail for that apex lives elsewhere).
- **TLS** — each name is on its own apex with **no wildcard on the box**, so
  Caddy issues a certificate for it **automatically** (the same way the
  `interncrm.com` apex works: its site file carries no `tls` directive). Nothing
  to run by hand, and nothing to renew — do *not* copy the `tls /etc/caddy/certs/…`
  lines the retired hosts used. If a host sits on an HSTS-preloaded TLD, plain
  HTTP is not merely discouraged there, it is unusable: the certificate has to be
  in place before a browser will talk to the host at all.
- **Site file** — `/etc/caddy/sites/<prod marketing host>.caddy`, one
  `reverse_proxy 127.0.0.1:3200` to the prod container
  (`<preview marketing host>.caddy` points at `:3201`). Same shape as the topic
  site files `topic-deploy.sh` writes; nothing else is special about them.
- **Which host means MARKETING** is the app's business, not Caddy's:
  `src/lib/hostVertical.ts` reads `X-Forwarded-Host`/`Host` and compares it with
  `MARKETING_HOSTS` (comma-separated bare hostnames). **There is no default
  (#2926): unset, empty or whitespace-only means no host serves the marketing
  product**, so every environment that has one names it in its own env file —
  prod in `/etc/internship-crm/prod.env`, preview in
  `/etc/internship-crm/preview.env` (each lists exactly its own hosts, so preview
  never answers for the prod domain). `deploy-prod.sh` threads the variable as
  `-e MARKETING_HOSTS="${MARKETING_HOSTS:-}"`, i.e. an env file with no value
  puts an **empty string** in the container, which the app treats as unset
  (`src/lib/servedHosts.ts` `marketingHosts()`, unit-tested — the same set the
  #2488 redirect allowlist reads, so a host missing from it is not a served host
  either). Until #2926 an empty value fell back to a hostname written into the
  code; an env file that loses the line would turn its marketing hosts into
  internship hosts, so `deploy-prod.sh` refuses to deploy the prod or preview
  container (`internship-crm`, `internship-crm-preview`) with an empty
  `MARKETING_HOSTS` — before the schema push and the swap, while the old
  container still serves — unless the env file sets `MARKETING_HOSTS_NONE=1` on
  purpose. It refuses in the same place when the caller-named
  `MARKETING_PROBE_HOST` is missing from the list.
- Signed-in users never go through this: their vertical is their
  `Organization.vertical`. The host decides copy and chrome only (see the TRUST
  NOTE in `hostVertical.ts`).

Moving a marketing domain means changing **both** halves close together: until
`MARKETING_HOSTS` names the new host it serves the internship landing. Add the
new site file first (so the name resolves and gets its certificate), then list
the new host in the env file's `MARKETING_HOSTS` and redeploy, update the
`MARKETING_PROBE_HOST_PROD` / `MARKETING_PROBE_HOST_PREVIEW` secret, then turn the
old site file into a redirect.

Verify after a deploy (both must hold, on each host), with `MKT` and `MKT_PREVIEW`
set to `https://` plus the prod and the preview marketing host:

```bash
curl -s "$MKT/" | grep -o '<title>[^<]*</title>'           # names the marketing product, not "Internship CRM"
curl -s "$MKT/api/health" | jq '{status,sha}'               # same sha as interncrm.com
curl -s "$MKT_PREVIEW/api/health" | jq '{status,sha}'       # same sha as preview.interncrm.com
curl -sI https://<retired marketing name>/ | head -2       # 308 → the prod marketing host
```

The first line is **no longer only a hand check** (#2579). Every `uptime.yml` run
reads the marketing pages listed in the `MARKETING_PROBE_URLS` secret (one URL per
line, for example each marketing host's `/` and `/imprint`) with
`scripts/marketing-content-probe.mjs`. The rule names no brand (#2919). A page's
`<title>` must contain the `name` in its host's own `/manifest.webmanifest`. That name
must be neither `Internship CRM` (the wrong product) nor `coreCRM` (the neutral
fallback, which means the host's brand is missing). The run also checks each of those
hosts' `/api/health`. Nothing the probe writes names a host: logs, alert issues and
mails are as public as the repository, so a host is `marketing host #<n>`, the place
of its origin in the secret. Without the secret the marketing hosts are not probed,
and the run says so in a notice; such a run also neither opens nor closes an
incident about them (an open content incident, or an outage that names a marketing
host, stays open until a run that read those hosts finds them right). A finding opens its **own** incident: a separate
`uptime-content-alert` issue + mail (subject *"Marketing host yanlış ürünü
gösteriyor"*), never the outage's `uptime-alert` one. The two must not share a
state — a content problem can stay open for days waiting on an env-file edit,
and an outage of interncrm.com during those days would otherwise find
"already alerting" and stay silent (the gap #2169 closed). A content finding on
a host whose `/api/health` is already down is left to the outage alert, so one
dead marketing host still opens one incident. The same rule runs inside
`deploy-prod.sh` right after the swap, on every replica, and at the end of
`infra/server/topic-deploy.sh`, but there it only **warns** (`::warning::` in the
prod and preview deploy jobs, a `WARN` line in a topic deploy): the fix is an
env-file edit, not a rollback. Those two copies are plain
shell and print neither the title nor the manifest name; `infra/test/marketing-title-check.test.sh`
keeps all three copies of the rule in step. `deploy-prod.sh` asks for the host the
caller names (`MARKETING_PROBE_HOST`, which `deploy-prod.yml` / `deploy-preview.yml`
pass from the `MARKETING_PROBE_HOST_PROD` / `MARKETING_PROBE_HOST_PREVIEW` secrets),
else for every host in `MARKETING_HOSTS`, and skips the check when neither names one.
A caller-named host is deliberately **not** read from `MARKETING_HOSTS`: whatever that
variable names gets the marketing page by construction, so a check that took its host
from there could never catch it being wrong, which is also why the caller keeps
naming one from a secret: without it the check only compares `MARKETING_HOSTS` with
itself. The script also warns when that host is missing from `MARKETING_HOSTS`. Run the probe by hand with
`MARKETING_PROBE_URLS="https://<marketing host>/ https://<marketing host>/imprint" node scripts/marketing-content-probe.mjs`.
It prints nothing on stdout and exits 0 when every page is right. Otherwise it prints
one `marketing host #<h>, page #<p> -> <reason>` line per wrong page and exits 1. A
per-page `OK`/`FAIL` line goes to stderr.

#### Go-live checklist for the MARKETING org (#2579 — operator, needs prod access)

The code half of #2579 is the probe above; the rest can only be done on the live
system, by someone signed in there. Each step is **read-only unless it says
otherwise**, goes through the app (never an outside connection to the prod
database — `docs/DATA_ACCESS_POLICY.md`), and its result is posted as a comment
on the story, #2578. Nothing below has been run by the change that wrote it.

1. **Is there a MARKETING org, and is it complete?** As a super admin, open
   `/admin/organizations`. Note how many rows show vertical `MARKETING`, and for
   each: name, `brandName`, plan and the owner account(s) (a role, not a
   person's details — the comment goes on a public issue). Then open
   `/admin/organizations/<id>/pipeline` for each and check the stage list holds
   **both** `TRIAL_ACTIVE` ("Trial running") and `TRIAL_EXPIRED`.
   Why it matters: `expireTrials()` (`src/lib/jobs/trialReminders.ts`) returns 0
   for an org that lacks either one — silently, by design — so a MARKETING org
   without them never expires a trial.
2. **Fix what step 1 found** (writes):
   - *No MARKETING org:* create it from `/admin/organizations` with vertical
     `MARKETING`. The marketing preset, trial stages included, is seeded by the
     create call itself (`provisionStagePreset()`,
     `src/lib/pipelineStages.ts`; stages in `src/lib/programTemplates.ts`) — do
     not add them by hand afterwards.
   - *An org exists but a trial stage is missing:* add it in that org's stage
     editor (`/admin/organizations/<id>/pipeline`) with the exact key
     (`TRIAL_ACTIVE` / `TRIAL_EXPIRED`, non-terminal, **not** off-path) and put
     the count of stages added in the #2578 comment.
   - *More than one org is affected:* stop editing by hand and open a task for
     an idempotent deploy backfill instead (plain `.mjs`, an ESM mirror of the
     marketing funnel with a parity test, and an explicit `orgId` on every
     create — a deploy step has no session to bind one).
   - Then prove the job sees the org. **This is a write, not a read:**
     `GET /api/cron?job=trial-reminders&orgId=<id>` runs the real job for that
     org — it mails every trial reminder that is due and expires overdue trials
     to `TRIAL_EXPIRED`, exactly like the 05:20 UTC tick. Run it before real
     prospects are in the org, or right after the 05:20 run so nothing is due.
     Copy the URL exactly: a mistyped `job=` value falls through to the full
     cron mail batch, which is a super admin's (a tenant ADMIN gets a 403,
     #1575). `orgId` is honoured only for the caller's own org or one a super
     admin of the same world reaches. Signed in as an ADMIN of that org, on
     the org's own host,
     the JSON's `trialReminders.orgs` must be `1` — which proves **only** the
     vertical gate (the org is counted in scope because its vertical is
     `MARKETING`), not that the trial stages exist; stage presence is proven
     by the stage-editor check in step 1. `trialReminders.expired` /
     `considered` are the fields that show the stages actually in use. (The
     05:20 cron logs a line only on a tick that did something, so a quiet day
     shows nothing in the container log.)
3. **Host → org mapping** — *blocked on #2569*, which defines it; nothing in
   `main` maps a host to an org today (`src/lib/hostVertical.ts` maps a host to a
   *vertical* only). Once it lands: confirm prod's marketing host maps to the
   org from step 1 and preview's to its preview twin. With no mapping the public
   form stays closed — that is the safe failure, but it is still a failure to
   report.
4. **The content probe is green.** In Actions → *Uptime*, the latest run's
   *Probe* step ends with `reach up` and `content up`, and no open issue
   carries the `uptime-alert` or `uptime-content-alert` label. If it is red
   for content, the first suspect is `MARKETING_HOSTS` in the environment's
   env file (above).
5. **The retired name still redirects:**
   `curl -sI https://<retired marketing name>/ | head -2` shows `308` and a
   `location:` on the prod marketing host. Repeat for the retired preview name →
   the preview marketing host.

### Proxy hops and `TRUSTED_PROXY_COUNT` (#858)

Every vhost sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which **appends**
the peer address to whatever the client sent. The header therefore reads
`<whatever the client made up>, <what nginx actually saw>` and only the
right-hand entries can be trusted. The rate limiter counts back from the right
by `TRUSTED_PROXY_COUNT` hops (`src/lib/rateLimit.ts`).

**One hop today**, so the default of `1` is correct for all three environments.
The wildcard DNS record in step 1 is orange-clouded, but the explicit `crm`
record is not — `curl -sI https://interncrm.com` returns no `cf-ray`, i.e. the
request reaches nginx directly. **If a hostname is ever moved behind
Cloudflare's proxy, bump `TRUSTED_PROXY_COUNT` to `2` for it in the same
change**, or every visitor will be bucketed as the Cloudflare edge and one
person's rate limit will throttle everyone.

`0` disables **both** proxy headers — `X-Forwarded-For` and `X-Real-IP` alike,
since with nothing in front a client writes either one (#2470) — so every caller
shares one bucket per limit. Right for a container reached directly; strict, but
no header buys a way around it. The e2e webServer runs at `1` like production:
its helpers send the `X-Forwarded-For` a one-hop proxy would
(`e2e/helpers/rateLimit.ts`).

### Where the rate-limit counters live (`RATE_LIMIT_REDIS_URL`, #1696)

Counts are per-process unless `RATE_LIMIT_REDIS_URL` is set. That is fine while
each environment is one container, and it is the deliberate default for a
self-hosted install — but **the moment an environment runs two replicas, set it
in that environment's env file** or every limit becomes twice as generous (five
sign-in attempts per container, not per attacker) and a redeploy zeroes them.
Value is `redis://…` or `rediss://…`; the store is used for counting only,
nothing durable lives there, so it needs no persistence or backup.

The limiter **fails open**: an unreachable store means it logs once and counts
in memory until the store returns — never a 500, never a locked-out user. Check
which state a box is in with an admin session or the health token:
`curl -sH "X-Health-Token: $HEALTH_TOKEN" 'https://…/api/health?limits=1' | jq .rateLimitStore`
→ `{ "backend": "shared", "degraded": false, … }`. `"backend": "memory"` on a
multi-replica environment is a misconfiguration, and `"degraded": true` means
the limits are per-process right now.

### Request body limit (#3210)

The app refuses a JSON/text write to `/api/*` whose **declared**
`Content-Length` exceeds 1 MiB (32 MiB under `/api/admin/`, where the importers
take a whole CSV as a JSON string) with `413 payload_too_large`
(`src/lib/bodyLimitRule.ts`, tunable with `JSON_BODY_MAX_BYTES` /
`JSON_BODY_MAX_BYTES_ADMIN`). Middleware only sees headers, so a **chunked**
body with no length still reaches `request.json()` unbounded — that half
belongs here, at the proxy, which counts real bytes.

**Operator step (not applied by any deploy):** in each app site block — prod,
preview, the marketing hosts and the `pr<N>` wildcard — add, inside the block
and before `reverse_proxy`:

```caddyfile
request_body {
    max_size 40MB
}
```

40 MB clears the largest legitimate upload path (document and support
attachments at 10 MB, the feedback replay's multipart form) with headroom;
the per-route limits stay the app's job. Then `caddy validate --config
/etc/caddy/Caddyfile && systemctl reload caddy`, and check one request:
`head -c 50000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST
-H 'content-type: application/octet-stream' --data-binary @- https://…/api/health`
→ `413`. A refusal at the proxy has no JSON body and no `x-request-id`; that is
expected.

### Two replicas behind one proxy (`REPLICAS`, #1701)

Every environment is **one container by default, and that has not changed**.
`REPLICAS=1` is the default in `infra/deploy-prod.sh`; at that value the deploy
is byte-for-byte what it was — one `docker stop`/`docker run` on
`internship-crm:3200`, and no reverse-proxy call at all.

The switch is the environment's own env file — `infra/deploy-prod.sh` sources
it before reading `REPLICAS`, so `REPLICAS=2` in `/etc/internship-crm/prod.env`
is the whole change and no workflow needs editing.

`REPLICAS=2` runs two containers and rolls the deploy through them one at a
time:

| Replica | Container | Port (prod) | Port (preview) |
|---|---|---|---|
| 1 | `internship-crm` | 3200 | 3201 |
| 2 | `internship-crm-2` | 3210 | 3211 |

Replica 1 deliberately keeps the historical name and port: the env-file capture
at the top of the deploy script, `--rollback`, the `FORWARD_ONLY` guard and the
workflows' drift gate all address the environment as `internship-crm` on 3200.
Renaming it would be a second, unrelated change riding along on a deploy.
Replica *k* is `${CONTAINER}-k` on `PORT + (k-1)*REPLICA_PORT_STRIDE` (stride
10, so the pool stays clear of the canary at `PORT+100` and of the topic range
3400–3499).

**The roll.** For each replica in turn: rewrite the proxy pool without it →
`docker stop -t 25` (SIGTERM, then the grace period for work already in
flight) → start the new image → assert `/api/health?db=1` reports the sha just
built → put it back in the pool. A failed health check **stops there**: that
replica stays out of the pool and the untouched one keeps serving the previous
image, so a bad release can never take both. The routing call is *pre-flighted*
before the first container is touched, so a box whose proxy the script cannot
drive fails the deploy while everything is still serving.

`infra/server/replica-route.sh` writes the pool. On the Caddy host it rewrites
`/etc/caddy/sites/<fqdn>.caddy` — one `reverse_proxy` with both upstreams,
`lb_policy round_robin`, `lb_try_duration 5s` (so a replica dying mid-request
costs that request a retry, not an error) and an active `health_uri
/api/health`. It **validates before reloading** and, unlike
`topic-deploy.sh`, restores the previous file if Caddy refuses the new one:
deleting `interncrm.com.caddy` to avoid a bad load-balancer stanza would be an
outage. On the retired Plesk box it refuses and prints the `upstream` block to
install by hand — a panel-managed vhost is not ours to rewrite.

**No sticky sessions, and never `ip_hash`.** Nothing here is pinned to a
process: the session is a signed JWT (`src/lib/auth.ts`), the rate-limit
counters live in the shared store above (#1696), and the SSE stream reconnects
by itself. Pinning clients would only concentrate a NATed office on one replica
and strand its sessions whenever that replica is drained. The generated config
carries that sentence, so nobody adds it "to be safe".

**Two jobs must have exactly one owner**, and they are the reason this is not
just an nginx change: the in-process **scheduler** would send every reminder
twice, and the **IMAP bridge** would race a second poller over the `\Seen`
flag on one mailbox. Both are settled by a `JobLease` row — a single-owner
lease with a TTL and a conditional-update takeover (`src/lib/jobs/lease.ts`,
unit-tested in `scripts/test/job-lease.test.mjs`). Who holds what is visible
from outside the box:

```bash
curl -sH "X-Health-Token: $HEALTH_TOKEN" 'https://interncrm.com/api/health?leases=1' \
  | jq '{replica, leases}'
```

A replica that does not hold a lease does nothing and says nothing — losing is
the normal state of exactly one of the two. After a replica dies its lease is
freed by **expiry only** (nothing else can free a process that was
SIGKILLed), so the work resumes on the other replica within one TTL — three
poll intervals, i.e. about three minutes for the mail bridge. Late, never
double.

**The cron is leased per tick (#1676, #1677).** Every replica runs the 30 s
queue scheduler; each tick first takes or renews the `'scheduler'` lease
(`src/lib/jobs/leasedCron.ts`), and only the holder enqueues the due slots of
`src/lib/jobs/schedules.ts` — every scheduled job in the product, with
missed-slot catch-up. The job worker runs them on every replica (SKIP LOCKED).
Replica ≥2 therefore no longer runs with `CRON_ENABLED=0`: while replica 1 is
down or mid-swap, replica 2 takes the lease within one TTL (90 s) — a graceful
SIGTERM releases it at once — and the slot it missed is enqueued late, not lost.

**Also set `RATE_LIMIT_REDIS_URL`** for a two-replica environment (see the
section above) or every limit becomes twice as generous.

**Going back to one replica** is a deploy with `REPLICAS=1`, then

```bash
./infra/server/replica-route.sh --host interncrm.com --ports 3200   # single upstream
docker rm -f internship-crm-2
```

Re-running `bootstrap.sh`'s `sites` step writes the same single-upstream file.

**The honest limit: this removes the PROCESS single point of failure, not the
host one.** Both replicas, both other environments and MySQL all run on the
same Plesk/Oracle box. A crashed container, an OOM-killed app process or a
deploy no longer takes the site down; a kernel panic, a full disk, a network
outage or that one MySQL still does. Anything that quotes this work as an
availability guarantee — #1604's status page and SLA in particular — has to
carry that sentence with it.

### The mail sink (topic environments, #2953)

A topic environment never sends through the shared relay. `topic-deploy.sh`
starts **one** Mailpit container for all of them, idempotently, before it
starts the topic container:

| | |
|---|---|
| container | `internship-mail-sink` (`MAIL_SINK_CONTAINER`), image pinned in the script (`MAIL_SINK_IMAGE`) |
| SMTP | `127.0.0.1:1025` on the box, and `internship-mail-sink:1025` on the private docker network `internship-mail-sink` (bridge-mode topic containers join it) |
| web UI | `127.0.0.1:8025` on the box — **no public port, no Caddy site** |
| storage | the last 2000 messages (`MP_MAX_MESSAGES`), in the container |

Every topic container gets `MAIL_SINK_HOST` / `MAIL_SINK_PORT`, and every mail
whose recipients are not **all** on `MAIL_RECIPIENT_ALLOWLIST` goes to the sink
(`src/lib/mailSinkRule.ts`, `docs/mail-queue.md` § The mail sink). To receive a
real mail from a PR environment on purpose, put your address or domain in the
preview env file as `TOPIC_MAIL_RECIPIENT_ALLOWLIST=you@example.com,example.org`.

**Reading the sink** — an SSH tunnel to the UI, from your laptop:

```bash
ssh -L 8025:127.0.0.1:8025 <the box>
# then open http://localhost:8025 — every topic environment's mail, newest first
```

If the sink is down, the topic environments' mail waits on their own queues
and is retried against the sink; it never falls back to the relay. Restart it by
re-running any topic deploy, or `docker start internship-mail-sink`. Tearing a
topic environment down leaves the shared sink alone. Bump the image by editing
`MAIL_SINK_IMAGE` in the script (a pinned tag, never `latest`).

The demo container (`demo-refresh.sh`) runs with `MAIL_WORKER_ENABLED=0`: demo
mode sends nothing, so it has nothing to drain either.

### One-time server setup this requires
- The stock `include /etc/nginx/conf.d/*.conf;` must be active (default on Plesk).
  These hostnames are **not** Plesk-managed domains (only the apex/`preview` are),
  so Plesk never rewrites the topic files. If your install uses a different include
  dir, set `NGINX_CONF_DIR` in the deploy step / server env.
- The SSH deploy user must be able to write to `$NGINX_CONF_DIR` and reload nginx
  (a sudoers rule for `NGINX_RELOAD_CMD`, default `nginx -t && systemctl reload nginx`).
- Wildcard cert installed at `$CERT_DIR/interncrm.com.cer` + `.key` (step 2 default).

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
  `internship-crm-pr<N>` on its derived port (3400–3499, `3400 + N%100`) and
  **routes it through the reverse proxy** at `pr<N>.interncrm.com` (see below). A bot
  comment on the PR carries the URL (updated on every push).
- **The marketing world gets a second host, `pr<N>-m.interncrm.com`** (#2612), served by
  the same container. Still one DNS label, so the existing `*.interncrm.com` DNS record
  and wildcard cert cover it — no per-PR Let's Encrypt issuance (the 50/week/domain
  ceiling is why a per-PR name under the preview marketing domain was rejected). The container gets
  `MARKETING_HOSTS=pr<N>-m.interncrm.com` explicitly — never the value from
  `preview.env`, which names the shared preview marketing domain — and the deploy
  points the seeded `demo-marketing` org's `publicHost` at it, so e-mail links stay on
  the topic env. The deploy log ends with a landing-title probe on that host.
  Teardown removes both site files.
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
1. `plesk bin subdomain --create pr<N> -domain interncrm.com -ssl true` (idempotent),
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
environment** — sign in with `admin.demo@demo.example.com` / `DemoPass123!`, or with
`admin.marketing@demo.example.com` (same password) for the second, MARKETING-vertical
demo tenant the seeder creates (#2443: thirty merchant accounts on the marketing
funnel). The
shared preview env at `preview.interncrm.com` keeps its own single database.

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
- Wildcard DNS `*.interncrm.com` → the server (Cloudflare-proxied), so `pr<N>`
  resolves. Plesk issues/uses the subdomain's TLS; Cloudflare terminates at the edge.
- `/etc/internship-crm/preview.env` (chmod 600) with `DATABASE_URL` (the shared
  preview DB), `NEXTAUTH_SECRET`, `SMTP_*`.

### Verified live
Confirmed end-to-end on the live box: opening a PR builds the image, creates the
`pr<N>.interncrm.com` route proxying to the container, comments the URL,
and serves the app (`/api/health` → 200); closing the PR removes the subdomain and
container.

---

## Where the work runs (2026-07-29, re-checked 2026-10-16)

The repo is **public**, so GitHub-hosted runners (x64 and arm64) are free and unmetered.
(It was private and metered 2026-10-08..14; public again since 2026-10-14, #2949.)
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
NEXTAUTH_URL=https://interncrm.com
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
| `deploy-preview.yml` | https://preview.interncrm.com | `internship-crm-preview` | 3201 | `…:preview-<sha>` | push to `main`, every 6h (`:23`), manual |
| `deploy-prod.yml` | https://interncrm.com | `internship-crm` | 3200 | `…:prod-<sha>` | push to `main`, every 6h (`:53`), manual |

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
but with `NEXTAUTH_URL=https://preview.interncrm.com`. There is no need to write it by
hand: when absent, `deploy-prod.sh` derives it from the running preview container. The
workflow keeps a valid file and only deletes one that fails to `source` or has no
`DATABASE_URL`, so an automatic run can never destroy the only copy of those values.

> **Future:** prod moves to a weekly release train while preview keeps tracking `main`.
> The switch is one edit in `deploy-prod.yml` — drop the `push:` block, uncomment the
> weekly `schedule:` entry.

### Topic-preview foundations without Actions
```bash
# DNS (from anywhere): wildcard *.interncrm.com A record
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

### When the box is full (memory admission, 2026-10-22)
On 2026-10-21 a preview deploy's tool container was OOM-killed mid-`prisma db push`
(exit 137) while many topic environments were up. The runner never took another
job, and every deploy — prod's included — queued behind it for a day, while the
watchdog reported OK (it checked the first `actions.runner.*` unit on the box,
which belongs to another repository). Three changes keep that from recurring:

- **Topic environments are admitted, not assumed.** Before anything is pulled,
  `topic-deploy.sh` asks `topic_capacity_verdict()` (`infra/server/capacity.sh`)
  whether the box has room for one more container plus the headroom a prod/preview
  deploy needs. If not, nothing is started, the job ends **green** and the PR gets a
  "⏸ Topic preview not deployed — the server is busy" comment: a full server is not
  a broken PR. Re-run the **Topic Preview** workflow once other PRs have closed.
  Every topic container also gets a hard `--memory` limit, so one PR cannot eat
  the box.
- **Prod/preview deploys check memory first.** `deploy-prod.sh` refuses to start
  (before the backup and the schema sync, never in the middle of them) when
  `MemAvailable` is below `DEPLOY_MIN_AVAILABLE_MB`, and logs the biggest
  containers. The schema sync runs `prisma db push --skip-generate`: the image
  already carries the generated client, and `generate` is where the OOM hit.
- **The watchdog watches *our* runner, and its queue.** `runner-watchdog.yml`
  selects the unit by runner name (`vars.RUNNER_NAME`, default `interncrm`), installs
  a `Restart=always` drop-in, and asks GitHub whether the runner drains its queue
  (`scripts/runner-queue.mjs`): jobs for its label waiting ≥ 30 min with nothing
  running on it → `systemctl restart`. "The service is active" is not "it takes jobs".
  The box has the last word: while this runner has a live `bin/Runner.Worker` (a job in
  flight) it is never restarted, whatever the API said — GitHub's filtered run listings
  come back empty now and then, and a restart would cancel the job, a prod deploy included.
  It reaches the box through the `SSH_*` secrets, which must point at **the runner's box**
  (the Caddy host since the 2026-09 migration). Each run prints a `Box:` marker line
  (`plesk=yes` means the secrets still reach the retired Plesk box); until they are
  moved the watchdog can only report, not restart. `mysql-watchdog.yml` uses the
  same secrets (its user needs the `docker` and `adm` groups, see § 6). The
  Plesk-era `infra-setup.yml` that also used them was removed in #3135: its DNS
  step is `infra/setup-dns-cloudflare.sh`, its TLS step is `wildcard-cert.yml`,
  and its nginx step has nothing to check on a Caddy host.
  A stall (even one this run restarted away), an unreachable box, a missing runner or a
  failed restart now opens one `ci-alert` issue keyed `runner-watchdog` — its cc to the
  maintainer is the e-mail — and the next healthy run closes it
  (`scripts/runner-watchdog-alert.mjs`). GitHub starts the `*/15` schedule late, often hours
  apart, so this detection is best-effort: an alert can arrive well after the stall began.

| Knob | Where | Default | Meaning |
|---|---|---|---|
| `TOPIC_MEMORY_MB` | repo variable | 1024 | hard memory limit of one topic container |
| `TOPIC_HEADROOM_MB` | repo variable | 2048 | kept free for prod/preview deploys |
| `TOPIC_MAX_ENVS` | repo variable | 8 | topic containers running at once, at most (a redeploy of a running one is not counted again) |
| `DEPLOY_MIN_AVAILABLE_MB` | env of `deploy-prod.sh` | 768 | a prod/preview deploy needs this free (`0` = off) |
| `RUNNER_NAME` | repo variable | `interncrm` | the runner the watchdog looks after |
| `RUNNER_STUCK_AFTER_MIN` | repo variable | 30 | queue wait that counts as stuck |

The rules are pinned by `infra/test/capacity.test.sh`,
`scripts/test/runner-queue.test.mjs` and `scripts/test/runner-watchdog-alert.test.mjs` (all in CI).

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

### Daily backup (systemd timer)

The deploy-time dump only covers deploys. Everything else — a bad bulk delete, a
disk failure — needs a scheduled one. On the Docker host it is the
`internship-backup.timer` that `infra/server/bootstrap.sh` (`step_backups`)
installs: daily at **02:40 UTC** (+ up to 5 min jitter, `Persistent=true`),
running **`/opt/internship-crm/bin/backup-db.sh --env prod`** as root with
`KEEP_DAYS=14` and the host-side `DATABASE_URL` from
`/etc/internship-crm-backup.env`. Preview has its own pair,
`internship-backup-preview.timer` at **02:50 UTC**, which sources
`/etc/internship-crm/preview.env` (preview runs with `NETWORK=host`, so its
`DATABASE_URL` already reaches MySQL on 127.0.0.1) and is skipped while that
file does not exist (#3166). A box bootstrapped before #3166 has only the prod
timer; `sudo infra/server/bootstrap.sh --only backups` (idempotent) installs it — and
the same step re-fetches `backup-db.sh` from `main`, which also cures the stale
prod copy described next.

`/opt/internship-crm/bin/backup-db.sh` is a **copy**, fetched from `main` when
bootstrap last ran. A change to `infra/backup-db.sh` does not reach the timer
until it is fetched again:

```bash
sudo curl -fsSL -o /opt/internship-crm/bin/backup-db.sh \
  https://raw.githubusercontent.com/21072026/Internship/main/infra/backup-db.sh
sudo chmod 0755 /opt/internship-crm/bin/backup-db.sh
systemctl list-timers 'internship-backup*'      # next runs
```

The timer runs as root, the deploy hook and the freshness check as the runner
user. So a dump written as root is handed to the **owner of the backup
directory** (`chown --reference`, #2989) — otherwise it stays root-owned `0600`
and the check reports the newest backup as unreadable every morning after the
timer ran. A copy fetched before #2989 does not do that (#3166): a prod dump
stamped ~02:4x that is `root 600` is the signature.

(The older recipe — `install` to `/usr/local/bin/internship-backup-db` plus a
root crontab line at 03:15 — is the Plesk-era setup. If a box has **both**, it
takes two dumps a day and either copy can be the stale one; keep the timer and
drop the cron line.)

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
  app images by name instead. (The Plesk-era `deploy.yml`, which had a blanket
  prune, was removed on 2026-09-15 — a revived GitHub→SSH deploy would eat the
  rollback targets, which is one more reason not to bring it back.)
- **A fresh environment has no rollback target** until its first deploy under
  this scheme replaces something. `--rollback` says so rather than guessing.

### Overrides (use knowingly)

| Variable | Effect |
|---|---|
| `FORCE_NO_BACKUP=1` | deploy without taking a backup |
| `ALLOW_DESTRUCTIVE=1` | apply a data-destroying schema change — **refused unless a backup was taken in the same run** |
| `BACKUP_DIR`, `KEEP_DAYS`, `MIN_BYTES` | where/how long/how small |

---

## 6. MySQL watchdog (the database keeps getting OOM-killed)

**Symptom.** The site is up but every page that touches data fails, and the
sign-in form used to print the driver's own words:

```
Invalid `prisma.user.findUnique()` invocation:
Can't reach database server at `localhost:3306`
```

**Cause.** The kernel's OOM killer picks `mysqld` — it is normally the largest
process on the server — and SIGKILLs it. On the retired Plesk box the packaged
systemd unit then stayed down until somebody typed `service mysql start`: the
repair took two seconds, the *detection* took hours.

### Two layers on the Docker host (#3135)

MySQL 8 runs in the container `internship-mysql`
(`/opt/internship-crm/mysql/compose.yml`, written by `infra/server/bootstrap.sh`),
published on `127.0.0.1:3306` and holding every database on the box — prod,
preview, the topic environments and demo.

| Layer | What it covers | Where it lives |
|---|---|---|
| Docker's restart policy (`restart: unless-stopped`) | brings mysqld back seconds after a kill, with no start-rate limit to give up on | the compose file above |
| GitHub-hosted workflow, every 10 min | the states Docker leaves alone — a container stopped by hand and forgotten, a crash loop, a mysqld that runs but does not answer — and the box itself being unreachable. The only layer that **alerts** (a `ci-alert` issue; the e-mail is best effort) | `.github/workflows/mysql-watchdog.yml` → `infra/mysql-watchdog.sh` over SSH |

The first layer is not a theory. On 2026-10-21 at 14:37:42 the kernel OOM-killed
mysqld; Docker had the container running again at 14:37:51 and it took
connections at 14:38:09. `dockerd` itself runs with `Restart=always` and
`OOMScoreAdjust=-500`, and `live-restore` is on, so a daemon restart does not take
the database down with it.

The second layer runs off-box deliberately: an alert that needs the sick server
to be healthy is not an alert. That day the box's self-hosted runner died in the
same OOM.

### What was retired, and why

The Plesk box needed two more layers: a systemd drop-in for the MySQL unit
(`Restart=always`, no start-rate limit, `OOMScoreAdjust=-500`) and a once-a-minute
on-box timer that ran `systemctl start`. There is no MySQL unit on this host, and
the drop-in's job is the restart policy's. So `--install`/`--uninstall` are gone
(the script refuses them with a pointer here), and **the watchdog never restarts
the database itself**. Every state in which `unless-stopped` leaves it down is one
a restart from outside would make worse:

- **being restarted** — Docker is already doing it. The check waits up to
  `WAIT_SECONDS` (120 s) before it calls the database down, so a kill Docker
  repairs ends green, with the kernel's verdict in the log;
- **stopped by hand** — Docker records a `docker stop` as deliberate and leaves it.
  Starting a database underneath a restore or a migration is how a restore gets
  corrupted, so the alert names the command (`docker start internship-mysql`) and
  leaves the decision to a human;
- **running but not answering** — InnoDB replaying its redo log after a kill, or a
  box swapping itself to a standstill. A restart interrupts the recovery it is
  waiting for, and loops.

### Run it by hand

```bash
./infra/mysql-watchdog.sh --status   # container, restart policy, restarts, OOM kills, memory
./infra/mysql-watchdog.sh            # the check the workflow runs: exit 0 up, 1 down
```

The SSH user needs the `docker` group (container state) and `adm` (kernel log) —
no sudo, no credentials. The workflow copies the script to `~/internship-infra/`
on every run rather than having the box pull it.

### What "alive" means here

The probe asks whether the **server answers the protocol**, not whether we can
log in: a `mysqladmin ping` answered with `Access denied` is a healthy server
refusing an anonymous client — which is exactly what the box answers today. It
uses the host's `mysql-client` (a bootstrap package); the bare TCP connect is only
a fallback, and a weak one here, because `docker-proxy` holds the published port
open for as long as the container runs. The decisions — alive or not, wait or
not, and that no run issues `docker start`/`restart` or an unformatted `docker
inspect` (the healthcheck carries the root password on its command line) — are
pinned by `infra/test/mysql-watchdog.test.sh`, run in CI.

### The kernel log is the evidence, not Docker's `OOMKilled`

The container has no memory limit, so a kill comes from the host-wide OOM killer,
and Docker's `State.OOMKilled` stays `false` — it reports only a kill by the
container's own limit. The record is the kernel log:

```bash
journalctl -k --since '-7 days' | grep -iE 'killed process [0-9]+ \((mysqld|mariadbd)\)'
```

`--status` counts those lines for the last 24 hours, and calls three of them
*flapping*: Docker repaired each one, which is exactly why nobody noticed.

### The restart is first aid, not the cure

When kills repeat, the box needs headroom, not a faster watchdog:

- see "When the box is full (memory admission, 2026-10-22)" above — the 2026-10-21
  kill came during a preview deploy with many topic environments up;
- the box has a 4 GB swapfile (bootstrap step `swap`); check it is still on with
  `swapon --show`;
- `--status` prints the top memory consumers by RSS;
- mysqld runs with the default `oom_score_adj` of 0. The drop-in's `-500` has a
  Docker equivalent (`oom_score_adj` in the compose file), but it takes effect only
  when the container is recreated — a restart of every database on the box — so it
  is a decision for a maintenance window, not a side effect of a watchdog change.

### What the user sees while it is down

Nothing about MySQL. The sign-in form says "temporarily unavailable, try again
in a few moments" — `src/lib/authGuard.ts` maps an unreachable database to a
stable code and logs the real cause server-side. A raw driver message on a login
form tells the visitor nothing and an attacker something.
