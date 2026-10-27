# 2026-10-27 — Group sessions screens (#1856, 2/4)

- **A new mentorship-only i18n namespace trips the MARKETING leak ratchet at once.** Either
  argue it into `LEAK_EXEMPT` in `scripts/check-i18n.ts` (only when every page *and* API that
  renders it is capability-gated) or overlay it. A `featureCatalog` card is never exempt even
  when tagged `capability: 'mentorship'` — it needs a MARKETING overlay entry in all three
  locales of `src/i18n/verticalOverlays.ts`.
- A new nav key needs an icon in `apps/mobile/src/lib/menu.ts` (`cd apps/mobile && node --test
  --experimental-strip-types src/lib/*.test.ts`), and a capability-tagged nav link needs the
  page closed with a segment `layout.tsx` calling `gatePage(href)`.
- `Textarea` (`src/components/ui`) has no `label` prop, unlike `Input`/`Select` — wrap it.
- Playwright 1.64 wants browser revision 1248, the box has 1243: symlink both
  `chromium-1248` and `chromium_headless_shell-1248` to the 1243 contents.
