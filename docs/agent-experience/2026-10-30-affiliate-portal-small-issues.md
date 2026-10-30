# 2026-10-30 · Affiliate portal: three small issues (#3348, #3349, #3350)

- **A worktree has no `node_modules` or `.env`.** Symlink `node_modules` from the main checkout and copy `.env`
  (both are gitignored). `src/i18n/scopes.generated.ts` is also missing: run `node scripts/i18n-scopes.mjs`
  once, or `tsc` reports `Cannot find module './scopes.generated'`.
- **A worktree-isolated agent's shell is picky.** Compound commands that mix `cd`, heredocs, pipes into `python`
  or the word `source` in a grep pattern were refused as "cannot verify it stays inside the worktree". Run plain,
  separate commands, and use Write/Edit for file content instead of heredocs.
- **macOS `sed -i` needs `-i ''`.** `sed -i -e …` treats `-e` as the backup suffix and fails with "No such file".
- **The `affiliatePortal` block exists three times** in `dictionaries.ts` (EN/TR/DE) and its keys are not
  unique in the file (`colStatus`, `payoutsTitle` appear in several namespaces). Anchor an edit on the block's
  opening line, not on a bare key, or use line numbers re-read after every branch switch (the issue's line
  numbers were already stale).
- **Partner-visible wording lives in its own namespace.** The admin namespaces already had `kindTIER` etc.;
  the portal got its own keys rather than reusing them, so the partner copy can differ from the admin's.
- **Imported commissions carry `planVersion` 0.** Any screen that prints a plan version must hide it for
  `IMPORTED` rows.
