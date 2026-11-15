## 2026-11-13 — API key scopes follow the vertical (MKT-6b)

- **Put a vertical rule for the public API in the door (`withApiKey`), not in each route.**
  Check it after the org is bound (`shellCapabilities(orgId)`), then pass the handler
  `effectiveScopes()` instead of the stored list. Routes that pick their scope per request
  (exports via `requireApiScope`, `/me`) then follow the rule without being edited.
  `keyMayRead()` (export links) asks the door's questions a second time, so it needs the
  same filter.
- **A new `ApiErrorType` must also go into `ERROR_STATUS` in `src/app/developers/page.tsx`.**
  That map is a `Record` over the union, so the typecheck fails until you add it. The same
  goes for the OpenAPI error description string.
- **Check-script maps parsed out of a TS file need their comments stripped first.**
  `SCOPE_CAPABILITY`'s comments quote scope names, so the script strips `//` lines before it
  pattern-matches `'key': 'value'` pairs. Prove a new guard fails, not just that it passes:
  add a fake `/api/v1/widgets` directory and a fake scope, run it, revert.
- **Some files are another worker's lane.** `/api/company/*` (MKT-2) was off-limits, so
  company-key issuance was not changed. The door still refuses those keys, because
  `withApiKey` covers every key whoever minted it.
