# Epic 8 — Test coverage and guardrails

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **Medium** · Effort **Medium**

**DE:** Lücken in der Testabdeckung schließen und Regeln automatisch durchsetzen.
**TR:** Test kapsamındaki boşlukları kapat ve kuralları otomatik uygulat.

Six flows are covered end to end: auth, the API's 401s, the lifecycle rules,
list filters, follow-ups and health. Three important ones are not covered at
all — invitations, campaigns and role gating — and there is no unit-test harness
for the pure functions in `src/lib/`, which is where the pricing and lifecycle
logic lives.

---

## Story 8.1 — Cover the gaps

`Feature` · Priority **Medium** · Effort **Medium**

**DE:** Ungetestete Abläufe absichern.
**TR:** Test edilmemiş akışları güvenceye al.

---

### T-8.1.1 — Unit-test harness for `src/lib`

`Task` · Priority **High** · Effort **Medium**

**DE:** Testumgebung für reine Funktionen einrichten und die Preislogik abdecken.
**TR:** Saf fonksiyonlar için test ortamı kur ve fiyat mantığını kapsa.

**Done when**
- `npm test` runs unit tests over `src/lib/**` without a database or a browser.
- `estimateMonthlyRevenue` and `lifecycleTimestampsFor` are covered, including
  the tier boundaries and the "existing dates are never overwritten" rule.
- It runs in `ci.yml`.

**Prompt**

> Add a unit-test harness to the SaleVali Marketing CRM for the pure functions
> in `src/lib/`. The pricing tiers and the lifecycle date derivation are the
> two pieces of logic where a silent mistake corrupts money and funnel
> reporting, and today they are only exercised indirectly through Playwright,
> which needs a database and a browser to check arithmetic.
>
> Use Node's built-in `node:test` runner with `tsx` so nothing heavy is added.
> Add `npm test` and wire it into `.github/workflows/ci.yml`.
>
> Cover `estimateMonthlyRevenue` at the tier boundaries — 0, 100, 101, 1000,
> 1001, 1200 (which must be €71.60) — invoice-only, and undecided. Cover
> `lifecycleTimestampsFor`: the 30-day window, that re-entering a trial keeps
> the original dates, that terminal stages set `closedAt`, and that reopening
> clears it while `churnedAt` survives.

---

### T-8.1.2 — E2E for the invitation and registration flow

`Task` · Priority **High** · Effort **Medium**

**DE:** Einladung und Registrierung durchgängig testen.
**TR:** Davet ve kayıt akışını uçtan uca test et.

**Done when**
- A spec seeds an invitation token, registers through `/register`, and signs in
  as the new user.
- An expired or already-used token is refused.
- No email is actually sent.

**Prompt**

> Add `e2e/invitations.spec.ts` to the SaleVali Marketing CRM. Onboarding a
> teammate is the only way a new user exists, and it is untested — if it broke,
> nobody would find out until someone tried to join.
>
> Seed an `InvitationToken` directly with `e2e/helpers/db.ts` rather than going
> through the invite form, so the spec never touches SMTP. Then register at
> `/register?token=…`, sign in as the new user, and assert they reach the
> dashboard with the role the invitation carried.
>
> Cover the refusals too: an expired token, an already-used one, and a garbage
> one — an invite system that accepts a used token is an open registration
> page. Clean up in `afterAll` and read `docs/testing.md` first.

---

### T-8.1.3 — E2E for campaigns

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Kampagnen anlegen und Zuordnung zu Kunden testen.
**TR:** Kampanya oluşturmayı ve müşteriye atanmasını test et.

**Done when**
- A spec creates a campaign and asserts it appears with its status and budget.
- A customer created against it shows up in the campaign's customer count.
- Fixtures are cleaned up.

**Prompt**

> Add `e2e/campaigns.spec.ts` to the SaleVali Marketing CRM: create a campaign
> at `/dashboard/campaigns`, assert it renders with its status, budget and a
> customer count of zero; then create a customer attributed to it via
> `createCustomer()` in `e2e/helpers/customers.ts` and assert the count becomes
> one.
>
> That second assertion is the point — the campaign→customer attribution is the
> only reason `Campaign` exists in this schema, and a count that silently reads
> zero would make every acquisition-channel decision wrong.
>
> Use a unique name prefix and clean up in `afterAll`; add a `cleanupCampaigns`
> helper next to the existing ones.

---

### T-8.1.4 — E2E for the users page and role gating

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Zugriff auf die Benutzerseite je Rolle prüfen.
**TR:** Kullanıcılar sayfasına rol bazlı erişimi doğrula.

**Done when**
- An admin sees `/dashboard/users` and the sidebar entry; a marketer sees
  neither.
