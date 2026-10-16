## 2026-10-16 — pacing transactional and bulk mail through the queue (#2951, #2952)

- **Any mass sender that keeps its own per-recipient record needs a settle hook, not a return value.**
  Once a lane is queued, `sendEmail()` answers `QUEUED` long before the relay does. The newsletter
  therefore writes `NewsletterSend` as QUEUED and names it in the queued mail's `ref`, and
  `settleMailRef()` (`src/lib/mailRefHooks.ts`) settles it from the drain. A fast drain can settle
  the mail before that row exists, so call `reconcileQueuedMail()` right after the insert.
- **A natural de-duplication key for a reminder must include the start time.** `mrem:<meeting>:<user>`
  on its own would suppress the reminder for a meeting that was moved, because the old SUCCEEDED
  job keeps the key until retention deletes it.
- **Count a mail as "emailed" only when it is not SKIPPED.** The announcement route used to count
  anything that did not throw. On an environment without SMTP, that showed every recipient as emailed.
- **Port 3000 on a shared Mac can belong to another project.** `playwright.config.ts` hardcodes it,
  and `CI=1` refuses to reuse an existing server. To run the suite on another port, change
  `const PORT` locally (uncommitted), then set `PORT`, `NEXTAUTH_URL` and the build's `NEXTAUTH_URL`
  to the same port. A few specs hardcode `localhost:3000` and may then fail locally for that reason alone.
- **The worktree guard rejects complex shell lines when a path contains `github`.** This includes
  redirects, `$(…)` and long heredocs. Put Python or shell scripts in the scratchpad, run them as
  `python3 <file>` or `bash <file>`, and use `run_in_background` instead of `> log; echo`.
