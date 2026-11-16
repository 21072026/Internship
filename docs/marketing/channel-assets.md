# Reusable channel assets (#2225)

These exports reuse the canonical `scripts/capture-landing-screenshots.mjs`
producer from #1399. They do not replace the landing tour's WebP/video assets.
All product images are real browser captures of a fresh **local**
`prisma/seed-demo.mjs` database; never use shared preview or production.
See [data-access policy](../DATA_ACCESS_POLICY.md).

## Capture matrix

The issue requests six surfaces, with EN/DE and light/dark cuts but does not
require all 24 combinations. This is the six-file matrix: both languages and
themes across the set, plus two German light screenshots for the one-pager.
Every PNG is **2880×2000**, a full **1440×1000 CSS viewport at 2x**, with no
browser chrome, identical viewport framing, no video actions and lossless compression.
The profile view scrolls to its profile/content cards; first-run tours are
dismissed through their normal UI before capture.

| File under `public/screenshots/` | Surface / synthetic identity |
|---|---|
| `pipeline-de-light.png` | Mentor pipeline / `mentor.aylin@demo.example.com` |
| `mentee-profile-en-light.png` | Gizem's profile/evaluation / same mentor |
| `interaction-log-en-dark.png` | Mentor interaction log / same mentor |
| `weekly-report-de-light.png` | Gizem's weekly reports / same mentor |
| `talent-pool-de-dark.png` | Company talent pool / `company.1@demo.example.com` |
| `admin-analytics-en-dark.png` | Admin analytics / `admin.demo@demo.example.com` |

## Reproduce safely

Use a **new, empty local database whose name ends in `_demo`**, never an
existing development database that might contain imports. The example below
assumes a disposable local MySQL instance on port 3325. Supply your own local
credentials if needed; do not copy a deployment environment file.

```bash
export DATABASE_URL='mysql://root@127.0.0.1:3325/channel_assets_demo'
export NEXTAUTH_URL='http://localhost:3025'
export NEXTAUTH_SECRET='local-synthetic-capture-only'
export DEMO_MODE=true
export NEXT_PUBLIC_APP_ENV=production
export MARKETING_HOSTS=marketing.localhost
export CRON_ENABLED=0
export JOBS_WORKER_ENABLED=0
export INBOUND_IMAP_ENABLED=0
export ERROR_TRACKING_DSN=''
export SMTP_USER=''
npm ci
npx playwright install chromium
npx prisma generate
npx prisma db push
npm run seed:demo
NODE_OPTIONS=--max-old-space-size=8192 npm run build
npm run start -- --hostname 127.0.0.1 --port 3025
# In a second terminal with the SAME DATABASE_URL and other environment values:
BASE_URL=http://localhost:3025 npm run capture:landing -- --channels
BASE_URL=http://localhost:3025 node scripts/generate-channel-assets.mjs
```

The producer refuses non-local browser origins or a non-local/non-demo database;
it checks that all accounts use `@demo.example.com` and have no phone, CV or
avatar. Use the same database for the server and producer. Inspect every output:
names/free text must come from the seed, emails must be demo addresses, and
there must be no real document, message, phone or credential. The automated
address check is only one part of this review, not proof about arbitrary text.
Demo dates are relative to the seeding date; reset to a fresh seed to regenerate
the same composition, and record the capture date in the PR.

The PNG producer fully decodes each result, checks its dimensions and enforces
a 1200 KiB ceiling. The landing's existing 200 KiB WebP budget is unchanged;
these retina PNGs are download assets, not embedded in a page's loading path.

## LinkedIn exports

`node scripts/generate-channel-assets.mjs` rasterizes the existing
`public/icon.svg` and the German tagline from [copy bank §8](copy-bank.md#8-linkedin-şirket-sayfası--tagline-ve-about):

- `public/marketing/linkedin-banner.png`: **1128×191**, requested by #2225.
- `public/marketing/linkedin-logo.png`: **300×300**.

The banner reserves its lower-left for the platform logo overlay. The current
[LinkedIn playbook](linkedin-playbook.md) recommends **1512×256** rather than
the issue's older size; this export deliberately follows the explicit #2225
requirement. It makes no claim to be the current platform recommendation.
No customer counts, testimonials or certification claims appear.

## German one-pager

The same generator reads **copy-bank.md §11** at generation time, preserves
its section order and capability/claim limits, and places exactly two product
screenshots: `pipeline-de-light.png` and `weekly-report-de-light.png`.
The issue's explicit two-image requirement takes precedence over the copy
bank's older three-image suggestion. No unverified price or “Preise auf Anfrage”
is printed. Address/contact placeholders are replaced by the public imprint
link, rather than invented operator details. It is a reviewable export, not
a publication or outreach action.

Outputs (not committed):

- `/tmp/interncrm-channel-assets/interncrm-one-pager-de.html`
- `/tmp/interncrm-channel-assets/interncrm-one-pager-de.pdf`
- `/tmp/interncrm-channel-assets/one-pager-preview.png`

Override `CHANNEL_OUTPUT_DIR` to retain the output elsewhere. The generator
requires exactly one A4 PDF page and exactly two screenshot elements. Open the
PDF and inspect its rendered page for clipping before distribution. The
canonical text is deliberately read from the copy bank, so future changes are
not silently copied into another text source.

## Existing OG card

#1378 already delivered `src/app/opengraph-image.tsx` and the shared
`src/lib/ogCard.tsx` renderer: **next/og ImageResponse, 1200×630**, local/default
fonts, the public title/description and internship theme color **#1D4ED8**.
No replacement runtime or metadata is needed. Validate `/opengraph-image` on
the local internship host and decode its PNG; also verify the landing HTML's
absolute `og:image`. Keep exported validation images in the output directory,
not as a second static card in `public/`.

## Release decision

The new public download assets get a patch fragment. The existing application
UI, metadata, OG renderer and dictionaries are unchanged; the exports introduce
no business logic or new integration. No app release-note highlights are added
for internal channel-production tooling.
