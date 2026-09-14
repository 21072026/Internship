# Epic 5 — Deploy it and keep it running

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **High** · Effort **Medium**

**DE:** Die Anwendung tatsächlich in Betrieb nehmen und betreibbar halten.
**TR:** Uygulamayı gerçekten yayına al ve işletilebilir tut.

The pipeline is written and its gates are tested, but **it has never run**:
there is no server, no self-hosted runner, no env file, no scheduled backup. A
deploy path that has never executed is a plan, not infrastructure.

Most of this is server work rather than code, and it blocks nothing else — but
nothing is real until it is deployed.

---

## Story 5.1 — First production deploy

`Feature` · Priority **High** · Effort **Medium**

**DE:** Server vorbereiten und den ersten Deploy durchführen.
**TR:** Sunucuyu hazırla ve ilk deploy'u yap.

---

### T-5.1.1 — Provision the self-hosted runner

`Task` · Priority **High** · Effort **Medium** · `documentation`

**DE:** Self-hosted Runner auf dem Server einrichten und als Dienst starten.
**TR:** Sunucuda self-hosted runner kur ve servis olarak başlat.

**Done when**
- A runner labelled `self-hosted` is registered for this repository and running
  as a service.
- Its user can run `docker` and read `/etc/salevali-crm/*.env`.
- `infra/README.md` records what was actually done, including anything that
  differed from the instructions.
- The `push:` and `schedule:` triggers are uncommented in `deploy-prod.yml` and
  `deploy-preview.yml` — they are dispatch-only until a runner exists, because a
  run waiting for a runner that never answers just fails hours later.

**Prompt**

> Set up the self-hosted GitHub Actions runner for the SaleVali Marketing CRM
> on the deployment server, following the prerequisites in `infra/README.md`.
>
> Register it for `21072026/Marketing` with the `self-hosted` label, install it
> as a service so it survives a reboot, and confirm its user is in the `docker`
> group and can read `/etc/salevali-crm/prod.env` once that exists.
>
> Verify with a `workflow_dispatch` run of `deploy-prod.yml` that reaches the
> gate job and stops there (the env file will be missing, which is the expected
> failure at this point). Then update `infra/README.md` with what actually
> happened — every server setup differs from its instructions somewhere, and
> that delta is the part worth writing down.

---

### T-5.1.2 — Create the production env file

`Task` · Priority **High** · Effort **Low**

**DE:** `prod.env` mit allen Secrets anlegen, inklusive `HEALTH_TOKEN`.
**TR:** Tüm secret'ları içeren `prod.env` dosyasını oluştur, `HEALTH_TOKEN` dahil.

**Done when**
- `/etc/salevali-crm/prod.env` exists, `chmod 600`, owned by the runner user.
- It contains every variable listed in `infra/README.md`, with a real
  `HEALTH_TOKEN`.
- The database user in `DATABASE_URL` can create and alter tables.

**Prompt**

> Create the production environment file for the SaleVali Marketing CRM at
> `/etc/salevali-crm/prod.env`, `chmod 600`, using the list in
> `infra/README.md`.
>
> Generate a strong `HEALTH_TOKEN` — with it set, `/api/health` stops handing
> the version and git sha to anonymous callers, and `/api/health/smtp` starts
> refusing them. The deploy scripts read the same file, so the drift gate keeps
> working.
>
> Check that the MySQL user in `DATABASE_URL` may create and alter tables: the
> deploy runs `prisma db push`, and a read-mostly grant fails halfway through
> the first deploy, which is the worst moment to find out. Do not paste the
> file's contents into a ticket, a PR or a chat.

---

### T-5.1.3 — Reverse proxy and TLS

`Task` · Priority **High** · Effort **Medium**

**DE:** Reverse Proxy und Zertifikate für Produktion und Preview.
**TR:** Prod ve preview için reverse proxy ve sertifikalar.

**Done when**
- The production domain serves the container on `:3300` over HTTPS; preview
  serves `:3301`.
- HTTP redirects to HTTPS, and the app's HSTS header is not contradicted by the
  proxy.
- `NEXTAUTH_URL` matches the public URL exactly, scheme included.

**Prompt**

> Put a reverse proxy in front of the SaleVali Marketing CRM: the production
> domain to `127.0.0.1:3300`, the preview domain to `127.0.0.1:3301`, both over
> HTTPS with automatic certificate renewal.
>
> Two details that cause real bugs: `NEXTAUTH_URL` must match the public URL
> exactly, scheme and trailing slash included, or the sign-in redirect chain
> breaks in ways that look like an auth bug; and the app already sends HSTS
> (see `next.config.js`), so the proxy must not send a contradicting one.
>
> Forward the client IP, and record the vhost configuration in
> `infra/README.md`.

---

### T-5.1.4 — Rehearse on preview first

`Task` · Priority **High** · Effort **Medium**

**DE:** Den gesamten Ablauf zuerst auf Preview durchspielen.
**TR:** Tüm akışı önce preview üzerinde prova et.

**Done when**
- `deploy-preview.yml` has run end to end and preview serves the app.
- The health check reports the sha that was just built.
- The backup and schema-guard steps have both been observed running.

**Prompt**

> Run the full deploy pipeline of the SaleVali Marketing CRM against
> **preview** before anything touches production: create
> `/etc/salevali-crm/preview.env` with a separate database, then dispatch
> `deploy-preview.yml`.
>
> Confirm four things in the run log rather than assuming them: the image was
> built on the GitHub-hosted runner and pulled on the server; the backup step
> ran (it is advisory on preview, so check it actually succeeded rather than
> warned); the schema guard reported the diff; and the post-swap health check
> matched the served sha against the deployed one.
>
> Anything surprising here is a bug in `infra/deploy-prod.sh` worth fixing
> while it is only preview that is broken. Write up what you found.

