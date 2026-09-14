# Epic 7 — Daily workflow

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **Medium** · Effort **Medium**

**DE:** Die tägliche Arbeit im CRM angenehm und schnell machen.
**TR:** CRM'deki günlük işi hızlı ve rahat hale getir.

An internal tool that is unpleasant gets worked around, and a CRM that is worked
around is a spreadsheet with extra steps. This epic is the ordinary,
unglamorous work that decides whether the team actually uses it.

**One item here is not a nicety but a hole:** a customer cannot be edited after
creation (T-7.1.1). Everything else is genuinely incremental.

---

## Story 7.1 — Working the customer list

`Feature` · Priority **High** · Effort **Medium**

**DE:** Kunden bearbeiten, sortieren, filtern und in Mengen zuweisen.
**TR:** Müşterileri düzenle, sırala, filtrele ve toplu ata.

---

### T-7.1.1 — Edit an existing customer

`Task` · Priority **Urgent** · Effort **Medium**

**DE:** Kundendaten nach dem Anlegen bearbeiten können.
**TR:** Oluşturduktan sonra müşteri bilgilerini düzenleyebilmek.

**Done when**
- `/dashboard/customers/[id]/edit` edits every field the create form offers,
  except the stage.
- Saving does not touch lifecycle dates or write a `StageChange`.
- An e2e spec changes a field and asserts it persisted.

**Prompt**

> Add customer editing to the SaleVali Marketing CRM. Today a customer can be
> created and its stage moved, but a typo in the company name or a changed
> transaction volume can only be fixed in the database — the most basic CRUD
> operation is missing.
>
> Add `/dashboard/customers/[id]/edit` reusing the field layout of
> `src/app/dashboard/customers/new/page.tsx` (extract the shared form rather
> than copying it — two divergent copies of this form is a future bug), and
> link to it from the detail page.
>
> Deliberately exclude the stage: it has its own form and its own audit trail,
> and letting an edit change it silently would bypass `lifecycleTimestampsFor()`
> and `StageChange`, which `CLAUDE.md` forbids. Editing must not touch the
> lifecycle dates at all.
>
> Validate with `customerUpdateSchema` from `src/lib/schemas.ts` and add an e2e
> spec.

---

### T-7.1.2 — Sort the customer list

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Liste nach Trial-Ende, Umsatz oder letzter Änderung sortieren.
**TR:** Listeyi deneme bitişi, gelir veya son güncellemeye göre sırala.

**Done when**
- A sort selector offers: recently updated (default), trial ending soonest,
  highest revenue, company name.
- The choice lives in the URL alongside the existing filters.
- Customers with no trial end or no revenue sort last, not first.

**Prompt**

> Add sorting to `/dashboard/customers` in the SaleVali Marketing CRM:
> recently updated (the current default), trial ending soonest, highest
> revenue, and company name A–Z.
>
> Put it in the URL next to the existing `q` / `stage` / `pricingModel` /
> `channel` params, validated against the allowed values with a fallback, the
> way those already are.
>
> Nulls are the part to get right: a customer with no `trialEndsAt` must sort
> **last** under "trial ending soonest", not first. MySQL sorts NULLs first
> ascending, so this needs an explicit `{ sort: "asc", nulls: "last" }` in the
> Prisma `orderBy`. Same for revenue.

---

### T-7.1.3 — Paginate the list

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Kundenliste seitenweise laden.
**TR:** Müşteri listesini sayfalara böl.

**Done when**
- The list shows 25 per page with prev/next and a total count.
- The page number is in the URL and survives filtering.
- Changing a filter resets to page 1.

**Prompt**

> Add pagination to `/dashboard/customers` in the SaleVali Marketing CRM. The
> page currently loads every customer and renders a card for each; that is fine
> for fifty and unusable for two thousand, and the import epic is about to
> create the second situation.
>
> 25 per page, `skip`/`take` plus a `count` in the same transaction, prev/next
> controls and "Showing 26–50 of 312". Keep the page in the URL with the
> existing filters.
>
> Reset to page 1 whenever a filter changes — landing on page 7 of a two-page
> result set shows an empty list that reads as "no customers match", which is
> the kind of small wrongness that erodes trust in a tool.

---

### T-7.1.4 — "My customers" quick filter

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Schnellfilter für die eigenen zugewiesenen Kunden.
**TR:** Kendine atanmış müşteriler için hızlı filtre.

**Done when**
- A toggle filters the list to `assignedTo = current user`.
- It composes with the other filters instead of replacing them.
- The state is in the URL.

**Prompt**

