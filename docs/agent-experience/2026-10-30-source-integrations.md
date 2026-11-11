# 2026-10-30 — SOURCE owners' API keys and webhooks (#2006)

- **"Same model as company" meant twin files, one shared screen.** The rules
  (`sourceApiKeyRule.ts`, `sourceWebhookRule.ts`) and scopes mirror the company
  ones; the UI was extracted into `src/components/integrations/OwnerApiKeys.tsx`
  / `OwnerWebhooks.tsx` and both pages pass an `endpoint` and labels. The
  data-test ids stayed `company-*`, so no company spec changed.
- **Two owner checks compose in one place.** `ownerReceiverCheck()` in
  `webhookDelivery.ts` ANDs the company and source checks (each returns true
  for a hook without its owner field), and replay uses the same function.
- **A `Webhook` already has a `source` String column** (origin: admin/api/company),
  so the Source relation is named `ownerSource`. Check for a field clash before
  naming a relation after its model.
- **`user.created` is the cheapest real producer for a source test:**
  `POST /api/source/mentees` as the SOURCE user raises it with the mentee's id.
- **Main moves every few minutes on this repo.** Re-check that the branch
  contains `origin/main` right before merging; when only docs moved in between,
  the earlier full check run still stands.
