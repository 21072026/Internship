## 2026-11-05 — announcement reach (#1921, slice 2)

- **The feature may already half-exist under another issue.** #1721 had shipped per-announcement
  read counts from the bell rows. The remaining value was honesty: withhold the count below a
  privacy floor and once the retention sweep has thinned the rows. Grep the route before
  planning columns.
- **A count over rows a sweep deletes needs the sweep's own window.** Resolving the retention
  setting twice risks the history and the sweep disagreeing, so the resolver moved out of the
  heavy `retentionEntries.ts` into `src/lib/notificationRetentionWindow.ts` and both import it.
- **A report `Row` is `string | number | null`.** A `Date` in a `type: 'date'` column fails the
  type check; pass an ISO date string.
- **A floor changes existing assertions.** `announcements-feed.spec.ts` asserted `read: 1` for a
  one-recipient announcement; with the floor it reads `read: null, readWithheld: 'small_audience'`.
  Update such specs in the same PR and say why in the comment.
