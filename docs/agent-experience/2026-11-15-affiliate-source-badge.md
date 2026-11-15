## 2026-11-15 — affiliate badge on the lead and the partner's lead count (#3647)

- **`Source` is unique per `(orgId, name)`.** A partner's leads all share the one
  `affiliate:<code>` source, so an e2e seed that creates a `Source` per lead fails on the
  second lead with `Source_orgId_name_key`. Find it first, then create.
- **Resolve a badge's label in one query for the whole list.** The board API returns many
  relations. Collect `(orgId, code)` pairs, read the partners once, and key the map by
  `orgId\0code`. A code alone is not enough: two tenants may hand out the same code, and the
  name must never cross between them.
- **A partner portal counts, it never lists.** Use a user count plus a relation `groupBy` on
  the stage, scoped by the mentee's source `{ orgId, name }`. No row reaches the page, so no
  name, contact or company can leak. The @smoke spec asserts the lead's name is absent.
- **`--last-failed` names the one failure that a filtered gate log hid.** Grepping only the
  summary lines dropped the failing test's title. `test-results/.last-run.json` still held it,
  and `npx playwright test --last-failed` reran exactly that test.
