## 2026-11-26 — why MARKETING staff got no mail (#3966, #3967, #3968)

- **"Staff get no mail" is first a question for `/admin/mail-log`, not for the code.** The org
  admin's mail log (30-day filter, the "Tür" dropdown lists every category with a count) told in
  two minutes what an hour of reading could not settle: SMTP and the crons were fine (security
  and support mails `Gönderildi`), staff assignment mail was simply never *produced*, and every
  invitation was `SKIPPED` by the customer-mail lock. Open it on the tenant's own host in the
  user's browser; a read-only SSH into prod was refused by the session's permission classifier.
- **A lock that places recipients by their account misreads anyone who has no account yet.**
  `customerMailLock.ts` made every MARKETING invitee a "contact", so colleagues could not be
  invited by mail. The fix reads the org's own open `InvitationToken` rows for the address
  (`kindForUnregisteredAddress`, staff only when every open invite is ADMIN/MENTOR) — derived
  from data, never from a flag the caller passes.
- **The marketing relation writers are silent by design; announce at the route, not in the
  writer.** `createMarketingAccount()` also serves the import and the integration ingest, which
  create leads by the hundred. Notifying there would mail per row; `announceLeadAssigned()` is
  called only where a person (or one web request) picks the owner.
- **A `delivery: 'batched'` catalogue event is never mailed from its template** — the email job
  settles it `batched_deferred`. Pass a pre-rendered `email` to `notifyEvent()` (it takes the
  `sendPrerendered` branch first) when such an event must reach the inbox.
- **Turkish copy in single-quoted TS strings: no apostrophes.** `'lead'ler'` ends the string; a
  Python bulk insert of dictionary copy passed silently until grep caught it. Rephrase
  ("lead kayıtların") or use a typographic ’.
