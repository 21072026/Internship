# Incident response (#1605)

What happens when the product is down or broken: how bad it is, who answers, how fast, who
tells customers, and what gets written afterwards. Data loss is one incident class — its
recovery runbook is [`docs/disaster-recovery.md`](disaster-recovery.md). The published targets
are in [`docs/sla.md`](sla.md); the public face is `/status`.

Written for the team this project actually has: one maintainer and AI agents on a single host.
It promises nothing a fictional 24/7 operations centre would.

## 1. Severity ladder

Classify by the first line that is true. When unsure, take the higher severity and lower it later.

| Sev | Test | Examples |
|---|---|---|
| **S1** | Nobody can use the product, **or** personal data is exposed / lost | site down, database down, a tenant sees another tenant's data, a leaked credential |
| **S2** | One core flow is broken for a whole role: sign-in, messaging, the pipeline, mail delivery | mentors cannot log interactions; no mail leaves for an hour |
| **S3** | A feature is degraded or broken with a workaround | one report errors, a calendar sync lags, a slow page |
| **S4** | Cosmetic | a misaligned button, a typo, a wrong colour in dark mode |

## 2. Targets

Same table as `docs/sla.md` — change both together.

| Sev | First response | Update cadence | Resolution / workaround |
|---|---|---|---|
| S1 | 1 h, any time | every 2 h | 8 h |
| S2 | 4 business hours | daily | 2 business days |
| S3 | 1 business day | on change | next release |
| S4 | 3 business days | — | backlog |

## 3. Detection and paging

| Signal | Where it comes from | Reaches a human through |
|---|---|---|
| Site or production database not answering | `.github/workflows/uptime.yml` (GitHub-hosted, every ~5 min, two failures 30 s apart; readiness asserts `db: "ok"` when the `HEALTH_TOKEN` secret is set) | an `uptime-alert` issue (GitHub notification), a best-effort mail, and after 30 min unacknowledged an @-mention of `UPTIME_ESCALATE_TO` |
| MySQL down and staying down | `.github/workflows/mysql-watchdog.yml` | a `ci-alert` issue |
| Application errors | the error tracker (#1600, `ERROR_TRACKING_DSN`) | the tracker's own alert rules |
| Jobs dead-lettering | the daily dead-letter digest (`jobs.deadLetterAlert`) | mail |
| A person tells us | support inbox, in-app bug report | the admin inbox |

None of the paging channels depends on the monitored host: GitHub's notifications are the
primary path. Mail from a GitHub-hosted runner is best effort (SMTP is often unreachable from
there, #2322), and the app's own mail cannot be relied on while the app is down.

## 4. On-call

- **Primary:** the maintainer (the repository owner). There is no rotation yet; a second person
  is added here by name when one exists, with handover dates.
- **Acknowledge** an outage by adding the **`acknowledged`** label to its `uptime-alert` issue.
  That stops the escalation; it does not close the issue — the monitor closes it on recovery.
- **Escalation:** still down 30 min after the issue opened and not acknowledged → the monitor
  @-mentions the logins in the repository variable `UPTIME_ESCALATE_TO` once. With nobody else
  on the list, set it to the primary's own login: a second, louder notification is the point.
- **Handover:** a comment on the open incident issue ("handing over to …, state: …").

## 5. The loop

| Step | What | Who |
|---|---|---|
| Detect | a signal from § 3 | automation / reporter |
| Acknowledge | `acknowledged` label, or a comment on the issue | on-call |
| Classify | § 1; write the severity in the issue | on-call |
| Mitigate | stop the bleeding first: roll back (`deploy-prod.yml`, `FORCE=1` with a sha), restart, disable the feature | on-call |
| Communicate | § 6 templates; S1/S2 also on `/status` (`src/lib/statusIncidents.ts`) | on-call |
| Resolve | the fix, merged and deployed; the monitor closes its issue | on-call |
| Postmortem | § 7, for every S1 and S2 | on-call |

## 6. Customer communication

Post on `/status` (an entry in `src/lib/statusIncidents.ts`, all three languages) for S1/S2.
Mail affected organisations' admins for S1, and for S2 when the role is theirs. Never name
another customer, never guess a cause in the first notice, always give the next update time.

**First notice — EN**
> **[S1/S2] {short title}** — Since {time UTC} {what users see}. We are investigating and will
> post the next update by {time UTC} on {status URL}.

**First notice — TR**
> **[S1/S2] {kısa başlık}** — {saat UTC} itibarıyla {kullanıcıların gördüğü}. İnceliyoruz; bir
> sonraki güncellemeyi en geç {saat UTC}'de {durum sayfası} üzerinde paylaşacağız.

**Update — EN** / **TR**
> {What we know now}. {What we are doing}. Next update by {time UTC}.
>
> {Şu an bildiklerimiz}. {Yaptıklarımız}. Bir sonraki güncelleme en geç {saat UTC}.

**Resolved — EN** / **TR**
> Resolved at {time UTC}. {One sentence on the cause}. {Whether any data or action is needed from
> you}. A postmortem follows within five working days.
>
> {saat UTC}'de giderildi. {Nedene dair tek cümle}. {Sizin tarafınızda veri/işlem gerekip
> gerekmediği}. Beş iş günü içinde olay sonrası değerlendirmeyi paylaşacağız.

A data exposure (S1) is also a GDPR question: the 72-hour authority notification clock in
Art. 33 starts when we become aware — see `docs/pii-access-lifecycle.md` and decide it
explicitly in the incident issue, not afterwards.

## 7. Postmortem

Blameless: it asks what made the failure possible and slow to see, never who. Due **within five
working days** for S1 and S2; S3 optional. Put it in `docs/postmortems/YYYY-MM-DD-<slug>.md` and
link it from the incident issue and the `/status` entry. Template:

```markdown
# YYYY-MM-DD — <title> (S1|S2)

## Summary
Two sentences: what users saw, for how long.

## Impact
Roles and roughly how many organisations; data affected (yes/no, which).

## Timeline (UTC)
| Time | Event |
|---|---|
| hh:mm | first symptom |
| hh:mm | detected — by what |
| hh:mm | acknowledged |
| hh:mm | mitigated |
| hh:mm | resolved |

## Contributing factors
What made it possible. Several, usually.

## What made detection slow
The gap between first symptom and the first page, and why.

## What went well

## Action items
| Item | Owner | Issue |
|---|---|---|
```

## 8. Drills

A 30-minute tabletop every six months: pick a scenario ("production returns 502 at 03:00",
"a tenant reports seeing another tenant's candidate"), walk the loop above against the current
docs, and fix whatever step could not be done as written. Log each drill below, like the
restore drills in `docs/disaster-recovery.md`.

| Date | Scenario | What changed afterwards |
|---|---|---|
| — | first drill not yet run | — |
