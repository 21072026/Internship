## 2026-11-05 — ageing and funnel reports for a program admin (#1577)

- **A local `db push` after a long pause may ask for `--accept-data-loss`.** Main moved on for days;
  check `.env`'s `DATABASE_URL` points at the local e2e database (`internship_e2e` on 127.0.0.1)
  before adding the flag — never against a shared one.
- **Narrow, or withhold — never half-count.** The funnel's mentor capacity is a per-person load
  across every pairing; counting only the pairings inside a grant would make a mentor look under
  their ceiling when they are not. For such a figure the tier gets an empty list, not a narrowed one.
