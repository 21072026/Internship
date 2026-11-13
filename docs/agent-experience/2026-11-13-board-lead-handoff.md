# 2026-11-13 — board lead hand-off strip

- `npx tsc --noEmit` OOMs at the default heap in this container; run it with
  `NODE_OPTIONS=--max-old-space-size=8192`.
- A rep-to-rep hand-off reuses `transferMentorship()` rather than a new owner
  write: `batched: true` silences the mentorship-worded mentor notices (send your
  own), and the new `quietMentee` keeps a MARKETING lead from being told its
  "mentor changed". Any future sales-side caller of the transfer wants both.
- A MARKETING-only UI can gate itself on `GET /api/sales/team` answering 403
  (via `salesPoolGate`) instead of reading the vertical on the client.
