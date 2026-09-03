# Trust centre

The three documents behind [`/trust`](../../src/app/trust/page.tsx) — the one URL to
paste into a procurement e-mail.

| File | Answers |
|---|---|
| [`subprocessors.md`](subprocessors.md) | Which third parties can receive data, what they receive, and which of them are optional |
| [`security-overview.md`](security-overview.md) | What protects the data, in customer-facing terms, with a pointer to the internal document that proves each claim |
| [`hosting-and-residency.md`](hosting-and-residency.md) | Where the data physically lives, what the EU/region answer is today, and the self-host escape hatch |

## The rule

**Adding an outbound integration must update `subprocessors.md`.**

"Outbound integration" means anything that causes this application to send data
to a party that is not the operator's own server:

- a new API call to a third-party service,
- a new embedded script or iframe on any page,
- a new mail transport, push service or webhook target,
- a new hosted dependency loaded at runtime rather than bundled.

Adding one and not updating the register turns a customer-facing promise into a
false statement, which is worse than never having published it. A reviewer
should treat a PR that introduces an outbound call without a register row the
same way they treat a shipped change with no release fragment.

Two mechanical follow-ups when you add a row:

1. **`src/lib/trust.ts`** carries the same list in typed form — that module, not
   this directory, is what `/trust` renders. Keep the two in step, and bump the
   `SUBPROCESSORS_UPDATED` date in it together with the "Last updated" line here.
2. **`.env.example`** should document the variables that switch the integration
   on, including what happens while they are unset. The register is derived from
   that file; an undocumented variable produces an undocumented subprocessor.

## What must not go in these documents

- **Claims that cannot be evidenced from a file in this repository.** Every
  statement in `security-overview.md` names the document or module that backs
  it. "Not yet enabled in production" is an acceptable sentence; a stronger
  claim that happens to be untrue is not.
- **An operator identity written into the source.** This project is AGPL and
  other people run their own instances. Who runs a deployment comes from
  `operatorIdentity()` (`src/lib/imprint.ts`), read from that deployment's
  environment.
- **A company named as the rights holder.** The sole rights holder is Mehmet
  Erşahin, a natural person (see `CONTRIBUTING.md` and
  `docs/legal/licensing-strategy.md`).
