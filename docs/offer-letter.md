# Offer letters (#1857)

An offer carries a letter the candidate reads, downloads as a branded PDF and accepts.

## Rules

- **Template per org and locale** — `OfferTemplate` (tenant model, `TENANT_MODELS`). An org with
  no row gets the built-in letter (`src/lib/offerLetterTemplates.ts`, EN/TR/DE). Edited on
  `/admin/settings` (`OfferLetterTemplateEditor`) through `GET/PUT/DELETE /api/admin/offer-templates`
  (`org.settings.write` + the `placements` module).
- **Merge tags are an allowlist** — `MERGE_TAGS` in `src/lib/offerLetter.ts`: `{{candidateName}}
  {{position}} {{companyName}} {{startDate}} {{compensation}} {{expiresAt}} {{programName}}`.
  An unknown tag renders literally; nothing is evaluated; a value is never re-scanned for tags.
- **Frozen on send** — `PATCH /api/offers/[id] { action: 'send' }` renders the letter in the
  candidate's `preferredLanguage` and stores it in `Offer.letterSnapshot` / `letterLocale`. A
  sent offer is always read from the snapshot; a later template edit changes nothing already sent.
  A draft is a live preview (ADMIN only).
- **Who may read it** — the letter states the pay, so it follows `canSeeCompensation()`: ADMIN
  and the offer's own MENTEE. `GET /api/offers/[id]/letter` answers 403 to COMPANY (even for its
  own offer) and to any other mentee. The snapshot is selected only through `OFFER_LETTER_FIELDS`.
- **Acceptance is a click-to-accept record** — `decidedAt`, `acceptedIp`, `acceptedUserAgent`
  (ADMIN-only reads). It is **not** a qualified electronic signature (eIDAS QES), and neither the
  UI nor the PDF says otherwise.
- **The PDF is rendered on request** from the snapshot (`src/lib/offerLetterPdf.ts`, on
  `certificatePdf.ts`'s branding helpers), not stored as a `Document` blob: the snapshot is the
  record and the bytes are reproducible from it. The standard PDF fonts are WinAnsi, so
  `pdfSafeText()` folds ğ/ş/ı/İ to their base letters in the PDF only; the on-screen letter keeps them.
- **Erasure** — `letterSnapshot`, `acceptedIp`, `acceptedUserAgent` are cleared by the account
  erasure sweep (`src/lib/accountErasure.ts`).
