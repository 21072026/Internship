# 2026-10-28 — stage automation builder (#1704, 2/2)

- **A full DB e2e in this container took ~10 minutes to set up and was worth it**:
  apt MariaDB per `docs/security-audit-playbook.md`, `.env` from the playbook,
  `prisma db push`, start `npm run dev` yourself, `set -a; . ./.env; set +a` before
  `npx playwright test`. The pinned headless shell was `-1248` while `/opt/pw-browsers`
  held `-1243`: `ln -sfn …-1243 …-1248` for both `chromium` and
  `chromium_headless_shell`. The job worker ticks inside `next dev`, so an
  event → subscriber → AutomationRun round trip is observable with `expect.poll`.
- **A `<select>` option counts for `getByText`**: a run-log filter listing rule names
  made `getByText('<rule name>', { exact: true })` resolve to 2 (the `<option>` and the
  row). Scope to the list item (`log.locator('li')`).
- **The MARKETING leak ratchet catches help text too**: every new admin string that
  says mentor/mentee needs a MARKETING overlay (rep / lead) in all three locales, and
  a feature-catalogue `items` overlay must go INSIDE the existing `items: {` of that
  locale's `featureCatalog` block — a second `items` key is a TS1117 duplicate.
- `check:i18n` / `test:unit` were red on main from a sibling (`WebhookDelivery` erasure
  decision, #1695) while this ran — `git stash` and compare before chasing it.
