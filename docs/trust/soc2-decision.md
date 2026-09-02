# SOC 2 Type II — the decision, costed and deferred

> Issue: [#2031](https://github.com/21072026/Internship/issues/2031) · Story:
> [#2025](https://github.com/21072026/Internship/issues/2025)

**Decision: not started. Deliberately.** SOC 2 Type II is money and 6–12 months
of evidence collection, not a sprint — and it cannot be passed honestly while
production, preview, the demo and every per-PR environment share one server
with MySQL, and every deploy runs `prisma db push --accept-data-loss`.

This is a **decision document**: what the audit would cost, which prerequisites
we do not meet, what we say to a buyer in the meantime, and the one condition
that would start it. It is **not** an implementation plan. There is no control
matrix here, no evidence-collection schedule, no auditor shortlist, and no work
items — on purpose. The moment this file grows those, it has become the project
it exists to avoid.

**Decided: 2026-09-02** · **Review: at the next commercial milestone** (a
prospect naming SOC 2 as a condition of signature), **or 2027-03-01**, whichever
comes first.

---

## 1. What is actually being asked for

A prospect asking for "your SOC 2" is asking for an **independent auditor's
report** — not a self-assessment, a checklist or a badge.

| | Type I | Type II |
|---|---|---|
| What it attests | Controls are **designed** appropriately, at a point in time | Controls **operated effectively** over an observation window |
| Window | A single date | Typically **3–12 months** of continuous evidence |
| What a buyer wants | Rarely enough on its own | This one |

The gap between the two is the whole cost: a Type II is an auditor reading
**months of evidence** that your controls ran every day — access reviews
actually performed, changes actually approved, alerts actually triaged,
onboarding and offboarding actually recorded. Evidence cannot be produced
retroactively. That is why this is not an engineering ticket: the clock starts
when the controls start operating, not when someone writes them down.

## 2. What it would cost

Order-of-magnitude planning figures for a product of this size (single
application, one hosting footprint, EU auditor), not quotes:

| Line | Range | Note |
|---|---|---|
| Auditor (Type II, first year) | **€15k–35k** | The report itself |
| Readiness / gap assessment | **€5k–15k** | Usually a different firm from the auditor |
| Compliance automation platform | **€8k–20k / year** | Evidence collection; largely unavoidable at this size, because the alternative is a person doing it by hand |
| Infrastructure changes to make it passable | **€5k–15k** | § 3 — separated environments and real monitoring cost money every month afterwards, not once |
| Internal effort | **~0.3–0.5 FTE for 6–12 months** | The line most cost estimates omit and most projects die on |
| **Total, first year** | **≈ €40k–80k** | Plus a recurring annual audit and the platform subscription |

Two consequences that matter more than the number:

1. **It recurs.** A Type II is annual. A one-off budget does not buy it.
2. **It is not deferrable once begun.** A half-finished SOC 2 programme has all
   the cost and none of the report.

## 3. Prerequisites we do not meet

Each of these would be a finding, and none of them is a documentation task.
This list is the reason the answer is "not yet" rather than "not worth it".

| Prerequisite | Where we are | Tracked |
|---|---|---|
| **Environment separation** | One Plesk box hosts production (`:3200`), preview (`:3201`), every per-PR topic environment (`33xx`) **and** MySQL. Auditable separation of production from development/test is table stakes for the Confidentiality and Availability criteria. | Deployment table in [`CLAUDE.md`](../../CLAUDE.md) |
| **Reviewable, non-destructive schema changes** | Deploys run `prisma db push --accept-data-loss`; there is no migration history an auditor can review, only a guard script and a pre-deploy dump. | [#1515](https://github.com/21072026/Internship/issues/1515) |
| **Monitoring, alerting and error tracking** | No error tracker, no APM, no external uptime monitor. Several Common Criteria (CC7.x — detection and response) have nothing to point at. | [#1591](https://github.com/21072026/Internship/issues/1591) |
| **Formal change management** | Branch + PR + CI gates + branch protection are real, but there is **no mandatory second-person approval** and no change record beyond git — a single maintainer merges their own changes. | § F of [`questionnaire-answers.md`](questionnaire-answers.md) (row: "Is every change reviewed by a second person?") |
| **Access-review cadence** | No periodic review or re-certification of who holds admin access. Also no separation between "runs the deployment" and "runs a tenant" — organisation management still authorises on `role === 'ADMIN'`. | [#1535](https://github.com/21072026/Internship/issues/1535) |
| **Incident response** | No IR runbook, no severity ladder, no on-call, no communication templates. | [#1605](https://github.com/21072026/Internship/issues/1605) |
| **Vendor management** | Subprocessors are known and (being) published, but no DPAs are collected and no vendor-risk review exists. | [#2027](https://github.com/21072026/Internship/issues/2027), [#2025](https://github.com/21072026/Internship/issues/2025) |
| **HR controls** | No background checks, no security-training programme, no formal onboarding/offboarding record. Structurally hard for a project whose contributors are mentees — solvable, but a policy decision first. | [`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md) |
| **Backup controls an auditor accepts** | Backups are taken, verified daily and drilled monthly — genuinely good — but they are **unencrypted and on the same host** as the database. | [`docs/disaster-recovery.md`](../disaster-recovery.md) |

Note what this list is **not** saying. Most of these items are worth doing for
their own sake — monitoring, migrations, incident response and a super-admin
separation all make the product better whether or not an audit ever happens.
They are listed here as *prerequisites*, not as SOC 2 work, and they are
tracked in their own issues where they belong. Nothing on this page asks for
work to be started.

## 4. What we say instead

The answer a prospect gets today, in this order:

1. **A Trust Center you can read**, not a report you have to request: the
   subprocessor register, the security overview and the hosting/residency
   answer. Shipping as the sibling task
   ([#2027](https://github.com/21072026/Internship/issues/2027)) — the four
   documents in items 3–5 below are published already.
2. **A DPA you can sign**, with SCCs where they apply
   ([#2025](https://github.com/21072026/Internship/issues/2025)).
3. **A published disclosure policy with safe harbour and response targets**, and
   a machine-readable security contact
   ([`vulnerability-disclosure.md`](vulnerability-disclosure.md)).
4. **Our security testing, in writing — including the open findings**
   ([`pentest.md`](pentest.md)), plus the cadence commitment for external
   testing.
5. **A pre-filled security questionnaire** where every answer carries an
   evidence path and every "no" says no
   ([`questionnaire-answers.md`](questionnaire-answers.md)).
6. **The entire source under AGPL-3.0-or-later.** Audit it yourself, or have
   your own security team do it — an option no closed-source competitor in this
   segment can offer, and in substance a stronger artefact than a summary of
   someone else's audit.
7. **And plainly: SOC 2 when a signed contract pays for it.** Not "coming
   soon", not "in progress", not "Q3".

That last sentence is the whole posture. Saying "SOC 2 is in progress" when it
is not survives exactly until the buyer asks for the observation window's start
date.

## 5. The trigger condition

SOC 2 work starts when **both** of these are true:

1. **It is funded by a signed commercial agreement** — one contract (or a small
   set) whose value covers the first-year cost in § 2 and whose security
   requirements name SOC 2 as a condition, in writing. Not a prospect's
   expression of interest; a signature.
2. **The prerequisites in § 3 that are pure infrastructure are done** —
   specifically environment separation, reviewable migrations
   ([#1515](https://github.com/21072026/Internship/issues/1515)) and monitoring
   with alerting ([#1591](https://github.com/21072026/Internship/issues/1591)).
   Beginning an observation window before these exist buys a report with
   findings in it.

When the trigger fires, the **first** step is a readiness assessment with a
scope decision (which Trust Services Criteria, which systems) — not evidence
collection, and not this document being turned into a plan.

Two secondary signals worth watching, neither of which is by itself the
trigger: **three or more** qualified deals lost with SOC 2 named as the reason
(that changes the economics), or a single strategic public-sector deal that
mandates it (in which case an external penetration test — cheaper, faster,
often accepted as a substitute — is the move to price first;
[`pentest.md`](pentest.md) § 1).

## 6. Explicitly out of scope of this document

So that nobody reads this page as a green light:

- ❌ No control matrix, no Trust Services Criteria mapping.
- ❌ No evidence collection, no compliance-automation trial, no policy pack.
- ❌ No auditor or readiness-firm outreach, no quotes requested.
- ❌ No SOC 2 claim anywhere in the product, the marketing copy or the trust
  page. The only permitted sentence is the one in § 4.7.
- ❌ No issues filed "for SOC 2". The prerequisites in § 3 already have issues,
  justified on their own merits.

---

## 🇹🇷 Özet

**Karar: başlanmadı — bilinçli olarak.** SOC 2 Type II bir mühendislik işi
değil; para ve 6–12 ay kesintisiz kanıt toplama demek. Üstelik prod, preview,
demo ve her PR ortamı MySQL ile aynı kutuyu paylaşırken ve her deploy
`prisma db push --accept-data-loss` ile çalışırken bu denetim **dürüstçe
geçilemez**. İlk yıl maliyeti kabaca **€40–80k** (denetçi €15–35k, hazırlık
€5–15k, kanıt otomasyon platformu yıllık €8–20k, altyapı €5–15k, artı 6–12 ay
boyunca 0,3–0,5 FTE) ve **her yıl tekrarlıyor**. Karşılamadığımız ön koşullar
adıyla yazılı: ortam ayrımı, gözden geçirilebilir şema göçleri
([#1515](https://github.com/21072026/Internship/issues/1515)), izleme ve
uyarı ([#1591](https://github.com/21072026/Internship/issues/1591)), resmî
değişiklik yönetimi, erişim gözden geçirme periyodu, olay müdahalesi
([#1605](https://github.com/21072026/Internship/issues/1605)). O zamana kadar
söylediğimiz cümle net: "Trust Center, alt-işleyenler, DPA, yıllık sızma testi,
kendiniz denetleyebileceğiniz AGPL kaynak kodu — SOC 2, imzalı bir sözleşme onu
finanse ettiğinde." Tetikleyici de yazılı: maliyeti karşılayan **imzalı** bir
sözleşme **ve** altyapı ön koşullarının tamamlanmış olması. Bu doküman bir
uygulama planı değildir ve olmayacaktır (§ 6).