---

## Story 5.2 — Keep it running

`Feature` · Priority **High** · Effort **Medium**

**DE:** Sicherungen, Überwachung und Sichtbarkeit im Betrieb.
**TR:** Yedekler, izleme ve işletimde görünürlük.

---

### T-5.2.1 — Nightly backup on a timer

`Task` · Priority **High** · Effort **Low**

**DE:** Nächtliche Datenbanksicherung einrichten.
**TR:** Gecelik veritabanı yedeğini zamanla.

**Done when**
- A systemd timer runs `infra/backup-db.sh` nightly.
- Dumps land in `/var/backups/salevali-crm` and older ones are pruned by
  `KEEP_DAYS`.
- A failed backup is visible somewhere other than the exit code.

**Prompt**

> Schedule `infra/backup-db.sh` nightly on the SaleVali Marketing CRM server
> with a systemd service and timer, reading `DATABASE_URL` from
> `/etc/salevali-crm/prod.env`.
>
> The deploy already takes a dump before each schema sync, but deploys are
> irregular; a bad bulk edit on a quiet week is exactly what a nightly dump
> protects against. Confirm the pruning works by checking the directory after a
> few runs.
>
> A silent failure defeats the purpose: make the unit's failure visible —
> `OnFailure=` calling a small alerting unit, or a wrapper that pipes the error
> into `scripts/send-alert-email.mjs`. Document the choice in `infra/README.md`.

---

### T-5.2.2 — Prove a restore actually works

`Task` · Priority **High** · Effort **Medium** · `documentation`

**DE:** Wiederherstellung tatsächlich testen und dokumentieren.
**TR:** Geri yüklemeyi gerçekten dene ve dokümante et.

**Done when**
- `docs/disaster-recovery.md` gives step-by-step restore instructions.
- The steps have been executed against a scratch database, not just written.
- The doc records how long it took and what was needed.

**Prompt**

> Write `docs/disaster-recovery.md` for the SaleVali Marketing CRM — and
> **execute it** before committing, against a scratch database, from a real
> dump produced by `infra/backup-db.sh`.
>
> An untested restore procedure is a guess, and the moment you find out it was
> wrong is the moment you can least afford it. Note anything the run needed
> that the doc did not initially mention (credentials, a `CREATE DATABASE`, a
> character-set flag), and record how long it took, so whoever runs it under
> pressure knows whether ten minutes of silence is normal.
>
> Cover both cases: full loss of the database, and restoring a single table
> after a bad edit. Link it from `infra/README.md`.

---

### T-5.2.3 — External uptime monitoring

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Externe Überwachung von `/api/health` einrichten.
**TR:** `/api/health` için dış izleme kur.

**Done when**
- An external monitor polls `/api/health` every few minutes and alerts on
  non-200.
- It uses the anonymous shape — no `HEALTH_TOKEN` handed to a third party.
- Who receives the alert is written down.

**Prompt**

> Set up external uptime monitoring for the SaleVali Marketing CRM against
> `https://<prod-domain>/api/health`, polling every few minutes and alerting on
> anything other than 200.
>
> Use the plain endpoint with no token: the anonymous response is exactly this
> — liveness and a timestamp — and there is no reason to hand `HEALTH_TOKEN`,
> which unlocks the version and git sha, to a third-party service. That
> separation is why the endpoint is shaped this way (`SECURITY.md`).
>
> Record in `infra/README.md` which service is used and who gets the alert. An
> alert nobody is named for is an alert nobody answers.

---

### T-5.2.4 — Show the running version in the UI

`Task` · Priority **Low** · Effort **Low** · `good first issue`

**DE:** Version und Commit im Interface anzeigen.
**TR:** Sürüm ve commit'i arayüzde göster.

**Done when**
- The sidebar footer shows `v0.2.0 · a1b2c3d`, from `src/lib/version.ts`.
- Preview deployments are visually marked as preview.
- Locally it reads `dev` without any special handling.

**Prompt**

> Show the running build in the SaleVali Marketing CRM UI: a small line in the
> sidebar footer with `APP_VERSION` and `GIT_SHA` from `src/lib/version.ts`,
> and a "Preview" chip when `APP_ENV` is `preview`.
>
> This turns "is my fix live?" from a question into a glance, and it is the
> same sha the deploy gate and `/api/health` report, so a bug report can name
> the exact build. Keep it quiet visually — muted text, small — and make sure
> it reads `dev` locally without special-casing.

---

### T-5.2.5 — Email a summary after the scheduled full E2E run

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Nach dem geplanten Testlauf eine Zusammenfassung per E-Mail.
**TR:** Zamanlanmış test koşusundan sonra özet e-posta gönder.

**Done when**
- After `e2e-full.yml`, a summary email goes out: a green heartbeat, or the
  failing tests with error snippets.
- Both shards are merged into one message, not two.
- A repository variable can switch it to failures-only.

**Prompt**

> Add an email summary to `.github/workflows/e2e-full.yml` in the SaleVali
> Marketing CRM. The suite runs twice a day and reports into the Actions tab,
> which nobody watches — a test suite whose results are never read is
> decoration.
>
> Add `scripts/e2e-report-email.mjs` that merges the two shards' JSON reports
> (have each shard upload one and add a job that downloads both) and sends via
> `scripts/send-alert-email.mjs`. Green: a one-line heartbeat, `✅ 20/20`.
> Red: the failing test titles with a short error snippet each, capped so the
> mail stays readable.
>
> Respect a repository variable `E2E_REPORT_MODE=failures` to suppress the
> green heartbeat, and make an unset `ALERT_EMAIL_TO` a warning rather than a
> job failure — a missing alert address must not turn a green suite red.
