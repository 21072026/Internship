# Data lifecycle — what we keep, for how long, and how it ends

Customer-facing summary of retention, export, erasure and offboarding, written
from the code. Every period below names the constant or retention-registry key
that enforces it, so it can be checked. Where nothing deletes data by age, this
page says **not yet enforced** rather than implying a limit. Issue #2029.

Related: [DPA template](../legal/dpa-template.md) ·
[transfer annex](../legal/dpa-annex-sccs.md) ·
[record of processing](../legal/ropa.md) ·
[DPIA starter](../legal/dpia-starter.md) ·
[subprocessors](subprocessors.md) · [security overview](security-overview.md).

## 1. What we keep, and for how long

A nightly job runs one registry of retention rules (`BUILT_IN_RETENTION_ENTRIES`,
`src/lib/retentionEntries.ts`) and writes a `retention.pruned` record of what it
removed. Where a rule has a setting, the default comes from `SETTING_DEFAULTS`
(`src/lib/settings.ts`) and the operator or organisation can change it.

| Data | Kept for | Enforced by |
|---|---|---|
| Account and profile | While the account is active | — (ends with erasure, § 3) |
| Re-consent review of a candidate | Asked after `retentionMonths` (default **12 months**); flagged for an admin to erase **30 days** later; never deleted automatically | `SETTING_DEFAULTS.retentionMonths`, `RETENTION_GRACE_DAYS` (`src/lib/retention.ts`) |
| Declined applicant account with no sign of life | Anonymised after **90 days** | `orphanApplicant` (`ORPHAN_APPLICANT_GRACE_DAYS`, setting `orphanApplicantGraceDays`) |
| Mentor's / company's access to a mentee's CV and documents | Ends **6 months** after the mentorship completes | `POST_MENTORSHIP_ACCESS_MONTHS` (`src/lib/retention.ts`) |
| Interaction logs, goals, evaluations, meetings, applications, offers, fit scores | **Not yet enforced** — kept with the record; free text removed on erasure | — |
| Messages | Per organisation; default **kept** (`messageRetentionDays` = 0). When set, bodies are masked (minimum 30 days) | `message` (`messageRetentionDays`, `MESSAGE_RETENTION_FLOOR_DAYS`) |
| In-app notifications (read) | **180 days**; unread never; nothing younger than 30 days | `notification` (`notificationRetentionDays`, `NOTIFICATION_RETENTION_FLOOR_DAYS`) |
| Page-view history (only with activity-tracking consent) | **180 days** | `pageView` (`pageViewRetentionDays`) |
| Browser push subscription unused, owner inactive | **180 days** | `pushSubscription` (`pushSubscriptionStaleDays`) |
| E-mail delivery log | **90 days** | `emailLog` (`EMAIL_LOG_RETENTION_DAYS`) |
| Mail queue rows | **7 days**; failed **30 days** | `mailOutbox` (`MAIL_DEAD_RETENTION_DAYS`) |
| Held mail drafts (after a decision) | **30 days** | `outboundDraft` (`OUTBOUND_DRAFT_RETENTION_DAYS`) |
| Bounce / complaint events | **30 days** | `emailDeliveryEvent` (`DELIVERY_EVENT_RETENTION_DAYS`) |
| AI-generated text about a person | The organisation's `retentionMonths` (default **12 months**), or until the person is erased; prompts are never stored | `sweepAiArtifacts()` (`src/lib/ai/artifacts.ts`) |
| Company enquiries and demo requests | **730 days**; never-converted ones deleted, converted ones stripped of personal fields | `companyInquiry` (`companyInquiryRetentionDays`) |
| In-app bug reports (screenshot, replay included) | **90 days** | `supportReport` (`supportReportRetentionDays`) |
| Roster-feed per-person results; chat deliveries | **90 days** | `rosterRowResult`, `chatDelivery` |
| Security ledger (`ActivityLog`) | **365 days**; records of an exercised right (unsubscribe, export, deletion) kept with IP and user-agent removed | `activityLog` (`activityLogRetentionDays`, `RETAINED_ACTIVITY_ACTIONS`) |
| Privileged-action audit trail (`AuditLog`) | **730 days**, never under 365 | `auditLog` (`AUDIT_RETENTION_DEFAULT_DAYS`, `AUDIT_RETENTION_FLOOR_DAYS`) |
| Background jobs; domain events; automation runs | **30**; **90**; **90 days** | `job` (`jobRetentionDays`); `domainEvent` (`DOMAIN_EVENT_RETENTION_DAYS`); `automationRun` (`AUTOMATION_RUN_RETENTION_DAYS`) |
| Backups | Local dumps `KEEP_DAYS` (default **7 days**); encrypted off-site snapshots up to **12 monthly** | `docs/disaster-recovery.md` |

