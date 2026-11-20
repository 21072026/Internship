## 2026-11-16 — reusable marketing channel exports (#2225)

- **Reuse the existing screenshot producer and OG renderer.** #1399 already
  supplies `scripts/capture-landing-screenshots.mjs`; #1378 already supplies
  `src/app/opengraph-image.tsx` and `src/lib/ogCard.tsx`. The issue's older
  “no product image / no root OG” snapshot is no longer current.
- **A fresh seed triggers first-run tours.** Dismiss `tour-skip` through the UI
  before capturing; a ready product card can still be covered by an overlay.
  Wait for an analytics element available on the seeded plan, not the premium
  `full-report-link` that the free demo does not render.
- **Check installed dependencies against the lockfile before media work.**
  A stale Prisma client rejected `vertical`; stale Next/Playwright installs
  needed `npm ci`, explicit `prisma generate` and the matching Chromium.
- **Validate the printed PDF, not only its HTML preview.** The first layout
  overflowed onto a second page. Require one A4 page and two screenshot
  elements, then render the actual PDF to inspect its typography and edges.
- **Use a private temporary directory for generated exports.** CodeQL flagged
  the fixed `/tmp/interncrm-channel-assets` HTML/PNG writes as insecure temporary
  files (#77/#78). `mkdtempSync(path.join(os.tmpdir(), prefix))` prevents another
  local user pre-creating the output path as a symlink; document the printed
  random output path instead of assuming a fixed directory.
