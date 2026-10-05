# Landing product screenshots (#1399)

The three screens in the landing page's product tour
(`src/components/landing/ProductTour.tsx`): the mentee journey, the mentor
board and a company's candidate view. Each one is stored four times —
`<screen>-<desktop|phone>-<light|dark>.webp` — because the landing follows the
visitor's theme and gives a phone the phone layout.

**Never edit or hand-crop these files.** They are produced by
`scripts/capture-landing-screenshots.mjs` against the **local** synthetic demo
seed (`@demo.example.com` accounts — no real person appears, see
`docs/DATA_ACCESS_POLICY.md`). The script refuses a non-localhost `BASE_URL`.

## Re-capturing

Re-capture when one of the three screens has changed enough that the landing
would show an old product.

```bash
npx prisma db push && npx prisma db seed
DATABASE_URL=… npm run seed:demo        # the demo seeder wants DATABASE_URL in the environment
npm run build && npm run start          # a production build: no dev-mode badge in the picture
npm run capture:landing                 # all three; or: npm run capture:landing -- mentor
```

The script prints each file's pixel size and fails a file over **200 KB**. Copy
the printed sizes into `src/components/landing/productTourShots.ts` in the same
commit — they are the images' `width`/`height`, which reserve the space before
the file arrives (no layout shift).

Captures are crops of the content area (no sidebar, no top strip), at
1440×900 @1x for desktop and 390×844 @2x for phone, in English. The alt text
is per language in the `productTour` block of `src/i18n/dictionaries.ts` —
update it if a screen's content changes.