## 2. Exporting your own data

Any signed-in person can download their data as JSON from their account
(`GET /api/account/export`, `src/app/api/account/export/route.ts`). The file
contains the profile (name, contact details, education, skills, CV link,
consent date), every mentorship as mentee or mentor with the company name,
interaction logs, meetings and RSVPs, and notifications rendered as text. Each
export is recorded (`account.export`). Messages, uploaded files and application
records are not in this file today; they are part of the organisation export
(§ 4) and are provided on request.

## 3. Deleting an account

- **By the person:** Account settings → delete, with the current password
  (`DELETE /api/account`). This is a **hard delete** (`hardDeleteUser()`). The
  public page `/delete-account` describes the same path.
- **By an administrator:** `POST /api/admin/users/[id]/erase`, with the admin's
  own password and the person's name typed to confirm, never while impersonating.
  Two modes: **anonymise** (candidates only — the row stays for programme
  statistics, every personal field and uploaded file goes) or **delete**.

Both modes run one module, `src/lib/accountErasure.ts`: text the person wrote is
emptied in place (so the other side of a conversation keeps its shape), text
written about them is cleared, and their delivery log, newsletter history,
queued mail and held drafts are removed.

**What erasure deliberately keeps:**

- **The audit trail** (`ActivityLog`, `AuditLog`) — a ledger erasure rewrote could
  not answer "who did what" (Art. 17(3)(b)/(e)). It ages out on the windows in § 1.
- **Contact-permission proof** (`ContactPermission`) of an erased person — kept
  only to answer a claim that a mail went out without permission, then deleted
  **3 years after the end of the calendar year of the erasure**
  (`contactPermissionProof`, `CONTACT_PROOF_RETENTION_YEARS`,
  `src/lib/erasureRetentionRule.ts`).
- **Affiliate payout details** (IBAN, account holder) of an erased partner — kept
  for bookkeeping duties and cleared **10 years after the end of the calendar
  year in which the relationship ended** (the latest of erasure, termination and
  last payout; `affiliatePayoutDetails`, `PAYOUT_DETAILS_RETENTION_YEARS`).
- **The suppression list** — removing it would let a bounced or complaining
  address receive mail again.
- **A name quoted in other users' own notes** (for example a mentor's
  free-standing note) cannot be found reliably by any key; it is outside the
  automatic scope and **reviewed on request**, as the privacy notice says
  (`privacy.erasureScope`).

## 4. Organisation export and offboarding

Full mechanics: [`../tenant-lifecycle.md`](../tenant-lifecycle.md).

- **Export** — `GET /api/admin/organizations/[id]/export`, available to the
  organisation's own ORG_ADMIN at any time. One JSON document
  (`interncrm.tenant-export/1`) with every row of the organisation, walked from
  the schema so a new table is included automatically. Credentials (password
  hashes, 2FA secrets, tokens, signing secrets) are excluded and listed in the
  file's `_meta`.
- **Archive** — `POST /api/admin/organizations/[id]/archive` (operator). Nothing
  is destroyed: every sign-in is refused, sessions end, no mail is sent. Reversible.
- **Hard delete** — two stages (`POST /api/admin/organizations/[id]/deletion`,
  then `DELETE /api/admin/organizations/[id]`), only for an archived
  organisation, only after a full export taken after the request, only after a
  waiting period (`TENANT_HARD_DELETE_WAIT_HOURS`, default 72 h), with the
  operator's password, in one transaction. It is **switched off unless the
  deployment sets `TENANT_HARD_DELETE_ENABLED`**, which nothing in this
  repository sets. Kept afterwards: one `org.deleted` record in the operator's
  own organisation, and backups until they rotate out.

## 5. Our commitment on contract termination

When a customer contract ends:

1. the customer can take the full organisation export (§ 4), before and for a
   period after the end date agreed in the contract;
2. the operator archives the organisation, so no one signs in and no mail goes out;
3. after that period the operator permanently deletes the organisation with the
   hard delete (enabling it for that deployment) or an equivalent deletion, and
   confirms it in writing on request;
4. backups age out on their own rotation and are not restored except for
   disaster recovery; records the operator must keep by law are those listed in § 3.

The exact periods are set in the customer's DPA
([template § 10](../legal/dpa-template.md#10-deletion-or-return-on-termination)).