> Add a "My customers" toggle to `/dashboard/customers` in the SaleVali
> Marketing CRM, filtering to those assigned to the signed-in user.
>
> It must **compose** with the existing stage, billing-model and channel
> filters rather than resetting them: "my customers whose trial is active" is
> the actual question someone has on a Monday morning. Keep it in the URL as a
> boolean param, and style it as a toggle rather than another dropdown so it
> reads as a shortcut.

---

### T-7.1.5 — Bulk assign an owner

`Task` · Priority **Low** · Effort **Medium**

**DE:** Mehrere Kunden auf einmal einer Person zuweisen.
**TR:** Birden fazla müşteriyi tek seferde bir kişiye ata.

**Done when**
- Checkboxes on the list allow selecting rows and assigning an owner in one
  action.
- The action reports how many were changed.
- Selection survives neither filtering nor paging, and that is intentional and
  visible.

**Prompt**

> Add bulk owner assignment to `/dashboard/customers` in the SaleVali Marketing
> CRM: checkboxes per row, a "Assign to…" control, one server action.
>
> After a CSV import, hundreds of customers land unassigned and reassigning
> them one at a time is what makes people give up on a tool.
>
> Do not try to preserve selection across filter changes or pages — that
> requires tracking ids in the URL and quietly acting on rows the operator
> cannot see, which is how bulk actions cause accidents. Clear the selection
> and say so ("selection cleared"). Report `N customers reassigned`, and check
> `canEdit` per customer rather than once for the batch.

---

## Story 7.2 — Tasks across customers

`Feature` · Priority **Medium** · Effort **Medium**

**DE:** Alle offenen Aufgaben an einem Ort sehen.
**TR:** Tüm açık görevleri tek yerde gör.

---

### T-7.2.1 — A tasks page

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Seite mit allen eigenen offenen Aufgaben.
**TR:** Kendi açık görevlerini listeleyen sayfa.

**Done when**
- `/dashboard/tasks` lists the signed-in user's open tasks, soonest due first.
- Each row links to its customer and can be completed in place.
- A filter shows all users' tasks for managers.

**Prompt**

> Add `/dashboard/tasks` to the SaleVali Marketing CRM: every open task
> assigned to the signed-in user, due date ascending, each showing its customer
> and completable without leaving the page.
>
> Tasks are currently only visible on the customer they belong to, which means
> "what do I need to do today" requires opening customers one by one — the
> question the tool should answer first is the one it cannot answer at all.
>
> Reuse the toggle server action from the customer detail page rather than
> writing a second one. Add a sidebar entry, and a filter for `MANAGER` and
> `ADMIN` to see the whole team's tasks. Respect `scopeForUser()` if epic 6 has
> landed.

---

### T-7.2.2 — Highlight overdue tasks

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Überfällige Aufgaben deutlich markieren.
**TR:** Vadesi geçmiş görevleri belirgin şekilde işaretle.

**Done when**
- Tasks past their due date are visibly distinct wherever they are rendered.
- The dashboard shows an overdue count.
- "Due today" is not styled as overdue.

**Prompt**

> Make overdue tasks visible in the SaleVali Marketing CRM: distinct styling on
> the customer detail page, on `/dashboard/tasks`, and an overdue count tile on
> the dashboard.
>
> Overdue means the due date is **before today**, not before now — a task due
> today is not late at nine in the morning, and marking it red teaches people
> to ignore the colour. Compare by calendar day and reuse `daysUntil()` from
> `src/lib/lifecycle.ts`.
>
> Do not rely on colour alone; add a label, so the state survives a screenshot
> in a chat and a colour-blind reader.

---

### T-7.2.3 — Daily digest of what is due

`Task` · Priority **Low** · Effort **Medium**

**DE:** Tägliche E-Mail mit fälligen Aufgaben und Trials.
**TR:** Günlük olarak vadesi gelen görev ve denemeleri e-postala.

**Done when**
- A `daily-digest` cron job emails each user their tasks due today plus their
  overdue ones.
- Users with nothing due receive nothing.
- It reuses the cron infrastructure from epic 2.

**Prompt**

> Add a `daily-digest` job to the SaleVali Marketing CRM's cron registry
> (epic 2, `POST /api/cron/[job]`): one email per user with their tasks due
> today, their overdue tasks, and their trials ending this week.
>
> Send nothing to users with an empty digest. A daily "you have nothing to do"
> email is how a team learns to filter the sender, taking the useful ones with
> it.
>
> Reuse the template approach and the per-user locale from epic 4 if it has
> landed. Respect the baseline guard so the first run does not mail a backlog
> of overdue tasks.

---

## Story 7.3 — Rough edges

`Feature` · Priority **Medium** · Effort **Low**

**DE:** Kleine Lücken schließen, die täglich stören.
**TR:** Her gün rahatsız eden küçük eksikleri kapat.

