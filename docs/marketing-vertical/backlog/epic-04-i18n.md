# Epic 4 — German and Turkish UI

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **High** · Effort **High**

**DE:** Oberfläche auf Deutsch, Englisch und Türkisch — wie SaleVali selbst.
**TR:** Arayüz Almanca, İngilizce ve Türkçe — SaleVali'nin kendisi gibi.

SaleVali ships in DE / EN / TR and the marketing team is German- and
Turkish-speaking. The CRM is English-only, with every label, badge and empty
state hard-coded in the components.

**Sequence matters.** Do this *after* epics 1–3: those add new screens and new
strings, and extracting twice is wasted work. But do not leave it much longer
than that — the cost grows with every component.

---

## Story 4.1 — Foundation

`Feature` · Priority **High** · Effort **Medium**

**DE:** Übersetzungsdateien, Helfer und eine CI-Prüfung, bevor irgendetwas übersetzt wird.
**TR:** Bir şey çevrilmeden önce çeviri dosyaları, yardımcı ve CI kontrolü.

---

### T-4.1.1 — Locale files and the `t()` helper

`Task` · Priority **High** · Effort **Medium**

**DE:** `src/i18n/{de,en,tr}.ts` und eine typsichere `t()`-Funktion.
**TR:** `src/i18n/{de,en,tr}.ts` ve tip güvenli bir `t()` fonksiyonu.

**Done when**
- Three locale modules share one key structure, with English as the reference.
- `t(key, params?)` supports `{count}`-style interpolation and is typed, so a
  missing key is a compile error rather than a blank on screen.
- A missing translation falls back to English and logs once in development.

**Prompt**

> Add the i18n foundation to the SaleVali Marketing CRM. No component changes
> in this task — just the machinery, so the translation tasks that follow are
> mechanical.
>
> Create `src/i18n/en.ts` as the reference: a nested object of plain strings.
> Derive the type from it (`type Messages = typeof en`) and type `de.ts` and
> `tr.ts` as `Messages`, so a missing or misspelled key fails `tsc` instead of
> rendering an empty string in front of a customer. Add `src/i18n/index.ts`
> with `t(locale, key, params?)` supporting `{name}`-style interpolation, and
> fall back to English for a missing value, logging once in development only.
>
> Seed it with the strings that already exist in `src/components/Sidebar.tsx`
> so there is something real to test against, and add a couple of unit-style
> checks for interpolation and fallback. Do not translate any pages yet.

---

### T-4.1.2 — Per-user locale and a language switcher

`Task` · Priority **High** · Effort **Medium**

**DE:** Sprache pro Benutzer speichern und umschaltbar machen.
**TR:** Dili kullanıcı bazında sakla ve değiştirilebilir yap.

**Done when**
- `User.locale` exists (`DE | EN | TR`, default `EN`) and is on the session.
- A switcher in the sidebar changes it and persists it.
- Server components read the locale from the session, not from a cookie guess.

**Prompt**

> Add per-user language selection to the SaleVali Marketing CRM.
>
> Add a `locale` field to `User` in `prisma/schema.prisma` reusing the existing
> `CustomerLocale` enum (DE/EN/TR), defaulting to `EN` — additive, so the
> schema guard stays quiet. Put it on the NextAuth JWT and session next to
> `role` (see `src/lib/auth.ts` and `src/types/next-auth.d.ts`), so server
> components can read it without an extra query.
>
> Add a switcher to `src/components/Sidebar.tsx` that writes the choice through
> a server action and refreshes. Note in a comment that this is the *operator's*
> language, which is a different thing from `Customer.locale` — the language
> the merchant uses — and the two must not be conflated.

---

### T-4.1.3 — CI check that the three files agree

`Task` · Priority **High** · Effort **Medium**

**DE:** CI-Prüfung, dass alle Sprachdateien dieselben Schlüssel haben.
**TR:** CI'da üç dil dosyasının aynı anahtarlara sahip olduğunu doğrula.

**Done when**
- `npm run check:i18n` compares the key sets of the three files and fails,
  listing what is missing where.
- It also flags keys present in `de`/`tr` but not in `en` (leftovers).
- The check runs in `ci.yml`.

**Prompt**

