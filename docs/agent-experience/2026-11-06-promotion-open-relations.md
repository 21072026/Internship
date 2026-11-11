## 2026-11-06 — promotion to mentor and open mentee relations (#1506)

- **Read the code's own exceptions before applying a general rule.** CLAUDE.md pairs
  `sessionsValidFrom` with `revokeAllTrustedDevices()`, but `src/lib/trustedDevice.ts:224` and the
  role-convert path document why a role change stamps the cutoff only to rotate claims: the
  remembered device's refresh reads the user fresh and mints the new role. The mentor-application
  promotion was missing the stamp itself — that was the gap.
- **One refusal shape for two paths.** Both promotion paths answer `400
  promotion_choice_required` with the same `openRelations` summary, so one client component
  (`PromotionRelationsChoice`) serves the role-convert panel and the application page.
- **New `*.mentee*` copy is a MARKETING leak too.** Strings naming mentor/mentee need a
  MARKETING overlay entry (rep/lead) in all three locales, or `check:i18n`'s ratchet fails.
- **Close relations through the lifecycle write, not a status flip.** A guarded `updateMany` plus
  a `RelationLifecycleEvent`, then `raiseLifecycleChanged` after the commit — the pairing then
  reads exactly as if it had been ended on its own screen.
