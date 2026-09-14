# Epic 6 — Access control and data protection

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **High** · Effort **Medium**

**DE:** Rollen wirksam machen und personenbezogene Daten schützen.
**TR:** Rolleri gerçekten işlevsel yap ve kişisel verileri koru.

`ADMIN`, `MANAGER` and `MARKETER` exist, but apart from delete permissions and
the Users page **every role sees and edits every customer**. Nothing records who
read which record, and erasing one person's data is a manual database operation.

That is acceptable for a small in-house team and wrong the moment a freelancer,
an agency or an intern gets an account. It is also awkward for a product whose
own selling points are GoBD and DSGVO compliance.

`SECURITY.md` lists these as known gaps; this epic closes them.

---

## Story 6.1 — Make the roles mean something

`Feature` · Priority **High** · Effort **Medium**

**DE:** Zugriffsregeln festlegen, an einer Stelle durchsetzen, negativ testen.
**TR:** Erişim kurallarını belirle, tek yerden uygula, negatif test et.

---

### T-6.1.1 — Decide and write down the access matrix

`Task` · Priority **High** · Effort **Low** · `documentation`

**DE:** Zuerst entscheiden, wer was sehen darf — und es aufschreiben.
**TR:** Önce kimin neyi görebileceğine karar ver — ve yaz.

**Done when**
- `docs/role-access-matrix.md` states, per role and per entity, what may be
  read, created, updated and deleted.
- The open question — do marketers see only their own customers? — is answered,
  not deferred.
- The document is agreed before any code is written.

**Prompt**

> Write `docs/role-access-matrix.md` for the SaleVali Marketing CRM: a table of
> role × entity × operation (read / create / update / delete) covering
> `Customer`, `Contact`, `Interaction`, `Task`, `Campaign`, `User` and the
> analytics pages.
>
> The decision that shapes the implementation, and that must be made here
> rather than in the code: does a `MARKETER` see **all** customers or only
> those assigned to them? Both are defensible — a small team benefits from
> everyone seeing everything, an agency arrangement does not. Recommend one,
> say why, and note what would change the answer.
>
> No code in this task. Enforcement is T-6.1.2 and T-6.1.3, and doing it before
> the policy exists means encoding an accident.

---

### T-6.1.2 — One place that decides scope

`Task` · Priority **High** · Effort **Medium**

**DE:** Eine zentrale Funktion, die den erlaubten Datenausschnitt liefert.
**TR:** İzin verilen veri kapsamını döndüren tek bir fonksiyon.

**Done when**
- `scopeForUser(session)` in `src/lib/access.ts` returns a
  `Prisma.CustomerWhereInput` implementing the matrix.
- `canEdit(session, customer)` and `canDelete(session, customer)` live next to
  it.
- It is unit-tested per role, including the deny cases.

**Prompt**

> Add `src/lib/access.ts` to the SaleVali Marketing CRM: one module that
> answers "what may this user see and do", implementing
> `docs/role-access-matrix.md`.
>
> `scopeForUser(session)` returns a `Prisma.CustomerWhereInput` to spread into
> every customer query — `{}` for a role that sees everything, a filter for one
> that does not. Add `canEdit(session, customer)` and
> `canDelete(session, customer)` beside it.
>
> One module, because scattered `if (role === "ADMIN")` checks are how an
> authorization bug hides: the ninth query is the one nobody remembers to
> guard. Do not wire it up yet — that is T-6.1.3. Test each role, and test what
> each role is refused.

---

### T-6.1.3 — Route every query through it

`Task` · Priority **High** · Effort **Medium**

**DE:** Alle Abfragen und Mutationen über die Zugriffsprüfung leiten.
**TR:** Tüm sorgu ve mutasyonları erişim kontrolünden geçir.

**Done when**
- Every customer read in `src/app/api/**` and `src/app/dashboard/**` applies
  `scopeForUser`.
- A customer outside the caller's scope returns `404`, not `403`.
- Mutations check `canEdit` / `canDelete` before writing.

**Prompt**

> Apply `scopeForUser()` across the SaleVali Marketing CRM: every place a
> `Customer` is read or written, in `src/app/api/**` and the dashboard pages.
>
> Return `404` rather than `403` for a customer outside the caller's scope. A
> `403` confirms the record exists, which leaks the customer list to anyone who
> can guess an id; `404` says nothing. Note that in a comment where the
> decision lives.
>
> Do not forget the indirect paths: interactions, tasks and integrations are
> reached through a customer id, so they need the same check — a scoped user
> must not be able to add a task to a customer they cannot see. Grep for
> `prisma.customer` and `customerId` and work through every hit.

---

### T-6.1.4 — Authorization matrix e2e spec

`Task` · Priority **High** · Effort **Medium**

**DE:** E2E-Test, der die Verbote prüft, nicht nur die Erlaubnisse.
**TR:** Sadece izinleri değil, yasakları da doğrulayan E2E testi.

**Done when**
- A spec seeds one user per role and asserts, for each protected route, who
  gets in and who does not.
- The **negative** cases are the point: a marketer must get `404`/`403` where
  the matrix says so.
- Tagged `@smoke`, because it guards the most expensive class of bug here.

**Prompt**

