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

And, since #2922, the rest of the visual identity — what an installed app, a
browser tab, a launch screen and the accent palette show:

| Field              | Meaning | Default |
|--------------------|---------|---------|
| `brandTileColor`   | Hex colour of the tile behind the mark on every generated icon | `brandColor`, else the vertical's tint |
| `brandAccent`      | The accent a member who chose none wears: an `ACCENT_COLORS` key, or `brand` | the vertical's default accent |
| `brandPalette`     | The exact ramp behind `brand`: ten hexes, 50 → 900 (super admin only) | generated from `brandColor` |
| `brandMarkVersion` | The current generated icon set (`BrandAsset.version`) | none → the vertical's static files in `public/` |

`brandColor` now also drives the browser tint (`theme-color`), the manifest's
`theme_color` and the share card — not only mail.

## Managing it

Admin → **Organizations** → *White-label branding* card: pick a tenant, edit the
fields, save. The API is `PATCH /api/admin/organizations` (ADMIN-only); a blank
field clears the override, and `brandColor` is validated as a hex value.

The same card holds the per-organization brand (#2922):

- **Tile color** and **Default accent** (one of the accents, or *Organization
  colour*) — saved with the other fields. *Organization colour* needs a brand
  color or a palette to be a palette of.
- **Palette** — super admins only; a tenant ADMIN may clear it but not write
  one. Ten hexes, lightest first; refused unless white text on the 600 shade
  reaches 4.5:1. Left empty, the ramp is generated from `brandColor` in OKLCH
  (hue kept, 600 darkened until it clears AA) — `rampFrom()` in
  `src/lib/brandRule.ts`.
- **Logo mark** — its own request, `POST /api/admin/organizations/[id]/brand-mark`
  (multipart, field `file`), `DELETE` to remove. Same door as the PATCH: that
  organization's ADMIN or a super admin of its world; uploading needs the plan's
  `WHITE_LABEL` feature, removing never does.

### The logo mark and the generated icon set

Upload **one square mark** on a transparent background — SVG, or PNG/WebP of at
least 512 px — at most 2 MB. The server generates everything else from it with
`sharp` (`src/lib/brandRender.ts`, the same renderer
`scripts/generate-pwa-images.ts` cuts the committed default sets with):

| Kind | Size | Used by |
|---|---|---|
| `mark-128` | 128² (the bare glyph) | in-app mark, sign-in tile, mail logo, share card |
| `icon-192`, `icon-512` | 192², 512² (rounded tile, transparent corners) | manifest, push icon, JSON-LD logo |
| `icon-512-maskable` | 512² (full bleed, glyph in the safe zone) | manifest |
| `apple-touch-icon` | 180² (full bleed — iOS paints transparent corners black) | iOS home screen |
| `favicon-32` | 32² | browser tab |
| `shortcut-{messages,todos,notifications}-96` | 96² | manifest shortcuts |
| `splash-<w>x<h>` × 17 | per iOS device | launch screens (`APPLE_SPLASH_DEVICES`) |
| `source` | the upload itself | **never served** — kept to re-render on a new tile colour |

The geometry is the built-in marks': a 64-unit tile, 14-unit corners, the glyph
inset 9 units, so an organization's set looks like the product's own.

Everything is stored in the database (`BrandAsset`, ~0.3 MB per set) and served
from `GET /brand/<version>/<kind>.png`: an allowlist of the generated kinds,
`image/png`, `Cache-Control: public, max-age=31536000, immutable`, `nosniff`.
The version is `sha256(orgId : sha256(file) : tile : RENDER_VERSION)` cut to 16
hex characters — a new upload or tile colour is a new path (so caches never go
stale), and the URL names no organization. The route does no host lookup: the
page, the mail or the push payload chose the version, so the same URL works on
every host.

**Why an SVG is safe here.** An accepted SVG is rasterized and never served, so
it cannot carry script to a browser. What `src/lib/svgMark.ts` guards against is
the *rasterizer*: it refuses DOCTYPE/ENTITY, processing instructions, script,
foreignObject, image, feImage, XInclude, fonts and animation elements, event
handlers, any `href` that is not `#id`, any `url(…)` that is not `url(#id)`,
`@import`, `javascript:`/`data:` URLs, character references and backslash
escapes, more than 32 `<use>`, and a non-square `viewBox` — matching elements
by their local name under any namespace prefix, and refusing an XML declaration
that names an encoding other than UTF-8/ASCII. It also bounds what a file may
ask the renderer to *do*: no filters (`<filter>`, `fe*`, the `filter`
attribute or CSS property), no `<pattern>` or `<marker>`, no `<use>` that
points at something containing a `<use>`, at most 2,000 elements and 20,000
path commands, and tags that parse and nest.
`scripts/test/svg-mark.test.mjs` keeps a corpus of hostile files.

**Why rendering is bounded anyway.** The rules bound the work; the deadline
bounds whatever slips past them. An upload is decoded in a separate Node
process (`glyphMaster`, `src/lib/brandRender.ts`) under a pixel limit, with no
environment secrets, and SIGKILLed after 15 seconds (`too_complex`) — sharp's
own timeout is checked only between strips, and librsvg renders one filtered
element in a single uninterruptible call, so an in-process timeout is not a
bound. Only one upload renders at a time per process (a second one answers
`503 busy`), and each admin may upload 10 marks per 10 minutes. Every icon
and launch image is then cut, in process, from the PNG the child returned.

### Which brand a request wears

The rule is pure in `src/lib/brandRule.ts`; `src/lib/hostBrand.ts` reads the rows:

1. **Signed out** (the manifest, `<head>` icons, launch images, share card,
   JSON-LD — anything fetched without cookies): the organization whose
   `publicHost` is exactly the request's host (`prisma/set-public-host.mjs`),
   **if** it is the product that host serves **and** it carries at least one
   brand field. Otherwise the vertical's default.
2. **Signed in** (theme-color, `<html data-accent>`, the mark in the chrome):
   the person's **own** organization — never the host's.

Each field then falls back to the default on its own. A request whose brand is
the default takes **exactly the code path it took before #2922** — that is how
a deployment where no organization carries brand data renders byte-identical
pages, manifests and mail.

A worked, synthetic example: an organization *Acme Sales* (MARKETING) mapped to
`acme.example.test`, with `brandColor` `#0e7490`, tile `#1e293b`, accent
*Organization colour* and an uploaded mark. A visitor on `acme.example.test`
installs "Acme Sales" with a teal tint and the generated icons; its members see
the teal palette and the mark when signed in; every other host is unchanged.

Rows are cached for 60 s per process and cleared in-process on every brand
write. `node prisma/set-public-host.mjs --list` prints, per mapped host, which
brand fields its organization carries (set / not set — never the values) and
warns when a mapped organization carries none.

**Known limit.** The manifest and icons are per *host*: a second organization of
the same product on the same host sees its own brand in signed-in chrome, but
installs the host's. Per-tenant install branding needs a per-tenant host.

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
| Manifest, favicon, apple-touch icon, iOS launch images, share card, JSON-LD logo (#2922) | `hostBrand()` → `src/app/manifest.ts`, `src/lib/brandMetadata.ts`, `src/lib/ogCard.tsx`, `PublicShell` | the organization mapped to the request's **host** |
| Browser tint, default accent / palette, the mark in the chrome and on the sign-in tile (#2922) | `requestBrand()` → root layout, `/messages` viewport, `BrandProvider` → `BrandMark`/`BrandTile`, account accent picker | the signed-in user's `orgId`; signed out, the host's |
| Push notification icon (#2922) | `sendPushToUser()` (`src/lib/webPush.ts`) | the recipient's `orgId` |
| Mail logo when no logo URL is set (#2922) | `emailBrand()`, the newsletter | the recipient's `orgId` (absolute, on its own host) |

## What is NOT branded yet

Named here rather than implied, so nobody has to read the code to find the edge
of the feature:

- **The product name in copy and page titles.** The `<title>`, the landing
  copy, `llms.txt` and the OpenAPI title still read the vertical's product name;
  moving them onto the resolver is the follow-up to #2922. (The installed app's
  name — manifest, `application-name`, the iOS home-screen title — already
  follows a host-mapped brand.)
- **Pre-login surfaces on an unmapped host.** Signed out, the only signal is the
  host: a host no organization claims shows the vertical default.
- **The newsletter archive** (`/newsletters`) renders the issue's *fields*
  natively rather than the mail HTML, so it carries no brand header at all; an
  archive URL has no recipient, and the reader whose session opens it is the
  only org it could honestly show.

`WHITE_LABEL` in `src/lib/entitlementsCatalog.ts` is a **label, not a gate** —
nothing calls `hasFeature()` on it. Enforcement belongs to the entitlement
unification epic; do not add it as a side effect of a branding change.
