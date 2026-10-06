# Saved views (#1900)

A saved view is a named filter preset on an admin list. Since #1900 it lives on
the server (`SavedView`), so it follows an admin to another device and can be
shared with the team.

- **Surfaces** — a view belongs to one list, named by a key from
  `SAVED_VIEW_SURFACES` (`src/lib/savedViews.ts`): `candidates`, `mentorship`,
  `board`, `mentors`, `companies`, `requisitions`, `users`, `analytics`. A free
  string would let a typo orphan a view; a new list adds its key there and
  passes `surface` to `<SavedViews>`. Wired today: candidates, mentorships,
  board, mentors, companies, users.
- **Visibility** — `PRIVATE` (the author only) or `ORG` (every admin of the
  org). No per-person sharing lists.
- **Who may change one** — only its author (or a super admin), whatever its
  visibility: `PATCH`/`DELETE /api/admin/saved-views/[id]` answer **403** to a
  colleague and **404** to another tenant. Checked in the handler — the chip
  offering no ✕ is presentation, not authorization.
- **API** — `GET /api/admin/saved-views?surface=…` (own views + the org's shared
  ones), `POST` (same author + surface + name replaces, as the old presets did),
  `PATCH`/`DELETE …/[id]`. ADMIN only; `SavedView` is in `TENANT_MODELS`.
- **Filters** — the list page's own state, stored as string → string
  (`sanitizeViewFilters`: at most 30 keys, values capped). A view is only ever
  applied back to the page it came from, which validates each value as it sets
  it.
- **The old presets** — on the first load of a surface with no server views of
  the admin's own, the browser's `localStorage` presets for that list are posted
  as `PRIVATE` once and the key is removed. Nobody loses what they had.
- **The mentor's own list** (`/mentor/mentees`) keeps browser-only presets: the
  API is admin-only, and `<SavedViews>` without a `surface` is the original
  localStorage component.
