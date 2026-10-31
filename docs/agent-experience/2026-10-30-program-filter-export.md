# 2026-10-30 — Programme filter in the export and the narrative (#1652 follow-up)

- **"The export forwards the query string" is only half the story**: `/api/admin/export/analytics`
  re-calls the analytics routes in-process with the caller's query, but its Funnel/Mentors sheets
  come from the report registry, which knows nothing of that query. Check every sheet's source
  before claiming an export follows a screen filter.
- A cache keyed on the computed facts (the AI narrative) needs no extra key for a new filter —
  the filtered facts already differ.
