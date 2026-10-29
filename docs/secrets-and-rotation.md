# Secrets inventory and rotation runbook (#1554)

> **Türkçe özet.** Bu belge `.env.example`'daki her değişkeni ve CI'daki her GitHub
> secret'ını sınıflandırır: neyi koruduğu, yetkili kopyanın nerede durduğu, kimin
> okuyabildiği, sızarsa ne olacağı ve nasıl döndürüleceği. En önemli bulgu:
> **`NEXTAUTH_SECRET` tek kök anahtardır.** Oturumların yanında yaklaşık yirmi
> mekanizma ondan türer: mühürlenmiş sütunlar (Google token'ları, SSO SP anahtarı,
> roster/Klaviyo kimlik bilgileri, IBAN'lar, kuyruktaki e-postalar), 2FA kurtarma
> kodları, posta kampanyası blok listesi ve gelen kutularındaki bağlantılar. Bu
> yüzden onu döndürmek bir değer değişimi değil, planlı bir operasyondur (§ 3.1).
> Döngü: yıllık planlı rotasyon, üç ayda bir erişim gözden geçirmesi; şüpheli
> sızıntıda ilk saat prosedürü § 4'tedir.

This is a document, not an env file: **no real value, nor anything derived from
one, belongs in this repository.** If you find one while editing this page, stop
and rotate it first (§ 4).

Sibling documents: [`disaster-recovery.md`](disaster-recovery.md) (a restore needs
the env file as well as the dump, § 6 below),
[`security-exceptions.md`](security-exceptions.md) (accepted residual risk), and
[`security-audit-playbook.md`](security-audit-playbook.md).

## 1. Where secrets live

| Store | What is in it | Who can read it |
|---|---|---|
| `/etc/internship-crm/{prod,preview}.env` on the app server (root-owned, `0600`) | every runtime secret of that environment; `infra/deploy-prod.sh` sources it and passes it into the container | anyone with root on the box: the maintainer (SSH key) and the self-hosted runner's user through the deploy scripts |
| Topic envs (`infra/server/topic-deploy.sh`) | **source `preview.env` itself**: same `NEXTAUTH_SECRET` and SMTP values as preview, own database and `NEXTAUTH_URL`, mail to a Mailpit sink unless every recipient is allowlisted | same as above. Any PR branch from a collaborator runs with preview's root secret, which is one more reason prod and preview never share a value |
| GitHub → repository secrets | CI and ops credentials (§ 2.6) — never the app's runtime secrets | repository admins (the maintainer). Workflows on forks get none (`topic-preview.yml` skips forks) |
| The running container's environment | a copy of the env file | root on the box (`docker inspect`) |
| Database (sealed columns) | ciphertext under keys derived from `NEXTAUTH_SECRET` (§ 3.1) | useless without the env file — which is exactly why a backup restore needs both (§ 6) |
| The maintainer's password manager | the off-box copy of each env file and of `RESTIC_PASSWORD` | the maintainer |

Owner of every secret below: **the maintainer (sole rights holder and operator)**.
There is no second person with production access today (§ 5).

## 2. Inventory

Blast radius is "what an attacker can do with this value alone".

### 2.1 The root secret

| Variable | Protects | Blast radius if leaked |
|---|---|---|
| `NEXTAUTH_SECRET` | session JWTs (`src/middleware.ts`, `src/lib/auth.ts`) **and**, through `requireServerSecret()` (`src/lib/serverSecret.ts`), every HMAC and every sealed column in the app — the full list is in § 3.1 | **Full compromise.** Mint a session as any user, including an ADMIN of any org; forge reply, unsubscribe, consent and meeting-feedback links; decrypt every sealed column in a database dump (Google refresh tokens, SSO SP private keys, roster-feed and Klaviyo credentials, affiliate IBANs, queued mail). Combined with a backup it reads everything |

### 2.2 Data stores

| Variable | Protects | Blast radius |
|---|---|---|
| `DATABASE_URL` | the MySQL credentials | read/write every tenant's data — only from a host that can reach the DB port (it is bound to the box, not public) |
| `RATE_LIMIT_REDIS_URL` | the shared limiter store (unset at one replica) | reset or poison rate-limit counters; the limiter fails open, so no lock-out |

### 2.3 Mail

| Variable | Protects | Blast radius |
|---|---|---|
| `SMTP_PASS` (with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`) | the transactional relay account | send mail as our domain: phishing that passes SPF/DKIM. Reputation damage outlives the rotation |
| `SMTP_BULK_PASS` (with `SMTP_BULK_HOST`, `SMTP_BULK_PORT`, `SMTP_BULK_USER`, `SMTP_BULK_FROM`) | the bulk lane's relay account | same, on the bulk domain |
| `INBOUND_IMAP_PASS` (with `INBOUND_IMAP_HOST`, `INBOUND_IMAP_PORT`, `INBOUND_IMAP_USER`, `INBOUND_IMAP_MAILBOX`) | the reply mailbox the IMAP bridge polls | read every reply people sent to a reply address — mentee/mentor correspondence |
| `INBOUND_SECRET` | `POST /api/inbound-email` from the mail provider | inject messages into threads, but only ones that also carry a valid reply token (HMAC under `NEXTAUTH_SECRET`) |
| `EMAIL_WEBHOOK_SECRET` | `POST /api/webhooks/email/[provider]` (bounces/complaints) | suppress arbitrary addresses (`EmailSuppression`) — a denial of mail, not a read |

### 2.4 Shared secrets of our own endpoints

| Variable | Protects | Blast radius |
|---|---|---|
| `CRON_SECRET` | `POST /api/cron/start` (prod only — empty elsewhere on purpose) | start the scheduler on a process; the lease (`src/lib/jobs/lease.ts`) still keeps it single-owner |
| `HEALTH_TOKEN` | the detailed `GET /api/health` (sha, limits, mail block) | read operational detail: deployed sha, queue depth. No personal data |
| `JAAS_WEBHOOK_SECRET` | `POST /api/webhooks/jaas` | forge meeting-usage events (metering is reported, never gated) |
| `SLACK_SIGNING_SECRET` | inbound Slack requests | forge Slack interactions into a connected workspace's channel mapping |

### 2.5 Third-party credentials

| Variable | Protects | Blast radius |
|---|---|---|
| `ANTHROPIC_API_KEY` | the AI provider account | spend on our bill; no access to our data |
| `JAAS_PRIVATE_KEY` (with `JAAS_API_KEY_ID`, `JAAS_APP_ID`) | signs the JWT that opens a video room | join or create rooms on our JaaS tenant, spend our minutes |
| `GOOGLE_CLIENT_SECRET` (with `GOOGLE_CLIENT_ID`) | the Calendar OAuth client | impersonate our OAuth app in a consent flow. **Not** the users' tokens — those are sealed (§ 3.1) |
| `MICROSOFT_CLIENT_SECRET` (with `MICROSOFT_CLIENT_ID`) | the Microsoft 365 / Outlook calendar app registration (#1991) | impersonate our app in a delegated consent flow. **Not** the users' tokens — sealed under `microsoft-calendar` (§ 3.1) |
| `SLACK_CLIENT_SECRET` (with `SLACK_CLIENT_ID`) | the Slack app's OAuth | same shape as Google's |
| `TEAMS_APP_PASSWORD` (with `TEAMS_APP_ID`, `TEAMS_TENANT_ID`) | the Teams bot registration | post as our bot where it is installed |
| `KLAVIYO_PRIVATE_API_KEY` | the env-level Klaviyo key (read-only scopes) — per-org keys are sealed in `ExternalConnection.sealedKey` | read that Klaviyo account's profiles — personal data |
| `EXPO_ACCESS_TOKEN` | native push through Expo's enhanced security | send push notifications to our app's devices |
| `VAPID_PRIVATE_KEY` (with `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`) | web push | send web push to every subscribed browser |
| `SUPPORT_GITHUB_TOKEN` (with `SUPPORT_GITHUB_REPO`) | issues from bug reports (fine-grained, Issues only) | open/edit issues on that one repository |
| `SUPPORT_REPORT_SLACK_WEBHOOK_URL` | the URL **is** the credential | post into that Slack channel |
| `SEED_ADMIN_PASSWORD` (with `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME`) | the first ADMIN, once, at `prisma db seed` | none once the admin has changed their password — **do that right after seeding**, then delete the value from the env file |
| `ERROR_TRACKING_DSN` | the error tracker project (#1600, `docs/observability.md`) | post fake events into our tracker, spend its quota. Reads nothing: a DSN key is write-only. Server-side only so the browser cannot spam it — the browser goes through `/api/telemetry/errors` |

### 2.6 GitHub repository secrets (CI and ops, never the app runtime)

| Secret | Used by | Blast radius |
|---|---|---|
| `GITHUB_TOKEN` | every workflow (GitHub-minted, per run) | scoped to the run; nothing to rotate |
| `RELEASE_BOT_TOKEN`, `PROJECTS_TOKEN` | release compaction PRs, the project board | write to this repository / the board |
| `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PRIVATE_KEY` | the watchdog workflows | **a shell on the app server** = everything in § 2.1–2.5. The key should be a restricted, command-limited key; treat it as root-equivalent until verified |
| `CF_API_TOKEN` | `dns-records.yml`, `wildcard-cert.yml` | rewrite our DNS → redirect the domain, mint certificates. As bad as § 2.1 for anyone who signs in afterwards |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | off-site backups | read/delete the encrypted backup archive |
| `RESTIC_PASSWORD` | encrypts the off-site backups | with the R2 keys: every backup, i.e. all personal data. **Losing it = losing the off-site backups**; its off-repo copy is mandatory |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ALERT_EMAIL_TO` | CI alert e-mails | as § 2.3 for that relay account |
| `FORBIDDEN_TERMS` | the forbidden-terms guard | reveals the customer names the guard hides (it is the list itself) |
| `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_PASSWORD` | Play upload signing | sign an app update Play accepts as ours (an *upload* key — Google can reset it, unlike an app signing key) |
| `EXPO_TOKEN`, `EXPO_OWNER` | Expo builds | trigger builds on our Expo account |
| `STRESS_TARGET_URL`, `MARKETING_PROBE_URLS`, `MARKETING_PROBE_HOST_PROD`, `MARKETING_PROBE_HOST_PREVIEW`, `APP_BUNDLE_ID`, `APP_ANDROID_PACKAGE`, `TWA_PACKAGE_ID` | kept secret to keep tenant hostnames out of logs, not because they grant anything | none |

### 2.7 Public by design, and configuration

These are **not secrets**. They are listed so nobody has to wonder.

- Shipped to every browser: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_GA4_MEASUREMENT_ID`,
  `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`, `NEXT_PUBLIC_PLAUSIBLE_HOST`, `NEXT_PUBLIC_POSTHOG_HOST`,
  `NEXT_PUBLIC_POSTHOG_KEY` (a write-only project key), `VAPID_PUBLIC_KEY`.
- Public identifiers of an app: `GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT`, `SLACK_CLIENT_ID`, `TEAMS_APP_ID`,
  `TEAMS_TENANT_ID`, `JAAS_APP_ID`, `JAAS_API_KEY_ID`, `KLAVIYO_ORG_ID`.
- Published legal notice (Impressum): `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL`,
  `OPERATOR_PHONE`, `OPERATOR_REGISTER`, `OPERATOR_RESPONSIBLE`, `OPERATOR_VAT_ID`,
  `OPERATOR_DPO` and their `MARKETING_OPERATOR_*` twins (`MARKETING_OPERATOR_NAME`,
  `MARKETING_OPERATOR_ADDRESS`, `MARKETING_OPERATOR_EMAIL`, `MARKETING_OPERATOR_PHONE`,
  `MARKETING_OPERATOR_REGISTER`, `MARKETING_OPERATOR_RESPONSIBLE`, `MARKETING_OPERATOR_VAT_ID`,
  `MARKETING_OPERATOR_DPO`), `UNSUBSCRIBE_MAILTO`, `MAIL_FROM_NAME`.
- Hosts and URLs: `NEXTAUTH_URL`, `APP_ROOT_DOMAIN`, `MARKETING_HOSTS`, `MARKETING_HOSTS_NONE`,
  `INBOUND_EMAIL_DOMAIN`, `CHAT_OAUTH_REDIRECT_URI`, `GOOGLE_OAUTH_REDIRECT_URI`,
  `GOOGLE_OAUTH_REVOKE_URL`, `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_CALENDAR_API_BASE`,
  `MICROSOFT_OAUTH_REDIRECT_URI`, `MICROSOFT_OAUTH_AUTHORIZE_URL`, `MICROSOFT_OAUTH_TOKEN_URL`, `MICROSOFT_GRAPH_API_BASE`,
  `SLACK_API_BASE`, `SLACK_OAUTH_AUTHORIZE_URL`, `TEAMS_LOGIN_BASE`, `CHAT_APPS_STUB_CLIENT`, `ANDROID_APP_LINKS`, `MAIL_SINK_HOST`, `MAIL_SINK_PORT`,
  `ALERT_EMAIL_TO`.
- Switches and tuning: `CRON_ENABLED`, `JOBS_WORKER_ENABLED`, `JOBS_CONCURRENCY`,
  `MAIL_WORKER_ENABLED`, `INBOUND_IMAP_POLL_SECONDS`, `MAIL_BURST`, `MAIL_DAILY_CAP`, `MAIL_RATE_PER_MIN`,
  `MAIL_URGENT_RESERVE`, `MAIL_QUEUE_LANES`, `MAIL_INLINE_TIMEOUT_MS`, `MAIL_METER_MODE`,
  `MAIL_RECIPIENT_ALLOWLIST`, `GOOGLE_CALENDAR_ENABLED`, `MICROSOFT_CALENDAR_ENABLED`, `CHAT_APPS_ENABLED`,
  `FEEDBACK_REPLAY_ENABLED`, `FEEDBACK_REPLAY_SECONDS`, `SUPPORT_REPORT_NOTIFY`,
  `JAAS_MONTHLY_ACTIVE_LIMIT`, `MT_ENFORCE_ISOLATION`, `SELF_SERVE_SIGNUP`, `DEMO_MODE`, `TRUSTED_PROXY_COUNT`,
  `REPLICA_ID`, `APP_TIMEZONE`, `LOG_LEVEL`, `ERROR_TRACKING_ENVIRONMENT`, `NEXT_PUBLIC_ERROR_TRACKING`, `NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE`, `DB_SLOW_QUERY_MS`, `DB_QUERY_WARN_CEILING`,
  `STATUS_SLA_TARGET`, `TENANT_HARD_DELETE_ENABLED` and `TENANT_HARD_DELETE_WAIT_HOURS` (irreversible
  tenant deletion — off unless set, [`tenant-lifecycle.md`](tenant-lifecycle.md)),
  `KLAVIYO_REVISION`, `KLAVIYO_EVENT_METRICS`, `KLAVIYO_CONVERSION_METRIC`.
- Security headers: `CSP_REPORT_ONLY` (the report-only nonce CSP, [`csp.md`](csp.md)).
- Model selection: `ANTHROPIC_CV_MODEL`, `ANTHROPIC_SUMMARY_MODEL`, `AI_MODEL_TIER_FAST`,
  `AI_MODEL_TIER_BALANCED`, `AI_MODEL_TIER_STRONG`, `AI_MODEL_CV_EXTRACT`,
  `AI_MODEL_CV_FEEDBACK`, `AI_MODEL_ANALYTICS_NARRATIVE`, `AI_MODEL_EVALUATION_INSIGHTS`,
  `AI_MODEL_INTERACTION_SUMMARY`, `AI_MODEL_INTERVIEW_PREP`, `AI_MODEL_MENTOR_MATCH`,
  `AI_MODEL_SURVEY_SUMMARY`, `AI_MODEL_WEEKLY_REPORT_DIGEST`.

`scripts/test/secrets-inventory.test.mjs` fails when a variable in `.env.example` is
not named on this page, so a new variable cannot ship unclassified.

## 3. Rotation procedures

Every rotation follows the same frame: **create the new value at the issuer → write
it to `/etc/internship-crm/<env>.env` → redeploy that environment**
(`workflow_dispatch` on `deploy-prod.yml` / `deploy-preview.yml`; the env file is
read at container start, so a restart is the cut-over) **→ verify → revoke the old
value at the issuer.** Prod and preview have **separate** values. Never copy prod's
into preview. If a rotation misses a required value, `requireServerSecret()` and the
deploy script's `:?` checks fail the start loudly, and the old container keeps
serving. A half-done rotation never runs silently on a weaker key.

### 3.1 `NEXTAUTH_SECRET` — not a swap

The code has **no overlap window**: there is one key and no "previous key" list.
Changing it does all of the following at the moment of the restart:

| Consequence | Mechanism | Mitigation |
|---|---|---|
| everyone is signed out, and remember-me devices stop working | JWT signature; trusted-device flow | announce a window; people sign in again |
| **2FA recovery codes stop matching** | stored as `HMAC(NEXTAUTH_SECRET, code)` (`src/lib/recoveryCodes.ts`) | TOTP keeps working (its secret is not derived). Tell 2FA users to **regenerate recovery codes** after the rotation |
| **sealed columns become unreadable** (`open()` returns null) | `seal()`/`open()` key = HKDF(`NEXTAUTH_SECRET`, purpose) (`src/lib/secretBox.ts`) | re-encrypt or re-enter, per row type below |
| ↳ Google Calendar tokens (`CalendarConnection`, `provider = GOOGLE`; the old `GoogleCalendarConnection` until #1989's contract step) | | users reconnect; the old grants stay live at Google until revoked there, so do that **before** the rotation if the rotation is because of a leak (`disconnect()` cannot decrypt afterwards) |
| ↳ Microsoft 365 calendar tokens (`CalendarConnection`, `provider = MICROSOFT`, #1991) | | users reconnect; the delegated grant stays listed on their Microsoft account until they remove the app there |
| ↳ SSO SP signing key (`Organization.ssoSpKey`) | `src/lib/ssoSpKey.ts` | regenerate per org and **re-upload the SP metadata at each IdP**. Coordinate with every SSO customer |
| ↳ roster-feed secrets, Klaviyo keys (`RosterFeed.secretEnc`, `ExternalConnection.sealedKey`) | | admins re-enter them; feeds and syncs fail until then |
| ↳ affiliate payout details (`AffiliatePartner.payoutDetailsCipher`) | `src/lib/affiliatePayoutDetails.ts` | partners re-enter their IBAN |
| ↳ **queued mail and held drafts** (`email.send` jobs, `OutboundDraft`) | `src/lib/mailOutbox.ts`, `src/lib/outboundDrafts.ts` | **drain the queue first** (`/admin` mail queue reads empty), and send or discard held drafts before the cut-over. Otherwise they dead-letter |
| **post-campaign block list stops matching** | `suppressionHash()` = HMAC (`src/lib/postCampaign.ts`) | **a blocked contact becomes reachable again.** Rebuild the list from its source before the next campaign. This is a legal risk (UWG § 7), not a cosmetic one |
| links already in inboxes die: reply addresses, unsubscribe, consent renewal, contact-permission confirm, meeting feedback, newsletter/report links, e-mail actions, CRM-BCC | HMAC tokens (`replyToken.ts`, `unsubscribeToken.ts`, `consentRenew.ts`, …) | **accepted breakage**: a reply to an old thread bounces into the inbound fallback, an old unsubscribe link fails (the List-Unsubscribe header of the next mail works again). Prefer a quiet weekend |
| API v1 pagination cursors and export links expire | `src/lib/api/v1.ts`, `v1Exports.ts` | API clients restart the listing |
| historical pseudonyms stop matching new ones | JaaS participant hash, contributor-terms evidence hash | accepted: they answer "same client?" within a period, not across a rotation |

**Order of operations (planned rotation):**
1. Announce a window (sessions end, recovery codes must be regenerated, SSO customers re-upload metadata).
2. Before: drain the mail queue and decide the held drafts; export the post-campaign block-list sources; note which orgs have SSO, roster feeds, Klaviyo and Google connections (`SELECT orgId, COUNT(*) …` on each table).
3. Take a backup (`infra/backup-db.sh`). The backup holds ciphertext under the **old** key, so keep the old value with that backup in the password manager (§ 6).
4. Write the new value (`openssl rand -base64 48`) to the env file and redeploy.
5. After: regenerate SSO SP keys and tell the IdPs; ask admins to re-enter feed and Klaviyo secrets; rebuild the block list; mail 2FA users about their recovery codes.

A future improvement that would make this a swap: a `NEXTAUTH_SECRET_PREVIOUS` read
by `open()` and the HMAC verifiers, plus a re-seal job. That is not built (§ 7).

### 3.2 The secret-box key

The secret box has **no key of its own.** It is derived from `NEXTAUTH_SECRET` (HKDF,
per purpose), so it rotates only with § 3.1. There is no way to rotate the box
without also rotating sessions. That is one of the reasons § 7 lists a separate box
key as future work.

### 3.3 The reply-token secret

Also **derived**: reply tokens are HMACs under `NEXTAUTH_SECRET`
(`src/lib/replyToken.ts`, no fallback secret, `timingSafeEqual`). Rotating it means
§ 3.1. There is no overlap window: replies to mail sent before the rotation stop
threading, and that breakage is accepted.

### 3.4 Simple swaps

For these, create a new value, deploy it, verify, then revoke the old one. Each needs
nothing more.

| Secret | Issuer / where to create | Verify after deploy |
|---|---|---|
| `DATABASE_URL` | `ALTER USER … IDENTIFIED BY …` in MySQL; update **both** containers' env files if they share the user | `/api/health` 200 |
| `RATE_LIMIT_REDIS_URL` | the Redis `requirepass` / ACL | `GET /api/health?limits=1` not degraded |
| `SMTP_PASS`, `SMTP_BULK_PASS` | the mail provider's panel. Also update the GitHub `SMTP_*` secrets if they are the same account | send a password-reset mail to yourself |
| `INBOUND_IMAP_PASS` | the mailbox provider | the IMAP poll log shows a successful login |
| `INBOUND_SECRET`, `EMAIL_WEBHOOK_SECRET`, `JAAS_WEBHOOK_SECRET` | random value; set the **same** one in the provider's webhook config in the same minute (deliveries in between get 401 and are retried by the provider) | the provider's delivery log shows 2xx |
| `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_SECRET`, `TEAMS_APP_PASSWORD`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` | the provider's app console ("regenerate"). Users' existing grants stay valid | connect a test workspace/calendar |
| `CRON_SECRET`, `HEALTH_TOKEN` | random value. `HEALTH_TOKEN` is also read by the deploy drift gates from the same env file, so it moves together | next deploy's gate reads the sha |
| `ANTHROPIC_API_KEY`, `KLAVIYO_PRIVATE_API_KEY`, `ERROR_TRACKING_DSN`, `EXPO_ACCESS_TOKEN`, `SUPPORT_GITHUB_TOKEN`, `SUPPORT_REPORT_SLACK_WEBHOOK_URL` | the provider's console (new key, then delete old) | one AI call / one sync / one push / one test report |
| `JAAS_PRIVATE_KEY` + `JAAS_API_KEY_ID` | JaaS console: new key pair. **Both** values change together | open a meeting room |
| `VAPID_PRIVATE_KEY` + `VAPID_PUBLIC_KEY` | `npx web-push generate-vapid-keys` | **not seamless**: every existing web-push subscription is bound to the old public key and stops receiving. Browsers re-subscribe on their next visit. Rotate only on a leak |
| `SEED_ADMIN_PASSWORD` | — | should not be in a live env file at all (§ 2.5) |

GitHub secrets (§ 2.6): rotate at the issuer, then **Settings → Secrets → Actions**.
`SSH_PRIVATE_KEY`: generate a new key, add it to `authorized_keys`, update the
secret, run a watchdog workflow, then remove the old line. `RESTIC_PASSWORD`: restic
supports several keys per repository (`restic key add` then `restic key remove`), so
it is a true swap. Keep the new one off-repo **before** removing the old.
`CF_API_TOKEN`: roll it in the Cloudflare dashboard (scoped to the zone).

## 4. Suspected leak — the first hour

Act in this order. Steps 1–3 matter more than tidiness.

1. **Contain at the issuer.** Revoke what can be revoked without a deploy:
   provider API keys, SMTP password, `CF_API_TOKEN`, `SSH_PRIVATE_KEY` (delete the
   `authorized_keys` line), GitHub tokens. For the box itself (env file, SSH key or
   root suspected): rotate the SSH access first, because every other secret is
   readable from there.
2. **If `NEXTAUTH_SECRET` or `DATABASE_URL` is in scope**, assume a full read
   (§ 2.1): revoke the users' Google grants **before** rotating (afterwards
   `disconnect()` cannot decrypt the token to revoke it), then rotate per § 3.1
   **without** the courtesy window. Rotate `DATABASE_URL` in the same deploy.
3. **Things that must move together:** `NEXTAUTH_SECRET` + (re-entry of) every
   sealed credential: SSO SP keys, roster/Klaviyo secrets, IBANs. A leaked env file
   means **every** value in it, so rotate them all in one deploy. A leaked backup
   plus `RESTIC_PASSWORD` is a personal-data breach even if no secret was in it.
4. **Record** the time, the suspected scope and every action in the incident
   notes. A personal-data breach starts the GDPR Art. 33 72-hour clock. Tell the
   affected tenants per their DPA.
5. **Look**: `AuditLog` / `ActivityLog` for sign-ins and admin actions after the
   suspected time, `authz.capability_denied` rows, and new API keys
   (`/admin/api-keys`).

## 5. Cadence and access review

- **Scheduled rotation: annually**, in the first quiet week of January, for every
  simple swap (§ 3.4) and the GitHub secrets. Annual is what a one-person operation
  will actually honour; a quarterly promise that slips is worse than an annual one
  that holds. `NEXTAUTH_SECRET` is rotated **on suspicion only**: the cost table in
  § 3.1 is the reason, and building § 7's overlap key is the precondition for
  putting it on the schedule.
- **Access review: quarterly** (January, April, July, October): list
  `authorized_keys` on the box, the repository's admins and collaborators, the
  Cloudflare, mail-provider, JaaS, Anthropic and Google console members, and the
  self-hosted runner's registration. Remove anyone without a current need. Today the
  expected answer everywhere is the maintainer alone. Write the date and the result
  under § 8.

## 6. Backups and the env file belong together

A database dump holds sealed columns as ciphertext under keys derived from the
`NEXTAUTH_SECRET` that wrote them. **A restore with a different secret brings the
rows back and the credentials not**: the § 3.1 consequences, without the planning.
So the env file of each environment is stored, off the box, next to the backups, in
the maintainer's password manager. After a rotation, the **previous** value is kept
for as long as backups taken under it exist (`KEEP_DAYS` plus the off-site retention).

## 7. What we deliberately do not do

| Not done | Why | Revisit when |
|---|---|---|
| No secrets manager (Vault, cloud KMS) | one box, one operator. A manager adds an always-on dependency and a second credential to protect, for no change in who can read the values | a second operator or a second server |
| No HSM, no envelope encryption of the env file | the env file is root-only on a single-tenant host; anyone who can read it can read the process memory too | a certification asks for it |
| No `NEXTAUTH_SECRET_PREVIOUS` overlap, no separate box key | every token and sealed column would have to learn to try two keys. Real code across ~20 call sites, for a rotation we do on suspicion only | before `NEXTAUTH_SECRET` is put on a schedule |
| No just-in-time production access | one person holds it permanently. JIT adds nothing until there is someone to grant it to | as above |

## 8. Review log

| Date | Rotation / review | Result | By |
|---|---|---|---|
| — | inventory written (#1554) | first version | — |
