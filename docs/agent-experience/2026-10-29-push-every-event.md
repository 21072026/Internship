## 2026-10-29 — push as a router channel (#1715)

- **Moving a legacy `notify()` call onto `notifyEvent()` is not free when the call passes
  extra params.** The router keeps only the catalogue's declared `params`; `stage.changed`
  passes `fromLabel`/`toLabel` that `renderNotification()` reads, so routing it would have
  printed raw stage keys in the bell. Check the call's params against the entry before
  migrating — that one stays on `notifyIfAllowed()` until the catalogue declares the labels.
- **A "never push X" rule belongs in the catalogue test, not a comment.**
  `scripts/test/notification-catalog.test.mjs` now fails when a digest / report / newsletter
  or `batched` event lists `push` — it caught `deadline.slaEscalated` (batched) on the first run.
