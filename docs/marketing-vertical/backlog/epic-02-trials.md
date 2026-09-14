# Epic 2 — Never lose a trial

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **Urgent** · Effort **Medium**

**DE:** Keine Testphase darf unbemerkt auslaufen.
**TR:** Hiçbir deneme süresi fark edilmeden bitmesin.

SaleVali trials run 30 days and **never auto-renew** — there is no automatic
conversion to a paid contract. A trial that expires while nobody is looking is
a customer lost in silence, and the merchant never hears from us again.

Today the dashboard shows a 7-day warning panel. That only helps someone who
opens the dashboard. This epic makes the CRM reach out instead of waiting.

---

## Story 2.1 — Scheduled job infrastructure

`Feature` · Priority **Urgent** · Effort **Medium**

**DE:** Grundlage für wiederkehrende Jobs — sicher aufrufbar, ohne Altlasten zu verschicken.
**TR:** Tekrarlayan işler için altyapı — güvenli tetiklenebilir, geçmişi mail'lemeyen.

---

### T-2.1.1 — Add a `Setting` key/value model

`Task` · Priority **Urgent** · Effort **Low** · `good first issue`

**DE:** Ein einfaches Setting-Modell für Job-Zustände anlegen.
**TR:** İş durumlarını tutmak için basit bir Setting modeli ekle.

**Done when**
- `Setting { key String @id, value String @db.Text, updatedAt }` exists in
  `prisma/schema.prisma`.
- `getSetting(key)` and `setSetting(key, value)` live in `src/lib/settings.ts`.
- The change is additive, so the schema guard has nothing to complain about.

**Prompt**

> Add a `Setting` model to the SaleVali Marketing CRM: `key` as the primary key
> (String), `value` as `@db.Text`, plus `updatedAt`. It is the store for small
> pieces of job state — "when did the reminder job last run", "what is the
> baseline" — that do not belong on a domain model.
>
> Add `src/lib/settings.ts` with `getSetting(key): Promise<string | null>` and
> `setSetting(key, value)` using upsert. Run `npx prisma db push` locally and
> confirm the change is purely additive — this project has no migrations
> folder, so a destructive diff would stop the production deploy
> (`infra/schema-guard.sh`).

---

### T-2.1.2 — Authenticated cron endpoint

`Task` · Priority **Urgent** · Effort **Medium**

**DE:** Ein durch ein Shared Secret geschützter Endpunkt, der geplante Jobs auslöst.
**TR:** Paylaşılan bir sır ile korunan, zamanlanmış işleri tetikleyen endpoint.

**Done when**
- `POST /api/cron/[job]` runs a named job and returns what it did.
- It requires `CRON_SECRET` via a header, compared with `timingSafeEqual`, and
  answers `401` otherwise.
- When `CRON_SECRET` is unset the endpoint refuses **everything** — unlike
  `HEALTH_TOKEN`, there is no pipeline that would be blinded by failing closed.
- An e2e spec asserts the `401`.

**Prompt**

> Add `POST /api/cron/[job]` to the SaleVali Marketing CRM: the entry point a
> systemd timer or GitHub schedule calls to run background jobs.
>
> Authenticate with a `CRON_SECRET` env var sent as an `X-Cron-Secret` header,
> compared using `timingSafeEqual` — copy the shape from
> `src/lib/health.ts`, but invert the default: if `CRON_SECRET` is unset the
> endpoint must refuse everything. `HEALTH_TOKEN` defaults open because the
> deploy gate reads it; nothing depends on cron being reachable, so failing
> closed is free here. Explain that difference in a comment.
>
> Keep a registry of jobs (`Record<string, () => Promise<JobResult>>`) and
> return `404` for an unknown name and a JSON summary of what the job did for a
> known one. Add the secret to `.env.example` and to the env list in
> `infra/README.md`. Add an e2e spec asserting an unauthenticated call gets
> `401` and that no job runs.

---

### T-2.1.3 — Document how the job actually gets called

`Task` · Priority **High** · Effort **Low** · `documentation`

