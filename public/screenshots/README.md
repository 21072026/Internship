# Landing product screenshots and clips (#1399)

The screens in the landing page's product tour
(`src/components/landing/ProductTour.tsx`). Each product shows its own three:

- **Internship** (interncrm.com): `mentee` (the journey), `mentor` (the board)
  and `company` (a candidate view).
- **Marketing / SaleVali** (the marketing host): `mkt-pipeline` (the funnel
  board), `mkt-rep` (a sales rep's dashboard) and `mkt-insights` (funnel
  analytics). They are captured on `marketing.localhost` against the seeded
  `demo-marketing` tenant (`prisma/seed-demo-marketing.mjs`, part of
  `npm run seed:demo`), so the server needs `marketing.localhost` in
  `MARKETING_HOSTS`. Override the host with `MARKETING_BASE_URL` if needed.

Each screen is stored as:

- a still per theme and device: `<screen>-<desktop|phone>-<light|dark>.webp`;
- a short silent desktop loop per theme: `<screen>-desktop-<light|dark>.{webm,mp4}`.
  `TourClip` plays it over the still once the frame is on screen. Phones and
  reduced-motion visitors keep the still.

Every still of a device has the **same size**: the whole viewport, 1600×1000
(16:10) on desktop and 780×1688 (an iPhone's 390×844 at 2x) on phone. That is
what lets all three sit in one identical browser or phone frame. The first
version cropped each screen to its content, and six different aspect ratios
made the tour look improvised. The sizes live in
`src/components/landing/productTourShots.ts`.

**Never edit or hand-crop these files.** They are produced by
`scripts/capture-landing-screenshots.mjs` against the **local** synthetic demo
seed (`@demo.example.com` accounts, no real person appears; see
`docs/DATA_ACCESS_POLICY.md`). The script refuses a non-localhost `BASE_URL`.

## Re-capturing

Re-capture when one of the three screens has changed enough that the landing
would show an old product. The clips change demo data (a card moves stage, a
candidate is shortlisted), so capture one theme at a time on a fresh seed:

```bash
reseed() { npx prisma db push --force-reset --skip-generate && npx prisma db seed && npm run seed:demo; }
npm run build && npm run start               # a production build: no dev-mode badge in the picture
reseed && npm run capture:landing -- --theme=light
reseed && npm run capture:landing -- --theme=dark
npm run capture:landing -- mentee --theme=dark --no-video   # stills only
```

`seed:demo` wants `DATABASE_URL` in the environment. The clips need `ffmpeg` on
`PATH`. The script fails a still over **200 KB** and a clip over **900 KB**.
Captures are in English. The alt text is per language in the `productTour`
block of `src/i18n/dictionaries.ts`; update it if a screen's content changes.

A headless browser draws no mouse pointer and no native drag image, so the
clips add a drawn cursor (and, on the board, a lifted copy of the card). What
happens underneath is the real app: the stage change and the shortlist are
real requests.
