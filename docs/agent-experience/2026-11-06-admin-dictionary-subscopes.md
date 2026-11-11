# 2026-11-06 — admin dictionary per section (#3599)

- **Measure the scope before splitting it.** `npx tsx` with a small script that
  imports `toClientDictionary` and `scopes.generated.ts` gives KB per namespace.
  After the split, the admin chrome was still 202 KB, and almost all of it came
  from false positives, not from real reads.
- **The scanner's biggest false positives are data, not reads:** nav keys
  (`key: 'settings'`), permission names (`'org.settings.write'` matches
  `.settings`), and tour step keys. `--why=<ns> --scope=<id>` names the file
  in seconds.
- **A console-error crawl is the cheapest completeness check.** When a
  namespace is missing, `guarded()` logs `[i18n] namespace "x" was not
  shipped`. Visit every static admin route plus the sidebar's client
  navigations with Playwright, and collect those lines.
- Signing in through `page.request` shares cookies with the page, so there is
  no need to click through the form for a crawl.