**DE:** Dokumentieren, wie der Job auf dem Server regelmäßig ausgelöst wird.
**TR:** İşin sunucuda düzenli olarak nasıl tetikleneceğini dokümante et.

**Done when**
- `infra/README.md` has a systemd timer unit (or cron line) that calls the
  endpoint, with the secret read from the env file.
- It says what happens if the call fails, and how to see that it did.

**Prompt**

> Document the scheduled-job trigger in `infra/README.md` for the SaleVali
> Marketing CRM. Give a copy-pasteable systemd service + timer pair that
> `curl`s `POST /api/cron/trial-reminders` daily with the `X-Cron-Secret`
> header, reading `CRON_SECRET` from `/etc/salevali-crm/prod.env`.
>
> Cover the failure case honestly: the timer is fire-and-forget, so say how an
> operator checks it ran (`systemctl list-timers`, `journalctl -u`) and note
> that a silently failing timer means silently unsent reminders. Mention the
> GitHub-schedule alternative for anyone not on systemd.

---

### T-2.1.4 — Baseline guard so the first run does not email history

`Task` · Priority **Urgent** · Effort **Medium**

**DE:** Beim ersten Lauf keine Rückstände verschicken, sondern nur den Startpunkt setzen.
**TR:** İlk çalıştırmada birikmiş geçmişi mail'leme, sadece başlangıç noktasını yaz.

**Done when**
- On its first run the job records a baseline timestamp and sends nothing.
- Subsequent runs only consider trials that crossed a threshold after the
  baseline.
- The behaviour is covered by a test, because it can only go wrong once — very
  publicly.

**Prompt**

> Add a baseline guard to the scheduled-job infrastructure of the SaleVali
> Marketing CRM, before any reminders can be sent.
>
> The first time a job runs there may be months of trials that already expired.
> Emailing all of them would be an embarrassing burst of irrelevant mail to the
> whole team. So: on first run, write `Setting['cron:<job>:baselineAt'] = now`,
> report `baselined, sent 0`, and send nothing. On later runs, only act on
> records whose trigger date is after the baseline.
>
> This is a one-shot behaviour that can only be observed once in production, so
> cover it with a test that seeds three expired trials, runs the job twice, and
> asserts zero sends on the first run.

---

## Story 2.2 — Trial reminder emails

`Feature` · Priority **Urgent** · Effort **Medium**

**DE:** Erinnerungen an die zuständige Person, bevor eine Testphase endet.
**TR:** Deneme bitmeden önce sorumlu kişiye hatırlatma.

---

### T-2.2.1 — Reminder email template

`Task` · Priority **Urgent** · Effort **Low** · `good first issue`

**DE:** E-Mail-Vorlage für Erinnerungen an auslaufende Testphasen.
**TR:** Biten deneme hatırlatması için e-posta şablonu.

**Done when**
- `sendTrialReminderEmail()` in `src/lib/mailer.ts` takes the customer, the
  days remaining and the recipient.
- The body names the company, when the trial ends, the channels they run, and
  links straight to the customer record.
- It reads sensibly at T-7, T-3 and T-0 without three separate templates.

**Prompt**

> Add `sendTrialReminderEmail()` to `src/lib/mailer.ts` in the SaleVali
> Marketing CRM, following the shape of the existing `sendInvitationEmail()`.
>
> It takes the customer (company name, trial end date, connected channels, id)
> the number of days remaining, and the recipient address. One template that
> reads correctly for 7 days, 3 days and "ends today" — vary the subject line,
> not the whole body. Include a direct link to
> `${NEXTAUTH_URL}/dashboard/customers/${id}` so the reader is one click from
> acting, and state plainly that the trial will not renew by itself.
>
> Plain text and HTML, like the invitation mail. Do not send anything from this
> task — just the function.

---

### T-2.2.2 — Find the trials that need a reminder

`Task` · Priority **Urgent** · Effort **Medium**

**DE:** Abfrage für Testphasen, die in 7 / 3 / 0 Tagen enden.
**TR:** 7 / 3 / 0 gün içinde bitecek denemeleri bulan sorgu.

