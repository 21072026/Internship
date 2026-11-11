# 2026-11-06 — A pairing carries its programme (#1626)

- **A filter ANDed with the role scope can only narrow.** `?program=` goes into
  `andScope(...)` next to the scope from `scopeForRole()`, so a programme a
  PROGRAM_ADMIN has no grant for returns an empty list without any extra
  check. Put new list filters there, never by replacing `where` keys.
- **Read the body before the permission gate when the subject lives in it.**
  `POST /api/mentorship` must ask `relation.write` WITH the programme for a
  PROGRAM_ADMIN to pass, but WITHOUT it when none is named, so every existing
  caller (and every authz-matrix expectation) keeps its old answer.
- **Look for the paths that lose data, not only the ones that lack it.** The
  re-match decision built the replacement relation without the old pairing's
  `cohortId`, so every re-match silently left its programme. The new
  `MentorshipRequest.programId` has a real writer because of that.
- **`cat > file` overwrites without a word; the Write tool would have refused.**
  I wrote a "new" `src/lib/programFilter.ts` and `scripts/test/program-filter.test.mjs`
  over existing files of the same name (the analytics filter, #1652) and only the
  build caught it. Before creating a file from the shell, `ls` / `git ls-files`
  the name — and grep for an existing rule before writing a second one.
