# Data Processing Agreement (GDPR Art. 28) — template

> **This is a template, not an executed agreement and not legal advice.** It
> describes what the software and its operator actually do, so that counsel can
> turn it into a contract. It **must be reviewed by counsel before anyone signs
> it.** Text in `[square brackets]` is a placeholder or a choice to be made per
> contract. Issue #2029.

Companion documents:

| Annex | Content | Where |
|---|---|---|
| Annex I | Description of the processing (parties, data subjects, categories, purposes) | § 2–3 below, detailed in [`ropa.md`](ropa.md) |
| Annex II | Technical and organisational measures | [`../trust/security-overview.md`](../trust/security-overview.md) |
| Annex III | Authorised subprocessors | [`../trust/subprocessors.md`](../trust/subprocessors.md) |
| Annex IV | International transfers | [`dpa-annex-sccs.md`](dpa-annex-sccs.md) |
| — | Retention and deletion | [`../trust/data-lifecycle.md`](../trust/data-lifecycle.md) |
| — | DPIA starter for the controller | [`dpia-starter.md`](dpia-starter.md) |

---

## Parties

- **[Controller]** — the customer organisation that runs a programme (internship,
  mentoring, hiring or the marketing product) on the platform, represented by
  `[name, address, contact]`.
- **[Processor / operator]** — the party operating the hosted deployment of the
  software, represented by `[name, address, contact]`. The operator's published
  identity is the one shown on the deployment's `/imprint` page.

Where the Controller self-hosts the AGPL source on its own infrastructure, there
is no processor relationship for the hosting, and this template does not apply to it.

## 1. Subject matter and duration

1.1 The Processor processes personal data on behalf of the Controller in order to
provide the hosted platform described in `[Main Agreement / Order Form, date]`
(the "Main Agreement").

1.2 This Agreement runs for as long as the Processor processes personal data for
the Controller under the Main Agreement, and ends when the deletion or return
under § 10 is complete.

## 2. Nature and purpose of the processing

2.1 Nature: storage, organisation, retrieval, display, transmission (e-mail,
in-app messages, push), structuring and erasure of personal data in a multi-tenant
web application. The Controller's data is held in its own organisation (`orgId`)
and isolated from other tenants (`docs/tenant-isolation.md`).

2.2 Purposes — only those the Controller enables, and only as set out per purpose
in [`ropa.md`](ropa.md):

- accounts and registration of the Controller's participants and staff;
- mentor ↔ mentee matching and relation management;
- interaction logging, goals, evaluations and weekly reports;
- messaging and notifications;
- meetings and video calls;
- the hiring pipeline (requisitions, applications, interviews, offers);
- transactional e-mail and newsletters;
- optional AI-assisted features (consent-gated where they concern a participant);
- company enquiries and contact permission (marketing product);
- an affiliate programme with payouts (marketing product);
- in-app bug reports; security and audit logging.

2.3 Analytics on the operator's public marketing pages, the operator's own sales
enquiries and the operator's own accounts are **not** processing on behalf of the
Controller; the operator is controller for those.

## 3. Categories of data subjects and of personal data

3.1 Data subjects: `[select]` participants (mentees / candidates / applicants,
who may include minors where the Controller's programme admits them), mentors,
the Controller's administrators and staff, company contacts and their
interviewers, leads and customers (marketing product), affiliate partners,
enquiry senders.

3.2 Categories of personal data: identity and contact data (name, e-mail, phone,
city); profile and education data (university, department, graduation year,
skills, CV and uploaded documents); programme data (pipeline stage, interaction
logs, notes, goals, evaluations, meetings); communication content (messages,
support conversations); hiring data (applications, interview feedback, offers
including compensation); payout details of affiliate partners (IBAN, account
holder, stored encrypted); technical data (IP address and user-agent in security
logs, push endpoints, session and device records).

3.3 Special categories (Art. 9): the platform does not ask for them and has no
field for them (`docs/legal/equal-opportunity-data.md`: demographic data is not
collected). Free-text fields may nevertheless receive them if a user types them;
the Controller decides whether its programme permits that.

## 4. Instructions of the Controller

4.1 The Processor processes personal data only on documented instructions of the
Controller, including with regard to transfers to third countries, unless EU or
Member State law requires otherwise; in that case the Processor informs the
Controller before processing unless that law prohibits it.

4.2 The Main Agreement, this Agreement and the Controller's configuration of the
platform (organisation settings such as retention windows, AI switches,
2FA policy, message retention) are the Controller's documented instructions.
Further instructions are given in writing to `[contact]`.

4.3 The Processor informs the Controller without delay if, in its opinion, an
instruction infringes the GDPR or other data protection law.

## 5. Confidentiality

5.1 The Processor ensures that persons authorised to process the personal data
have committed themselves to confidentiality or are under a statutory obligation
of confidentiality.

5.2 Development and testing use synthetic data only; contributors do not access
real or preview personal data (`docs/DATA_ACCESS_POLICY.md`).

## 6. Security of processing (Annex II)

6.1 The Processor implements the technical and organisational measures described
in [`../trust/security-overview.md`](../trust/security-overview.md) (Annex II),
including the known limitations stated there. They are not restated here so that
there is one description to keep current.

6.2 The Processor may update the measures, provided that the overall level of
protection is not reduced. Material changes are reflected in Annex II.

## 7. Subprocessors (Annex III)

7.1 The Controller gives **general written authorisation** for the subprocessors
listed in [`../trust/subprocessors.md`](../trust/subprocessors.md) (Annex III),
as far as the corresponding integration is enabled for the Controller's
deployment. Rows marked *optional* are inactive until configured.

7.2 The Processor informs the Controller of any intended addition or replacement
of a subprocessor at least **`[30]` days** in advance, by `[e-mail to the
Controller's contact / notice in the admin area]`. The Controller may object on
reasonable data-protection grounds within `[14]` days. If the parties cannot
resolve the objection, the Controller may terminate the affected service
`[without penalty]`.

7.3 The Processor imposes on each subprocessor data-protection obligations that
are substantially the same as in this Agreement (Art. 28(4)). Where the register
states that a provider's terms are "held by the operator", those terms are the
basis; the transfer mechanism per provider is in
[`dpa-annex-sccs.md`](dpa-annex-sccs.md).

## 8. Assistance with data-subject requests

8.1 The platform provides self-service tools the Controller can use to answer
requests under Arts. 15–22:

- **Access / portability** — every signed-in person can download their own data
  as JSON (`GET /api/account/export`); the Controller's organisation admin can
  export the whole tenant (`GET /api/admin/organizations/[id]/export`).
- **Rectification** — profile editing by the person and by administrators.
- **Erasure** — self-service account deletion (`DELETE /api/account`) and the
  administrator's erase action (anonymise or delete,
  `POST /api/admin/users/[id]/erase`); see
  [`../trust/data-lifecycle.md`](../trust/data-lifecycle.md) for what is kept and why.
