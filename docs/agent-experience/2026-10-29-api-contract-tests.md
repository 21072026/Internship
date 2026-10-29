## 2026-10-29 — /api/v1 and webhook contract tests (#1611)

- **Check that a contract test can fail before trusting a green run.** The response-contract
  spec passed on its first run. To make sure it was really checking something, I removed one
  property from a published schema and reran it: it named the field in both the list and the
  item response. Then I put the property back.
- **Seed rows directly when a route's own create path would need the network.** `POST
  /api/v1/hooks` resolves the target through the SSRF guard (DNS), so the spec writes the
  `Webhook` row with the key's `apiKeyId` instead. Likewise for an `ApiExport` and an
  `ApiImport` row.
- **`ApiKey.scopes` cannot hold every scope at once.** Mint the union of the scopes the
  operations under test declare (read them from the spec's `security`), not the whole list.
- **A webhook signature can be tested with no network.** Stub `globalThis.fetch` and use a
  public IP literal as the target: `assertPublicHttpsUrl` skips DNS for a literal.
- **zod v3 has no JSON Schema export here.** `src/lib/events/payloadSchema.ts` walks `_def`
  for the handful of constructs the catalogue uses and throws on anything else, so nothing
  gets published as "any".