- `POST /api/users/invite` refuses a non-admin.
- Tagged `@smoke`.

**Prompt**

> Add `e2e/users-page.spec.ts` to the SaleVali Marketing CRM. The sidebar hides
> the Users entry for non-admins, but hiding a link is not access control —
> assert the server enforces it.
>
> Seed a `MARKETER` with `e2e/helpers/db.ts`, sign in as them, and assert:
> the sidebar has no Users entry, navigating directly to `/dashboard/users` is
> refused, and `POST /api/users/invite` does not succeed. Then the same as an
> `ADMIN`, asserting all three work.
>
> Tag it `@smoke`: privilege escalation is the most expensive bug class here,
> and this spec is cheap. If epic 6 has landed, fold it into
> `authz-matrix.spec.ts` instead of duplicating.

---

### T-8.1.5 — Demo seed script

`Task` · Priority **Medium** · Effort **Low** · `good first issue`

**DE:** Skript mit realistischen Beispieldaten für Entwicklung und Preview.
**TR:** Geliştirme ve preview için gerçekçi örnek veri script'i.

**Done when**
- `npm run seed:demo` creates ~30 customers spread across every stage, with
  contacts, channels, interactions, tasks and stage history.
- It is idempotent and clearly marked as demo data.
- It refuses to run against production.

**Prompt**

> Add `prisma/seed-demo.mjs` and `npm run seed:demo` to the SaleVali Marketing
> CRM: about 30 realistic customers spread across every `LifecycleStage`, with
> contacts, channels, a few interactions and tasks each, and **backdated stage
> history** so the analytics epic has something to chart.
>
> Backdating matters: transitions all stamped "now" make every conversion
> instant and every time-in-stage zero, which makes the analytics work
> impossible to develop against.
>
> Make it idempotent (prefix every company with `DEMO`, delete those first) and
> refuse to run when `NODE_ENV=production` or when the database already holds
> non-demo customers — a demo seeder that fires against production is a very
> bad afternoon. Use plausible German merchant names and real channel mixes.

---

## Story 8.2 — Guardrails

`Feature` · Priority **Medium** · Effort **Medium**

**DE:** Regeln, die sich selbst durchsetzen statt in einem Dokument zu stehen.
**TR:** Belgede kalmak yerine kendini uygulatan kurallar.

---

### T-8.2.1 — Check that every API route checks the session

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Automatisch prüfen, dass jede API-Route die Sitzung kontrolliert.
**TR:** Her API rotasının oturumu kontrol ettiğini otomatik doğrula.

**Done when**
- `npm run check:auth` fails when a route handler under `src/app/api/**` has no
  session check.
- Deliberate exceptions (`/api/health`, `/api/auth/*`, `/api/register`) are
  listed explicitly with a reason.
- It runs in CI.

**Prompt**

> Add `scripts/check-auth-routes.mjs` and `npm run check:auth` to the SaleVali
> Marketing CRM: walk every `route.ts` under `src/app/api/**` and fail when an
> exported handler contains no call to `getServerAuthSession` or an equivalent
> guard.
>
> `e2e/auth.spec.ts` already asserts this for the routes it knows about, but it
> is a hard-coded list — a new route added next month is not on it, and the gate
> passes. A static check covers routes nobody remembered to add.
>
> Keep an explicit allowlist with a reason per entry: `/api/health` (public
> liveness by design), `/api/auth/[...nextauth]`, `/api/register`
> (token-gated), `/api/cron/[job]` (shared secret). Wire it into `ci.yml` and
> mention it in `CONTRIBUTING.md`.

---

### T-8.2.2 — Accessibility smoke check

`Task` · Priority **Low** · Effort **Medium**

**DE:** Grundlegende Barrierefreiheit der Hauptseiten prüfen.
**TR:** Ana sayfaların temel erişilebilirliğini kontrol et.

**Done when**
- A spec runs an automated a11y scan over login, dashboard, customer list and
  customer detail.
- Serious and critical violations fail; minor ones are reported.
- Existing violations are either fixed or listed with a reason.

**Prompt**

> Add `e2e/a11y.spec.ts` to the SaleVali Marketing CRM using `@axe-core/playwright`
> over `/login`, `/dashboard`, `/dashboard/customers` and a customer detail
> page.
>
> Fail on `serious` and `critical` only, and print the rest. A gate that fails
> on every minor contrast nit on day one gets disabled in a week.
>
> Fix what it finds if the fixes are small — form labels, colour contrast on
> the badges, focus order. If something needs a real redesign, list it in the
> spec with a comment explaining why it is deferred rather than lowering the
> threshold silently.
