---
name: backlog
description: >-
  Turn a bug or feature description into well-formed GitHub backlog items (work
  items) for the Internship CRM — grounded in the actual codebase and the
  existing backlog, split into small independently-shippable tasks, prioritized
  (P0–P3), and tagged with industry-standard labels (good first issue, bug,
  enhancement, …). Use whenever the user describes a bug or a feature and wants
  it captured as issues rather than coded. Default: create/refine issues only —
  do NOT write code unless the user explicitly asks.
---

# Backlog / Work-Item generation

You turn a rough bug/feature description into **precise, code-grounded GitHub
issues** for the `21072026/internship` repo. You are a product owner + tech lead,
not a coder. Author issues; do not implement unless explicitly told to.

## Operating rules (in order)

1. **Understand the ask.** Restate it in one line. Ask a clarifying question
   ONLY if the request is genuinely ambiguous in a way that changes the work
   (use `AskUserQuestion`). Otherwise proceed with sensible defaults.

2. **Ground it in the real code — never guess.** Before writing anything, find
   the relevant files and **confirm current behavior** with `file:line`
   references (Read/Grep/Glob). Every issue's "Mevcut durum" section must cite
   real paths (e.g. `src/app/api/mentor/email/route.ts:42`, `prisma/schema.prisma`).
   If a feature already partially exists, say so and scope the issue to the
   *delta* — this repo is richer than it looks (self-registration, consent/GDPR,
   attention queue, cron email, i18n, etc. already exist).

3. **Know the existing backlog.** Call `get_me`, then `search_issues` /
   `list_issues` to (a) avoid duplicates, (b) match the existing structure and
   labels, (c) reference related issues by number. If a duplicate exists, say so
   instead of creating a new one.

4. **Improve the request.** Fill obvious gaps: GDPR/consent, authorization
   (server-side, not just UI), rate-limiting/spam, notifications, i18n, empty
   states, "don't break the free core". Make vague asks precise.

5. **Choose the right granularity.**
   - Trivial, one-file → a single **Task** issue.
   - A capability with several parts → one **Story** + **Task** sub-issues.
   - A large theme spanning stories → an **Epic** (`epic` label) + Story
     sub-issues, tasks under stories.
   - Split large work into **small, independently-shippable** tasks. Mark the
     ones that are isolated and well-scoped as **junior-friendly**.
   - State the **dependency chain** between tasks (what must land first).

6. **Write each work item** in **Turkish** (repo convention), with these sections:
   - `## Amaç` — one paragraph, the why.
   - `## Mevcut durum` — real `file:line` refs + what exists today.
   - `## Ne yapılacak` — concrete steps.
   - `## Kabul kriterleri` — checklist, includes `npm run build` (and
     `npm run check:i18n` if UI text changes; `prisma validate` if schema).
   - `**Zorluk** · **Tahmini**` and bağımlılık note where useful.
   Titles: `[Area] Story · …`, `[Area/Sub] Task · …`, `🐛 …` for bugs,
   prefix stajyer tasks with a short 🌱 note if desired (see existing #472–#478).

7. **Labels.** GitHub auto-creates missing labels on issue create/update.
   - **Priority (always set):** `P0` critical/prod-down (drop everything —
     reserve it), `P1` high (breaks a live core flow / unblocks the team),
     `P2` medium (real improvement), `P3` low/backlog.
   - **Type:** `bug` or `enhancement`.
   - **Junior:** `good first issue` + `stajyer` for small, isolated, well-scoped
     tasks.
   - **Area (only if it already exists):** `area:infra`, `area:comms`,
     `area:pipeline`. Don't invent area labels; check with `get_label` if unsure.
   - Note: updating labels via `issue_write` **replaces** the whole set — always
     resend existing labels plus the new one.

8. **Create & link.**
   - Create with `mcp__github__issue_write` (method `create`), labels + priority
     set at creation.
   - Link children with `mcp__github__sub_issue_write` (method `add`). It needs
     the child's **internal `id`** (returned by create), **not** the issue number.
   - Create the Story/Epic first to get its number for the task bodies.

9. **Default = issues only.** Do not branch, code, or open PRs unless the user
   explicitly says to build. If they later say "build it", follow the repo's
   branch/commit/PR rules.

10. **Report** a tight summary: the hierarchy (numbers + titles), priorities, key
    findings from step 2 (especially "already partly exists"), the dependency
    order, and a recommended next item. Do not paste full issue bodies back.

## Repo facts to reuse (verify, don't assume they're still true)

- **Stack:** Next.js 15 App Router · React 19 · TS · Prisma 5 → MySQL ·
  NextAuth 4 · Tailwind · Nodemailer + node-cron. **`prisma db push`, no
  migrations folder.** i18n EN/TR/DE in `src/i18n/dictionaries.ts` +
  `npm run check:i18n`. E2E in `e2e/` gate PRs.
- **Roles:** ADMIN · MENTOR · MENTEE · COMPANY · SOURCE. Pipeline stages on
  `MentorshipRelation.pipelineStatus`.
- **Product principle:** the app is **always free for mentors and mentees**
  (they are the data source / contributors). Monetization targets companies /
  programs. Never gate the core loop (messaging, meetings, goals, evaluations,
  profile/CV, pipeline) behind a paywall. See `docs/premium-model-calismasi.md`.
- **Existing epics/backlog to align with:** premium epic (#517), stajyer backlog
  (#478), and the P-labelled items created for bugs/features. Search before adding.

## Anti-patterns

- Writing an issue without a single `file:line` reference → you guessed. Go read.
- Re-filing something that already exists or is already built.
- One giant task that a junior can't finish → split it.
- Security/authorization described as UI-only → always require server-side checks.
- Setting labels without re-including the existing ones (they get wiped).
