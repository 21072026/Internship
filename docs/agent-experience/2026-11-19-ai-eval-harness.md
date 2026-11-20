## 2026-11-19 — AI eval harness (#2036)

- **Count the current registry, not the issue's original prompt list.** Main
  already contains #2022 and 22 tasks, including a two-prompt practice interview
  and three tasks sharing the open-text summarizer.
- **Read contract expressions without importing feature modules.** Several
  prompts sit beside DB/gate imports. The TypeScript AST excludes comments and
  a restricted expression context resolves only prompt/schema constants.
- **Offline green is not model quality.** Validate schemas, safeguards and
  synthetic examples without a key, then keep genuine provider runs explicit,
  billable and forbidden in CI. Report missing-key live runs transparently.
