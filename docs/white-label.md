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

## Current phase / what's NOT wired yet

Branding is **managed and resolvable** but **not yet applied to the live UI**.
Applying it per request needs *tenant resolution* — knowing which org the current
request belongs to — which arrives with the `#543` query-isolation slice.

Until then:

- The single-tenant production instance keeps the product default chrome.
- The stored branding is safe to fill in ahead of time; it activates
  automatically once tenant resolution lands and the chrome reads
  `resolveBranding()` for the request's org.

### Wiring checklist (next slice)

1. Resolve the request's `orgId` (subdomain/host or the signed-in user's `orgId`).
2. Load that org's branding (cache per request).
3. Feed `resolveBranding()` into the layout: wordmark/logo, `data-accent` /
   CSS custom property for `color`, and support links/emails.
4. Fall back to `DEFAULT_BRANDING` whenever no org resolves (public pages).