> Add `e2e/authz-matrix.spec.ts` to the SaleVali Marketing CRM: a
> table-driven spec that seeds one `ADMIN`, one `MANAGER` and one `MARKETER`,
> then walks every protected route asserting the expected status per role,
> straight from `docs/role-access-matrix.md`.
>
> The negative cases carry the value. A test suite that only proves admins can
> do admin things would have passed on every authorization bug ever shipped —
> what matters is that a marketer is *refused*. Assert the refusals explicitly,
> including the API routes, not just the pages.
>
> Tag it `@smoke` so it runs on every PR. Seed users through
> `e2e/helpers/db.ts` with a unique prefix and clean up in `afterAll`; read
> `docs/testing.md` first for the `waitForURL()` trap.

---

## Story 6.2 — GDPR surface

`Feature` · Priority **Medium** · Effort **Medium**

**DE:** Auskunft, Löschung und Nachvollziehbarkeit für personenbezogene Daten.
**TR:** Kişisel veriler için erişim, silme ve izlenebilirlik.

---

### T-6.2.1 — Log who read which customer

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Zugriffe auf Kundendatensätze protokollieren.
**TR:** Müşteri kaydı okumalarını logla.

**Done when**
- Opening a customer detail page writes an `AccessLog` row (user, customer,
  timestamp).
- Writes are fire-and-forget: a logging failure never breaks the page.
- Retention for the log is stated in the data-protection doc.

**Prompt**

> Add an `AccessLog` model to the SaleVali Marketing CRM — `userId`,
> `customerId`, `viewedAt` — and write a row when a customer detail page is
> opened.
>
> Do not let logging break the read: wrap the insert so a failure is caught and
> the page still renders. An audit trail that can take the app down is a
> liability, not a control.
>
> Consider volume before choosing the shape: one row per page view grows fast.
> Either collapse repeat views by the same user within a short window, or state
> a retention period and add a prune step to the nightly job. Say which you
> chose and why. Record the retention in `docs/DATA_ACCESS_POLICY.md`.

---

### T-6.2.2 — Erase a contact without losing the company

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Eine Person löschen, den Kunden als Firma aber behalten.
**TR:** Bir kişiyi sil ama müşteriyi firma olarak koru.

**Done when**
- An admin-only action erases a `Contact`'s personal fields and detaches them
  from interactions.
- The `Customer` and its commercial history survive.
- The erasure is itself recorded — who did it, when, for whom.

**Prompt**

> Add an admin-only "erase contact" action to the SaleVali Marketing CRM,
> answering a GDPR erasure request for one person without destroying the
> company's commercial history.
>
> Remove the personal fields (name, email, phone, notes) and detach the contact
> from anything naming them, but keep the `Customer` and its `StageChange`
> history — those are records about a company, not a person, and the funnel
> reporting depends on them. Interactions written *by* a team member stay;
> interactions naming the erased person in free text are the hard case, so
> flag them for manual review rather than pretending an automatic scrub is
> complete.
>
> Record the erasure itself (who, when, which contact) — an erasure you cannot
> evidence is one you cannot prove you performed. Behind a confirm dialog, with
> an e2e spec covering both the admin path and a marketer's refusal.

---

### T-6.2.3 — Data-protection policy document

`Task` · Priority **Medium** · Effort **Low** · `good first issue` · `documentation`

**DE:** Festhalten, welche Daten wie lange gespeichert werden.
**TR:** Hangi verinin ne kadar saklandığını yaz.

**Done when**
- `docs/DATA_ACCESS_POLICY.md` lists what personal data is held, why, for how
  long, and who may see it.
- It covers the backups, which also contain personal data.
- `SECURITY.md` links to it.

**Prompt**

> Write `docs/DATA_ACCESS_POLICY.md` for the SaleVali Marketing CRM: the
> personal data held (contact names, business emails, phone numbers, notes
> about people), the purpose, the retention period, and who may access it.
>
> Two things that are easy to leave out and matter most. First, the backups:
> `infra/backup-db.sh` writes dumps to `/var/backups/salevali-crm` that contain
> everything the database does, pruned after `KEEP_DAYS` — an erasure request
> is not fully honoured until those age out, and that has to be stated
> honestly. Second, who may read the data, which should point at
> `docs/role-access-matrix.md` rather than repeating it.
>
> Base it on what the code actually does today, not on an aspiration. Link it
> from `SECURITY.md`.

---

### T-6.2.4 — Export everything about one customer

`Task` · Priority **Low** · Effort **Low** · `good first issue`

**DE:** Alle Daten zu einem Kunden als JSON exportieren.
**TR:** Bir müşteriye ait tüm veriyi JSON olarak dışa aktar.

**Done when**
- `GET /api/customers/:id/export` returns the customer with contacts,
  interactions, tasks, integrations and stage history.
- It respects `scopeForUser` and requires a session.
- The download button is on the customer detail page.

**Prompt**

> Add `GET /api/customers/:id/export` to the SaleVali Marketing CRM: everything
> the CRM holds about one customer as JSON — the record itself plus contacts,
> interactions, tasks, integrations and stage history.
>
> It serves two purposes at once: answering an information request, and letting
> someone inspect a record without database access. Require a session, apply
> `scopeForUser()`, and return `404` for a customer outside scope.
>
> Set `Content-Disposition` so it downloads with the company name in the
> filename, slugified. Add a small "Export" link on the customer detail page.