> Add `scripts/check-i18n.mjs` and an `npm run check:i18n` script to the
> SaleVali Marketing CRM: flatten the key sets of `src/i18n/{en,de,tr}.ts` and
> fail when they disagree.
>
> Report both directions and be specific — `tr is missing: customers.filters.stage`
> and `de has an unknown key: dashboard.oldTitle`. Typing catches most of this
> at build time, but a translator editing a file by hand will not run `tsc`,
> and a leftover key from a renamed screen is invisible until someone greps.
>
> Wire it into `.github/workflows/ci.yml` next to the lint and typecheck steps,
> and mention it in `CONTRIBUTING.md`.

---

## Story 4.2 — Translate the surfaces

`Feature` · Priority **High** · Effort **Medium**

**DE:** Bildschirm für Bildschirm auf `t()` umstellen.
**TR:** Ekran ekran `t()` kullanımına geçir.

These are deliberately split per screen so several people can work in parallel
without colliding, and each one is small enough to finish and merge the same
day.

---

### T-4.2.1 — Sidebar, login and register

`Task` · Priority **High** · Effort **Low** · `good first issue`

**DE:** Navigation und Anmeldeseiten übersetzen.
**TR:** Menü ve giriş sayfalarını çevir.

**Done when**
- No literal user-facing English remains in `Sidebar.tsx`, `login/page.tsx`,
  `register/page.tsx`.
- Error messages ("Invalid email or password.") are translated too.
- The e2e specs still pass — they may need to assert on stable roles or test
  ids instead of English text.

**Prompt**

> Translate the sidebar and the auth pages of the SaleVali Marketing CRM to use
> `t()`: `src/components/Sidebar.tsx`, `src/app/login/page.tsx`,
> `src/app/register/page.tsx`. Add the keys to all three files in `src/i18n/`
> — German and Turkish included, not just English placeholders.
>
> Include the error strings, not only the labels: "Invalid email or password."
> is the sentence a user is most likely to read.
>
> The login pages are covered by `e2e/auth.spec.ts`, which matches on English
> text. Update those assertions to target roles or test ids rather than
> literals, so the suite does not break the next time a translation is
> reworded. Run `npm run test:e2e:smoke` before opening the PR.

---

### T-4.2.2 — Customer list and filters

`Task` · Priority **High** · Effort **Low** · `good first issue`

**DE:** Kundenliste samt Filtern übersetzen.
**TR:** Müşteri listesini ve filtrelerini çevir.

**Done when**
- `/dashboard/customers` and `CustomerCard` are fully translated.
- Filter option labels come from the shared enum-label task (T-4.2.5) rather
  than being duplicated here.
- `e2e/customers-list.spec.ts` still passes.

**Prompt**

> Translate `/dashboard/customers` in the SaleVali Marketing CRM: the page
> heading, description, filter placeholders and buttons, plus
> `src/components/CustomerCard.tsx`.
>
> Do not translate the stage, pricing-model or channel labels inline — those
> are shared with several screens and are handled once in T-4.2.5. If that task
> is not merged yet, leave them importing from `src/lib/constants.ts` and say
> so in the PR.
>
> `e2e/customers-list.spec.ts` matches on "Apply filters" and on headings.
> Update it to stay meaningful after translation, and run the spec.

---

### T-4.2.3 — Customer detail page

`Task` · Priority **High** · Effort **Medium**

**DE:** Detailseite eines Kunden übersetzen, inklusive Formularen.
**TR:** Müşteri detay sayfasını, formlar dahil, çevir.

**Done when**
- Every label on `/dashboard/customers/[id]` is translated, including the
  timeline rows, the stage form, the interaction and task forms.
- Dates use the operator's locale (see T-4.3.1).
- `e2e/customer-lifecycle.spec.ts` and `customer-followups.spec.ts` pass.

**Prompt**

> Translate `src/app/dashboard/customers/[id]/page.tsx` in the SaleVali
> Marketing CRM — the largest screen in the app: header facts, the subscription
> timeline rows, contacts and channels panels, and the three forms (move stage,
> log interaction, add task).
>
> Two things not to miss: the "Trial ends in N days" line needs pluralisation
> handled by `t()` with a count parameter, not string concatenation, because
> German and Turkish do not pluralise the way English does. And "Contract ends
> (+30d)" embeds a constant — pass `CANCELLATION_NOTICE_DAYS` as a parameter
> rather than baking 30 into three translations.
>
> Two e2e specs cover this page and match on English text; update and run both.

---

### T-4.2.4 — Dashboard, contacts and campaigns

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Dashboard, Kontakte und Kampagnen übersetzen.
**TR:** Dashboard, kişiler ve kampanyalar sayfalarını çevir.

