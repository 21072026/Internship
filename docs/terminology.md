# Per-tenant terminology (#1629, story #1627)

An organization (or one of its programmes) can rename the product's nouns —
"mentor" → "coach", "mentee" → "student" — per locale.

## Mechanism

There is **one** terminology layer and it is the overlay's (`src/i18n/verticalOverlays.ts`):
a stored terminology is turned into whole-word swaps over the already-overlaid
dictionary. No base string carries a placeholder.

- Catalogue and rule: `src/lib/terminology.ts` (pure, client-safe). Five tokens —
  `mentor`, `mentee`, `program`, `cohort`, `mentorship` — each with `one`, `many`,
  `oneCap`, `manyCap` per locale. Closed: a new token is a code change.
- Storage: the `terminology` setting (`src/lib/settings.ts`), one JSON document
  `{ en: {…}, tr: {…}, de: {…} }` per layer, resolved programme → org → global.
  A programme value **replaces** the org document, it does not merge with it.
- Read: `resolveTerminology(scope)` / `terminologyFor(vertical, scope)` in
  `src/lib/terminology.server.ts`.
- Applied at the existing choke points only: `requestDictionary()` in
  `src/i18n/server.ts` (used by `getServerDictionary()` and the root layout's client
  payload — so no `useT()` call site changes) and `emailDictionary()`.
- Write: `GET`/`PUT /api/admin/terminology` (`org.settings.write`, optional
  `programId` of the caller's own org; another org's programme is 404; a PUT from
  an org without the `mentorship` capability is refused). The admin form is the
  Terminology card on `/admin/settings` (`src/components/admin/TerminologyCard.tsx`,
  org layer only), whose rows are labelled from the catalogue so a renamed noun
  never renames its own label.

## Rules

- Nothing stored → the very same dictionary object (byte-identical).
- Malformed JSON, an unknown locale or token, a token missing a form, or a form with
  `{`, `}`, `<`, `>` or control characters is dropped — never stored, never rendered.
- Whole words only: `{mentor}` tokens, `/mentor/…` paths, `mentor.example` hosts,
  `mentor_id`, German compounds (`Mentorenzeit`) and Turkish suffixed forms
  (`mentorun`, `Mentor'un`) keep the default word. Inflection is stored, never built.
  German articles belong to the sentence: a noun of another gender reads with the
  base article.
- INTERNSHIP only. A MARKETING tenant's nouns come from its vertical overlay; its
  stored value is ignored.
- A signed-out page carries no terminology (no org; and the public pages pay no query).
- The walk is memoised per (base dictionary, locale, terminology), bounded at 64.

## Not done yet

- Turkish inflected forms beyond the four (genitive/dative…) — a catalogue extension.

## Programme pages (#3400)

A programme's vocabulary reaches pages through two bindings, both derived on the
server, never from request input:

- **The viewer's programme** (`requestProgramId()` in `src/i18n/server.ts`): a MENTEE's
  active mentorship's programme (one at most, #419); a MENTOR's when all their active
  mentorships share one programme (a relation outside any programme counts as "none").
  Admins and companies get none here. One indexed query, only for a signed-in person of
  an INTERNSHIP org.
- **An admin's programme page**: `src/app/admin/programs/[id]/layout.tsx` mounts
  `<ProgramTerminologyScope>` (`src/i18n/programScope.tsx`), which honours the route id
  only for a programme of the caller's own org and re-provides the segment's namespaces
  with the programme document applied over the overlaid base (`overlaidDictionary()`) —
  the programme REPLACES the org document, as the settings chain does. The admin nav
  around it keeps the org's words.