**Done when**
- `trialsDueForReminder(now)` in `src/lib/trials.ts` returns customers at
  `TRIAL_ACTIVE_500` whose `trialEndsAt` falls on today + 7, +3 or +0.
- Day comparison is by calendar day, not by exact timestamp — a job that runs
  at 06:00 must not miss a trial ending at 05:00.
- Unit-tested against fixed dates rather than "now".

**Prompt**

> Add `src/lib/trials.ts` to the SaleVali Marketing CRM with
> `trialsDueForReminder(now: Date)`, returning the customers that should get a
> reminder today, each tagged with which threshold it hit (7, 3 or 0 days).
>
> Only `TRIAL_ACTIVE_500` customers with a `trialEndsAt` count. Compare by
> **calendar day**, not by timestamp: the job runs at a fixed hour and a
> reminder must not be missed because the trial ends a few hours earlier that
> same day. Take `now` as an argument rather than calling `new Date()` inside,
> so it is testable.
>
> Cover it with fixed dates: a trial ending in exactly 7 days, one in 5 (no
> reminder), one ending today, one already expired (no reminder), and one at
> `CUSTOMER_ACTIVE_700` with a past trial end (no reminder).

---

### T-2.2.3 — Record what was sent, so nothing is sent twice

`Task` · Priority **Urgent** · Effort **Medium**

**DE:** Versendete Erinnerungen festhalten, um Doppelversand zu verhindern.
**TR:** Gönderilen hatırlatmaları kaydet, aynısı iki kez gitmesin.

**Done when**
- A `TrialReminder { customerId, threshold, sentAt }` row is written per send,
  unique on `[customerId, threshold]`.
- Running the job twice on the same day sends each reminder once.
- A failed send is not recorded, so the next run retries it.

**Prompt**

> Add duplicate protection to the trial reminders in the SaleVali Marketing
> CRM. A timer that fires twice, or a retried deploy, must not mail the same
> person about the same trial twice.
>
> Add a `TrialReminder` model — `customerId`, `threshold` (7 | 3 | 0), `sentAt`
> — unique on `[customerId, threshold]`, cascading from `Customer`. Check it
> before sending and write it after a successful send.
>
> Order matters: write the row **after** the send succeeds, not before. A
> reminder that failed to send must be retried on the next run, and a crash
> between send and write is the lesser evil (one duplicate) compared with a
> silent never-sent reminder. Note that reasoning in a comment.

---

### T-2.2.4 — Wire it together as the `trial-reminders` job

`Task` · Priority **Urgent** · Effort **Medium**

**DE:** Die Teile zu einem Job zusammensetzen und an die zuständige Person schicken.
**TR:** Parçaları tek bir işte birleştir ve sorumlu kişiye gönder.

**Done when**
- `POST /api/cron/trial-reminders` finds due trials, sends, records, and
  returns `{ considered, sent, skipped, failed }`.
- Mail goes to `assignedTo`; unassigned customers go to all `ADMIN` users so
  they cannot fall through the gap.
- One failed send does not abort the rest of the run.

**Prompt**

> Implement the `trial-reminders` job in the SaleVali Marketing CRM, wiring
> together `trialsDueForReminder()`, `sendTrialReminderEmail()` and the
> `TrialReminder` de-duplication, behind `POST /api/cron/trial-reminders`.
>
> Recipient: the customer's `assignedTo` marketer. If there is none, send to
> every `ADMIN` — an unassigned trial is exactly the one most likely to be
> forgotten, so it must not be the one that gets no mail.
>
> Wrap each send in its own try/catch: one bad address must not abort the rest
> of the run. Return `{ considered, sent, skipped, failed }` and log the
> failures with the customer id. Respect the baseline guard from T-2.1.4.

---

### T-2.2.5 — End-to-end test for the reminder job

`Task` · Priority **High** · Effort **Medium**

**DE:** E2E-Test: der Job verschickt einmal und danach nicht erneut.
**TR:** E2E test: iş bir kez gönderiyor, sonra tekrar göndermiyor.

