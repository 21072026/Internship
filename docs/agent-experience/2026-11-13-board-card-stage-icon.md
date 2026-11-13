## 2026-11-13 — board card stage picker drawn as an icon (#3667)

- **"Remove this control" on a board card is a space complaint, not a licence to drop the
  drag-and-drop alternative.** `CardStageSelect` is the only stage-move path on the phone list
  and is cited as evidence by two VPAT rows (`src/lib/vpat.ts`, 2.5.1 / 2.5.7) and three e2e
  specs via `getByLabel('Move to stage')`. Keeping the native `<select>` at `opacity-0` over an
  icon frees the row and leaves all of those untouched — Playwright treats an `opacity: 0`
  element as visible, so `selectOption` still works.
- **`npx tsc --noEmit` aborts with a V8 heap OOM in the web container at the default limit.**
  Run it as `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`.
- **Release-fragment `notes.<locale>` is an array of strings, not a string** —
  `check:release-fragments` says so, but only after you have written it wrong.
