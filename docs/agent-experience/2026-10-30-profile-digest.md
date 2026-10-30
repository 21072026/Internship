# 2026-10-30 — Profile digests (#2038, slice 2)

- **A nightly sweep ordered by "oldest checked" must mark what it checked.** Without touching
  `updatedAt` on an unchanged row, the same 500 oldest rows were the whole scan every night and
  nobody else was ever reached. A no-op `updateMany` of the same value bumps `@updatedAt`.
- **Split "never done" from "stale" into two queries** so neither starves the other; the
  never-done half sorts by the user's own `updatedAt` desc, so a profile just filled in rises.
- **Prisma cannot compare columns across models** (`FieldRef<"User">` in a `ProfileDigest`
  filter is a type error) — compute staleness from a hash in code instead of in the query.
- `callModel(call, create)` takes the provider as a second argument: a pure unit spec can assert
  what is sent (no e-mail after masking, the system prompt) without a key or a network.
- A new AI task touches five places: `tasks.ts` (input cap ≥ 24k is tested), the audience table
  comment in `aiGate.ts`, `AI_RATE_LIMITS`, the task table in `docs/ai.md`, and its module.
- A card added to `ProfileForm` renders for MARKETING too; gate it from the API (`available`)
  rather than from the component, so the capability check lives on the server.
