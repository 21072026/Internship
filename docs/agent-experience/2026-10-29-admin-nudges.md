## 2026-10-29 — /admin/nudges builder (#1686)

- **The first dev-server visit to a new route compiles for 15–20 s** — longer than a
  Playwright `expect(...).toContainText` timeout. A spec that fails on its first assertion
  after a click into a never-compiled route may pass on the second run; warm the route
  (curl it) before blaming the code.
- **A spec process cannot follow the mailer's lazy `import()`s** (`Cannot find module
  '@/lib/emailSuppression'`): `runNudgeSend()` on an EMAIL rule from a spec fails before
  sending. Switch the rule to IN_APP in the spec; pin the mail path elsewhere.
- **A demo-blocklist pattern can leave a read-only POST open with a negative lookahead**:
  `/^\/api\/admin\/nudges(?!\/[^\/]+\/preview$)/` blocks every write but the dry run, and
  `check:demo-blocklist` accepts it.
- **New admin namespace + mentor/mentee wording = MARKETING leak ratchet.** A screen gated on
  the `mentorship` capability goes into `LEAK_EXEMPT` with that argument (gatePage +
  requireCapability), rather than overlay entries nobody will ever render.
