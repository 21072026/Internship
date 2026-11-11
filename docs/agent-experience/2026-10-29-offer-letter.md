## 2026-10-29 — offer letter PDF + click-to-accept record (#1857)

- **pdf-lib's standard fonts are WinAnsi: `ş ğ ı İ Ğ Ş` throw at `drawText`.** Any PDF that
  prints a Turkish name needs a fold (`pdfSafeText()` in `src/lib/offerLetter.ts`) or an embedded
  TTF via fontkit. `certificatePdf.ts` does not fold yet — a certificate for "Ayşe" is worth checking.
- **A module a `node --test --experimental-strip-types` test imports must not have runtime
  relative imports** (`./money` fails: Node wants `./money.ts`, and tsconfig does not allow TS
  extensions). Keep the rule module dependency-free and inject the dependency
  (`compensationLine(offer, labels, money)`), with `import type` for types only.
- **`check:erasure-coverage` fails on every new free-text column** until it gets a decision in
  `scripts/check-erasure-coverage.mjs` — personal text also needs a clear in `accountErasure.ts`.
- **A second worktree can share `node_modules` by symlink**, but `prisma generate` there rewrites
  the shared client — only do it while no dev server from the other tree is running.
- **The first request to a pdf-lib route on `next dev` compiles for most of a minute**: a spec
  that downloads a PDF needs `test.setTimeout` above the default 60 s.
