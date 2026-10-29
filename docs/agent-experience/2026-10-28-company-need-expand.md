## 2026-10-28 — CompanyNeed → Requisition, expand step only (#1875)

- **An issue written before a vertical existed can break that vertical.** #1875 (2026-08)
  assumed CompanyNeed was internship-only; MARKETING since reused it as "account needs" in the
  company form, and `/admin/requisitions` is a `placements` page MARKETING does not have.
  Grep the overlays (`src/i18n/verticalOverlays.ts`) for a namespace before retiring its
  feature — the vertical-terminology spec asserts those strings.
- **A delete-and-recreate write turns an id-keyed backfill into a duplicator.** The company PUT
  recreated every CompanyNeed under new ids on each save, so `legacyCompanyNeedId` matched
  nothing and every deploy could mint another OPEN requisition. Look for `deleteMany` +
  `create` of the rows a converter keys on before trusting "idempotent".
- **The local DB e2e recipe in the newest retros still works**, but seven DB-heavy specs took
  18 min against `next dev`; the Bash foreground limit is 10 min, so run them in the background.
