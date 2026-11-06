# 2026-11-06 — one shared unread-message count (#3593)

- **A component that `ResponsiveShell` renders twice does its fetch twice.**
  The mobile bar and the desktop strip both mount the header widgets, and CSS
  hides one of them. The bell (#3573) and `MessagesButton` (#3593) each paid
  this. Before adding a fetch to a header widget, check whether it is mounted
  twice, and if so put the data in a module store (`useSyncExternalStore` plus a
  refcount, see `notificationFeed.ts` / `messagesUnreadFeed.ts`).
- **Refresh-on-navigation across two instances:** both instances run their
  pathname effect in the same commit. One in-flight promise, plus remembering
  which pathname was last refreshed, is enough to make that a single request.
- **`visual-regression.spec.ts` fails locally on the signed-out landing page**
  (about 5% of pixels differ: local fonts and local DB stats). It also fails on
  main locally, so don't chase it for a header change. CI is where its
  baselines hold.
- **MariaDB is not running after a container restart:** start it with
  `service mariadb start` before running e2e against `next start`.
