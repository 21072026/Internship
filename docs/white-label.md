# White-label branding (#546)

Per-tenant branding for the multi-tenancy track. Lets each `Organization`
override the product's identity so a tenant can present the CRM under their own
name/logo/color.

## What a tenant can override

Stored on `Organization` (all optional; `null` → product default):

| Field          | Meaning                                  | Default (`src/lib/branding.ts`) |
|----------------|------------------------------------------|---------------------------------|
| `brandName`    | Product/display name in chrome + emails  | `Internship CRM`                |
| `brandLogoUrl` | Logo shown in the sidebar / auth pages   | none (text wordmark)            |
| `brandColor`   | Accent color, hex (e.g. `#2563eb`)       | environment accent              |
| `supportEmail` | Tenant support address                   | app-level support setting       |

## Managing it

Admin → **Organizations** → *White-label branding* card: pick a tenant, edit the
fields, save. The API is `PATCH /api/admin/organizations` (ADMIN-only); a blank
field clears the override, and `brandColor` is validated as a hex value.

Resolution is centralized in `src/lib/branding.ts`:

```ts
import { resolveBranding } from '@/lib/branding';
const b = resolveBranding(org); // → { name, logoUrl, color, supportEmail } with defaults filled in
```

Server code almost never calls that directly — it calls
`getOrgBranding(orgId)` (`src/lib/orgBranding.ts`), which reads the org row and
hands the result through `resolveBranding()`. Passing `null` is legitimate and
means *product default*: a public page, a single-tenant install, or a user with
no org.

## Where it is applied today

Branding is resolved **and applied**. Two rules keep it honest:

1. **The org comes from whoever is being served**, never from ambient state —
   the signed-in user's `orgId` for a screen, the *recipient's* `orgId` for a
   message. A branded surface that reads "the current org" from anything else
   eventually brands one tenant's mail with another tenant's name.
2. **It is resolved at render/send time and never stored** on the thing it
   brands. Editing branding changes the next screen and the next mail; it does
   not rewrite what already went out (a sent newsletter issue is immutable by
   design — see [`newsletter.md`](newsletter.md)).

| Surface | How | Source of the org |
|---|---|---|
| App wordmark + logo in all five role shells (`admin`, `mentor`, `portal`, `company`, `source`) and the project workspace | `BrandWordmark` (`src/components/BrandWordmark.tsx`) | the signed-in user's `orgId` |
| Every transactional e-mail with a brand header | `emailBrand()` (`src/services/emailService.ts`) | the recipient's / the relation's `orgId` |
| The career newsletter | `renderNewsletterFor({ orgId })` (`src/lib/newsletterDispatch.ts`) | each **recipient's** `orgId`, memoised per org for the fan-out (#1667) |
| Completion certificate PDFs | `generateCertificatePdf({ branding })` | the issuing admin's `orgId` |
| Custom domain → tenant | host lookup, so the right tenant's branding and SSO config load | see [`custom-domain.md`](custom-domain.md) |

## What is NOT branded yet

Named here rather than implied, so nobody has to read the code to find the edge
of the feature:

- **The in-app accent palette.** `brandColor` reaches e-mail bodies and
  certificates, but the app's own Tailwind accent is still the environment
  accent (`src/lib/appEnv.ts`) — #1666.
- **Pre-login and public surfaces** (landing page, sign-in, the public
  registration flow). There is no session there, so there is no org to resolve
  from unless the request arrived on a tenant's custom domain — #1663/#1664/#1665.
- **The newsletter archive** (`/newsletters`) renders the issue's *fields*
  natively rather than the mail HTML, so it carries no brand header at all; an
  archive URL has no recipient, and the reader whose session opens it is the
  only org it could honestly show.

`WHITE_LABEL` in `src/lib/entitlementsCatalog.ts` is a **label, not a gate** —
nothing calls `hasFeature()` on it. Enforcement belongs to the entitlement
unification epic; do not add it as a side effect of a branding change.
