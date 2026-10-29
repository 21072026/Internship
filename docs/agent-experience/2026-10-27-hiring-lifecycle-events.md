# 2026-10-27 — hiring lifecycle events on the bus (#1998)

- **Grep the "REGISTERED but not dispatched" comments first.** Before `emit()` existed,
  every hiring route left a comment where its event belonged (`grep -rn "REGISTERED in
  WEBHOOK_EVENTS" src`). They are the work list — and the comment is replaced by the call.
- **"Fires on every writer" includes the second writer of a *description*.**
  `interview_panel.completed` says "every interviewer scored, *or an admin closed it*",
  but only the score route raised it; the close route needed it too, guarded so a panel
  already complete through scores is not announced twice.
- `*.unit.spec.ts` run without the dev server: `BASE_URL=http://localhost:9 npx playwright test …`.
- **Put the emit in the shared helper, not the route.** `meeting.cancelled` lives in
  `cancelMeetingRows()` (`src/lib/meetingCancel.ts`), so the meeting PATCH and the
  interview-request cancel cannot diverge. The helper now takes `orgId` explicitly —
  `Meeting` has no `orgId` column to read it from.
- **A DELETE is a cancellation from the receiver's side** when the row was still
  `SCHEDULED`; deleting an already-cancelled row is not announced again.
- **Never `emit()` from inside an interactive transaction.** `emit()` writes through the
  global client, so a rolled-back caller would leave a ghost event. For the stage writer
  (which always runs in its caller's tx) the move is *noted* in an `AsyncLocalStorage`
  and `stageTransaction()` raises it after `prisma.$transaction` resolves; noting
  outside the wrapper throws in dev, so a forgotten caller is a red test.
- **A new public event also moves the webhook contract snapshot** (#1611):
  `scripts/test/fixtures/webhook-payloads.json` pins every public payload, and
  `scripts/test/webhook-contract.test.mjs` (in `npm run test:unit`) fails on an added
  entry too. Regenerate with `UPDATE_WEBHOOK_CONTRACT=1 node --test --experimental-strip-types
  scripts/test/webhook-contract.test.mjs` in the same PR as the catalogue entry, and check
  the diff is additions only. Two of my slices merged without it and turned main red.
- `pkill -f "next dev"` inside a Bash command kills that command's own shell (its command
  line contains the pattern; exit 144). Use `kill $(pgrep -f 'next de[v]')`.