- **Objection / withdrawal of consent** — consent switches under Account →
  Privacy; unsubscribe links in every non-essential mail.

8.2 Where a request cannot be served with these tools (for example a name quoted
in another user's free-standing notes), the Processor assists on request within
`[10]` working days.

8.3 A request the Processor receives directly is forwarded to the Controller
without undue delay and not answered by the Processor unless the Controller
instructs it to.

## 9. Personal data breaches

9.1 The Processor notifies the Controller of a personal data breach **without
undue delay and in any case within `[48]` hours** after becoming aware of it, so
that the Controller can meet its own 72-hour deadline under Art. 33. The
Processor's internal procedure is `docs/incident-response.md`.

9.2 The notification contains, as far as known at the time: the nature of the
breach, the categories and approximate number of data subjects and records, the
likely consequences, the measures taken or proposed, and a contact point. Missing
information is supplied in phases as it becomes available.

9.3 The Processor assists the Controller with notifications to the supervisory
authority and to data subjects (Arts. 33–34) and documents the breach.

## 10. Deletion or return on termination

10.1 **Return.** Before or at the end of the Main Agreement the Controller can
take a full export of its organisation at any time
(`GET /api/admin/organizations/[id]/export`, format
`interncrm.tenant-export/1`, described in
[`../tenant-lifecycle.md`](../tenant-lifecycle.md) § Export). Credentials
(password hashes, TOTP secrets, API-key hashes, tokens) are deliberately excluded
and listed in the export's `_meta`.

10.2 **Archive.** On termination the Processor archives the organisation
(`POST /api/admin/organizations/[id]/archive`): every sign-in is refused, live
sessions end, no mail is sent to the tenant's people; nothing is destroyed yet,
so the export remains possible during `[30]` days.

10.3 **Deletion.** After that period, and after a full export has been taken (or
the Controller has declined one in writing), the Processor permanently deletes
the organisation with the two-stage hard delete described in
[`../tenant-lifecycle.md`](../tenant-lifecycle.md) § Hard delete
(`POST …/[id]/deletion`, then `DELETE /api/admin/organizations/[id]`, with a
waiting period of `TENANT_HARD_DELETE_WAIT_HOURS`, default 72 h). The hard delete
is **disabled unless the deployment sets `TENANT_HARD_DELETE_ENABLED`**; the
Processor commits to enable it for the deletion, or to perform an equivalent
deletion, within `[60]` days after termination.

10.4 **What survives.** (a) one `org.deleted` record in the operator's own
organisation naming the tenant's id, slug and name; (b) database backups, which
age out under their own rotation (local copies `KEEP_DAYS`, default 7 days;
off-site snapshots up to 12 monthly snapshots — `docs/disaster-recovery.md`) and
are not restored except for disaster recovery; (c) records the Processor must
keep under a legal obligation, listed in
[`../trust/data-lifecycle.md`](../trust/data-lifecycle.md).

10.5 On request the Processor confirms the deletion in writing.

## 11. Audits and information

11.1 The Processor makes available all information necessary to demonstrate
compliance with Art. 28, in the first instance through the documents linked in
this Agreement, [`../trust/`](../trust/README.md) and the public source code.

11.2 The Controller (or an auditor it mandates, bound to confidentiality) may
carry out an audit `[once per year]` with `[30]` days' notice, during business
hours and without undue disruption; more often after a breach or on a
supervisory authority's request. `[Cost allocation.]`

11.3 The Processor holds no SOC 2 or ISO 27001 certification
(`docs/trust/soc2-decision.md`); answers to standard questionnaires are in
`docs/trust/questionnaire-answers.md`.

## 12. Liability, precedence, law

`[To be completed by counsel: liability per Main Agreement / Art. 82; this
Agreement prevails over the Main Agreement on data protection; governing law and
venue.]`

---

Signatures: `[Controller]` · `[Processor / operator]` · `[date]`
