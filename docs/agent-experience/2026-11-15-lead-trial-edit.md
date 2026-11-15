## 2026-11-15 — trial end read mode on the sales lead page (#3647)

- **Before building an editor, read the endpoint's header for what it deliberately does NOT
  write.** The request asked for editable start and end dates, but `PATCH
  /api/mentorship/[id]/trial` writes only `trialEndsAt`. It refuses to invent a
  `trialStartedAt` ("a start nobody recorded is not invented here either"). Editing the start
  would need a new rule, so it was raised as a question and left out.
- **Compute "may edit" on the server from the route's own predicate.** Use the same
  `can(actor, 'relation.write')`, owner and `dispatcherMay(...)` the PATCH uses. A second,
  hand-written role check is how a button and its endpoint drift apart.
- **When a shared panel changes presentation, make the new mode opt-in** (`readFirst`).
  `TrialEndPanel` also sits on the admin candidate page, whose specs fill the field directly.
  Opt-in keeps that page and its specs unchanged. Only the lead page's own spec needed an
  extra Edit click.
