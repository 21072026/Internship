# 2026-10-30 — Certificate-ready notice (#1410)

- **Read the code before the issue.** #1410 (2026-08) asked for the portal certificate card,
  the mentee-only read path, the empty state and a notification; the first three had already
  shipped with `PortalCertificateCard` (#3082) without closing the issue. Grep a component name
  the route comments mention before planning — here only item 4 was left.
- **Notification params cross locales.** A certificate's title is in the *generator's* chosen
  locale, the notification renders in the *reader's*; passing the title would mix languages.
  Keep the template self-contained and send no params.