---

### T-7.3.1 — Delete a customer from the UI

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Kunden im Interface löschen — mit Bestätigung.
**TR:** Arayüzden müşteri silme — onay ile.

**Done when**
- `MANAGER` and `ADMIN` can delete from the detail page, behind a confirm
  dialog naming the company.
- The dialog says what else will be deleted (interactions, tasks, history).
- The API route already exists and is reused.

**Prompt**

> Add delete-from-the-UI for customers in the SaleVali Marketing CRM.
> `DELETE /api/customers/:id` already exists and is restricted to `MANAGER` and
> `ADMIN`; there is no way to reach it from the interface.
>
> Put it on the detail page behind a confirm dialog that names the company and
> states the consequences concretely — "this also deletes 14 interactions, 3
> tasks and 6 stage changes" — because cascade deletes are exactly what people
> do not picture when they click Delete. Contacts survive by design
> (`onDelete: SetNull`); say that too.
>
> Redirect to the list on success with a confirmation message. Add an e2e spec
> covering the confirm, the cancel, and a `MARKETER` not seeing the button.

---

### T-7.3.2 — Edit and delete contacts

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Kontakte bearbeiten und löschen können.
**TR:** Kişileri düzenleyip silebilmek.

**Done when**
- A contact can be edited (including reassigning it to another customer) and
  deleted.
- Marking one contact primary unmarks the previous primary for that customer.
- Covered by an e2e spec.

**Prompt**

> Add editing and deleting for contacts in the SaleVali Marketing CRM. They can
> currently only be created; a wrong email address is permanent.
>
> Support reassigning a contact to a different customer — people change
> employer, and re-creating them loses the record. When a contact is marked
> primary, unmark the previous primary for that customer in the same
> transaction, or the UI will show two.
>
> Add `PATCH` and `DELETE` at `/api/contacts/[id]` with the session check every
> route needs, plus the UI on `/dashboard/contacts`, and an e2e spec.

---

### T-7.3.3 — Confirmation feedback on save

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Nach dem Speichern sichtbare Rückmeldung geben.
**TR:** Kaydettikten sonra görünür geri bildirim ver.

**Done when**
- Server-action saves show a short confirmation.
- Validation failures show what went wrong instead of a silent redirect.
- The pattern is one shared component, used everywhere.

**Prompt**

> Add save feedback to the SaleVali Marketing CRM. Today the server actions
> redirect with `?error=validation` and nothing renders it — a failed save
> looks identical to a successful one, and the operator finds out later that
> their note was never stored.
>
> Add a small shared toast or inline banner component and use it consistently:
> confirmation on success, the specific field errors on failure. Read the zod
> error rather than showing a generic message; `src/lib/schemas.ts` already
> produces a flattened shape with per-field messages.
>
> Do this once, as one component, and convert the existing forms to it.

---

### T-7.3.4 — Empty states that point somewhere

`Task` · Priority **Low** · Effort **Low** · `good first issue`

**DE:** Leere Zustände mit klarer nächster Aktion versehen.
**TR:** Boş ekranlara net bir sonraki adım ekle.

**Done when**
- Every empty list explains what would appear there and links to the action
  that creates it.
- The wording is specific to the screen, not a generic "No data".

**Prompt**

> Improve the empty states across the SaleVali Marketing CRM: the customer
> list, contacts, campaigns, tasks, interactions and the dashboard panels.
>
> Each should say what belongs there and link to the action that creates it —
> "No customers match these filters. Clear the filters, or add a customer." A
> first-time user sees nothing but empty states, and "No data" tells them
> neither what the screen is for nor what to do.
>
> Distinguish genuinely empty from filtered-to-empty: they need different
> wording and different links.

---

### T-7.3.5 — Loading states for slow pages

`Task` · Priority **Low** · Effort **Low** · `good first issue`

**DE:** Ladezustände für Seiten mit vielen Abfragen.
**TR:** Çok sorgu yapan sayfalar için yükleniyor durumu.

**Done when**
- `loading.tsx` files exist for the dashboard, customer list and detail routes.
- Skeletons approximate the real layout rather than showing a spinner.
- Nothing shifts position when the content arrives.

**Prompt**

> Add `loading.tsx` files to the dashboard routes of the SaleVali Marketing
> CRM: `/dashboard`, `/dashboard/customers`, `/dashboard/customers/[id]`. They
> are all `force-dynamic` and run several Prisma queries, so on a slow
> connection the browser shows the previous page with no sign anything is
> happening.
>
> Use skeleton blocks matching the real layout — same card sizes, same grid —
> rather than a centred spinner, so nothing jumps when the content arrives.
> Reuse the existing Tailwind card classes and `animate-pulse`.