**Done when**
- `/dashboard`, `/dashboard/contacts` and `/dashboard/campaigns` are
  translated, including table headers and empty states.
- Stat tile labels use `t()`.

**Prompt**

> Translate `/dashboard`, `/dashboard/contacts` and `/dashboard/campaigns` in
> the SaleVali Marketing CRM to use `t()`, adding keys to all three locale
> files.
>
> Include the parts that are easy to skip: table headers, the empty states
> ("No contacts created yet."), and the stat tile labels on the dashboard.
> Empty states are the first thing a new user sees, so they are the worst
> strings to leave in English.

---

### T-4.2.5 — Enum labels: stages, pricing, channels, sources

`Task` · Priority **High** · Effort **Low** · `good first issue`

**DE:** Aufzählungs-Bezeichnungen zentral übersetzen.
**TR:** Enum etiketlerini tek yerden çevir.

**Done when**
- `LIFECYCLE_STAGE_LABELS`, `PRICING_MODEL_LABELS`, `CUSTOMER_SOURCE_LABELS`,
  `INTEGRATION_*_LABELS`, `INTERACTION_TYPE_LABELS` and the rest resolve
  through `t()`.
- The enum values themselves are untouched — only their display text.
- Everything that renders them picks up the change without further edits.

**Prompt**

> Move the display labels in `src/lib/constants.ts` of the SaleVali Marketing
> CRM behind `t()`: lifecycle stages, pricing models, customer sources,
> integration channels and statuses, interaction types, SEPA statuses, user
> roles, campaign statuses.
>
> The enum **values** must not change — they are persisted in the database and
> read by the deploy scripts and the e2e specs. Only the human-readable text
> moves. Replace each `Record<Enum, string>` with a function taking the locale,
> keep the key names stable, and update the call sites.
>
> Product names stay untranslated: Amazon, eBay, OTTO, Shopify, WooCommerce are
> proper nouns in all three languages. Note that in a comment so nobody
> "completes" the German file by inventing translations for them.

---

### T-4.2.6 — Emails in the recipient's language

`Task` · Priority **Medium** · Effort **Medium**

**DE:** E-Mails in der Sprache der Empfängerin verschicken.
**TR:** E-postaları alıcının dilinde gönder.

**Done when**
- Invitation and trial-reminder emails are rendered in the recipient's locale.
- An invited user has no account yet, so the inviter chooses the language.
- The subject line is translated too.

**Prompt**

> Make the emails in `src/lib/mailer.ts` of the SaleVali Marketing CRM
> locale-aware: both the invitation and the trial reminder, subject lines
> included.
>
> For the trial reminder the recipient is a `User`, so use their `locale`. For
> an invitation there is no user yet — add a language selector to the invite
> form and pass the choice through `InvitationToken`, defaulting to the
> inviter's own locale. Getting a welcome mail in a language you do not read is
> a bad first impression of an internal tool.
>
> Keep the templates in `src/i18n/` alongside the UI strings rather than
> inventing a second translation mechanism for mail.

---

## Story 4.3 — Formats

`Feature` · Priority **Medium** · Effort **Low**

**DE:** Datums- und Zahlenformate an die Sprache anpassen.
**TR:** Tarih ve sayı formatlarını dile göre ayarla.

---

### T-4.3.1 — Locale-aware dates and numbers

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Datums- und Zahlenausgabe über eine gemeinsame Hilfsfunktion.
**TR:** Tarih ve sayı gösterimini ortak bir yardımcıdan geçir.

**Done when**
- `formatDate()` / `formatDateTime()` take a locale and are used everywhere,
  replacing the ad-hoc `toLocaleDateString()` calls.
- `formatCurrency()` takes a locale, still defaulting to de-DE and EUR.
- Dates render as `14.08.2026` in DE/TR and `8/14/2026` in EN.

**Prompt**

> Centralise date and number formatting in the SaleVali Marketing CRM. Today
> several pages call `toLocaleDateString()` with no locale, which means the
> output depends on the **server's** locale rather than the reader's — the same
> page renders differently depending on where it is deployed.
>
> Add `formatDate(value, locale)` and `formatDateTime(value, locale)` to
> `src/lib/lifecycle.ts` (next to `formatCurrency`, which should also take a
> locale while keeping its de-DE / EUR defaults), and replace every ad-hoc call
> in `src/app/**`. Map the app's DE/EN/TR onto `de-DE`, `en-GB` and `tr-TR`.
>
> Keep returning "—" for null, as the current helpers do.
