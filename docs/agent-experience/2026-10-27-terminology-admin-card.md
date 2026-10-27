# 2026-10-27 — terminology admin card (#1629, slice 2)

- **A form that edits the words the dictionary is rewritten with must not read its own
  labels from the dictionary**: after "mentor → coach" the row labelled `t.…mentor`
  would read "Coach". The card labels rows from the pure catalogue (`TERM_DEFAULTS`).
- **`<Input label>` derives its `id` from the label** (`src/components/ui/Input.tsx`) —
  twenty inputs labelled "Singular"/"Plural" collide; pass an explicit `id`.
- `fillTemplate()` returns `ReactNode[]`, so a status message built with it needs a
  `ReactNode` state, not `string`.
- New settings strings that avoid mentor/mentee/intern words keep the MARKETING leak
  ratchet at 0 without an overlay entry or a `LEAK_EXEMPT` argument.
