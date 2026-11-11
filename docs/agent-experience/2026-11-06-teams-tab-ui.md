# 2026-11-06 — Rendering a shell's page in another layout

- **An App Router page component can be rendered from another route.** `import MentorDashboard
  from '@/app/mentor/page'` works when the new route supplies what the original layout supplied:
  here `PipelineStagesProvider` and `EvaluationCriteriaProvider`. Copy the layout's gates (the 2FA
  policy) explicitly; importing the page does not bring them along. The i18n scope scan follows
  the import, so the new `<I18nScope>` gets the page's namespaces without anything extra.
- **`@microsoft/teams-js` `app.initialize()` may never settle outside Teams.** Race it against a
  timeout before falling back to the plain screen.
- **A web server timeout in Playwright can be a stopped database.** After a container restart,
  MariaDB is down, and the app's health URL answers 500 until Playwright gives up. Run
  `DEBUG=pw:webserver` to see the `Can't reach database server` lines, then `service mariadb start`.
- **Pin a dependency to a release at least two weeks old** (`npm view <pkg> time --json`). Then
  run `check:licenses -- --write` and the audit gate on a real `audit.json` in the same PR.