**Done when**
- A spec seeds a trial ending in 7 days, calls the endpoint twice, and asserts
  one `TrialReminder` row.
- SMTP is not actually contacted; the send is stubbed or pointed at a sink.
- The unauthenticated call is asserted to be `401`.

**Prompt**

> Add `e2e/trial-reminders.spec.ts` to the SaleVali Marketing CRM.
>
> Seed a customer at `TRIAL_ACTIVE_500` whose trial ends in exactly 7 days
> (use `e2e/helpers/db.ts` and a unique company prefix, and clean up in
> `afterAll`). Call `POST /api/cron/trial-reminders` twice with the cron secret
> and assert: the first call reports one send, the second reports zero, and
> exactly one `TrialReminder` row exists. Also assert an unauthenticated call
> gets `401`.
>
> CI has no SMTP, so the send must not depend on a real server — either allow
> the job to treat a send failure as "not sent" and assert on that path, or add
> a `MAIL_TRANSPORT=stub` mode used only by tests. Say in a comment which you
> chose and why. Read `docs/testing.md` first.

---

## Story 2.3 — Move expired trials out of the way

`Feature` · Priority **High** · Effort **Medium**

**DE:** Abgelaufene Testphasen automatisch in die richtige Stufe bewegen.
**TR:** Süresi dolan denemeleri otomatik olarak doğru aşamaya taşı.

---

### T-2.3.1 — Auto-advance `TRIAL_ACTIVE` past its end date

`Task` · Priority **High** · Effort **Medium**

**DE:** Nach Ablauf automatisch auf `TRIAL_EXPIRED_600` setzen, mit Audit-Eintrag.
**TR:** Süre dolunca otomatik `TRIAL_EXPIRED_600`'e al ve audit kaydı yaz.

**Done when**
- A daily job moves customers whose `trialEndsAt` has passed from
  `TRIAL_ACTIVE_500` to `TRIAL_EXPIRED_600`.
- The move goes through `lifecycleTimestampsFor()` and writes a `StageChange`
  with a note saying it was automatic.
- Customers already moved on by a human are left alone.

**Prompt**

> Add an `expire-trials` job to the SaleVali Marketing CRM: customers still at
> `TRIAL_ACTIVE_500` whose `trialEndsAt` is in the past move to
> `TRIAL_EXPIRED_600`.
>
> Route it through `lifecycleTimestampsFor()` and write a `StageChange` with
> `note: "Trial period ended (automatic)"` — the audit trail is what the funnel
> reporting reads, and an automatic move that skips it would quietly corrupt
> time-in-stage. `CLAUDE.md` covers this rule.
>
> Only touch customers still at `TRIAL_ACTIVE_500`: anyone a human already
> moved to paying, lost or churned must be left exactly as they are. Return
> `{ moved }` and register the job in the cron registry.

---

### T-2.3.2 — Dashboard card for expired trials awaiting a decision

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Dashboard-Karte für abgelaufene Testphasen ohne Entscheidung.
**TR:** Karar verilmemiş, süresi dolmuş denemeler için dashboard kartı.

**Done when**
- The dashboard lists customers at `TRIAL_EXPIRED_600`, oldest first.
- Each row links to the customer and shows how many days ago the trial ended.
- The card hides itself when the list is empty, rather than showing a zero.

**Prompt**

> Add a "Trials awaiting a decision" card to `/dashboard` in the SaleVali
> Marketing CRM, next to the existing "Trials ending within 7 days" panel.
>
> List customers at `TRIAL_EXPIRED_600` ordered by `trialEndsAt` ascending
> (longest waiting first), capped at 8, each linking to its record and showing
> "ended N days ago" via `daysUntil()` from `src/lib/lifecycle.ts`. Match the
> existing panel's markup and colours. Render nothing at all when the list is
> empty — an empty card is noise, and this dashboard is meant to be scanned.
>
> Extend `e2e/customers-list.spec.ts` with a case seeding an expired trial and
> asserting it appears.
