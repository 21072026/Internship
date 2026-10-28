# 2026-10-27 — Upgrade prompt from the 403 body (#1745)

- **Old issue bodies drift.** #1745 named `src/lib/pricing.ts`; prices actually live in `src/lib/plans.ts` (`PLANS`, `planIncludingFeature`, `LEGACY_PLAN_MAP` for the legacy `Organization.plan` that `planGate` still reads). Grep before you build what the issue tells you to import.
- **`pricing` is a SERVER_ONLY i18n namespace** — a client component cannot read `t.pricing.feature`. The client-side feature labels are `t.entitlements.features`.
- **A new operator string with "mentor/mentee" trips the MARKETING leak ratchet** even when the surface is internship-only in practice; a two-key overlay in `verticalOverlays.ts` is cheaper than arguing a LEAK_EXEMPT.
- **`fillTemplate` lives in `src/components/ui/fillTemplate.ts`** and returns `ReactNode[]`, not a string.
- **After `git checkout` onto a newer main, run `npm ci` as well as `prisma generate`**: a dependency bump on main showed up as `tsc` errors in an untouched file (`ssoMetadata.ts`).
- **The local MariaDB does not survive a container restart** — `service mariadb start` again; a schema that moved meanwhile needs `db push --accept-data-loss` on the LOCAL DB only.
