## 2026-10-07 — SSO role mapping in the vertical's words (#2839)

- **The MARKETING leak ratchet does not see an enum written in uppercase.** `scripts/check-i18n.ts`
  strips `\bMENT(OR|EE)S?\b` as a *code* before testing a value, so a hint like "No match: MENTEE"
  never counted as a leak and never got an overlay — which is exactly how the SSO card stayed
  undressed after #2558. When a MARKETING screen still reads internship words, also grep the base
  strings of its namespace for `MENTOR|MENTEE|ADMIN` in capitals; `--leaks` will not list them.
- **A component that prints an enum the API returns is a leak the ratchet cannot measure at all.**
  `SsoRoleMappings` rendered `MAPPABLE_ROLES` verbatim. The fix is the one path every other admin
  screen uses, `t.usersAdmin[role.toLowerCase()]` (RoleBadge, `/admin/invite`); do not invent a
  second label map.
- **The role enum is shared by every vertical, so the vertical gate is on the *roles offered*, not
  on the words.** `mappableRolesFor(verticalCapabilities(org.vertical))` in `ssoRoleMapping.ts`;
  the API lists back exactly what it accepts, and the ACS passes the same list to `resolveRole`, so
  a row written before the gate grants nothing — the ADMIN pattern, reused.
- **A MARKETING org's admin needs the marketing host on the *context*, not only on the sign-in.**
  `playwrightRequest.newContext({ extraHTTPHeaders: asHost(MARKETING_HOST) })` — otherwise the
  session callback nulls the session on the wrong world (#2590) and every later call answers 401.
  The ACS round trip takes the same header in both the login GET and the ACS POST.
- **Worktree hygiene for this repo, in one line each.** A fresh worktree has no Prisma client, so
  `npx tsc --noEmit` reports `sampleData does not exist` in `orgSampleProgram.ts` — that is a stale
  client, run `npx prisma generate`. `next lint` inside a nested worktree fails with *Plugin
  "@next/next" was conflicted* because it also finds the parent checkout's `.eslintrc.json`; lint
  the changed files with `npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to .
  <files>` instead. The SSO e2e specs run locally against the memory'd e2e DB one-liner, stub IdP
  included, in about a minute.
- **zsh traps hit again.** A word that starts with `=` (`echo ======`) is zsh's `=command` path
  expansion and dies with "not found" — quote it. `${PIPESTATUS[0]}` is bash; in zsh it is
  `$pipestatus[1]`, and the bash spelling silently expands to nothing.
