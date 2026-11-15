## 2026-11-13 — prospect retention review list (MKT-4, #3676)

- **Before erasing "by address", check what else the address reaches.** `forgetCompanyContact()`
  rewrites every account in the org whose contact carries the address, which is right for a
  DSGVO request about a person. For "this one prospect is overdue" it is wrong: the same address
  on a customer account has its own basis. The prospect erasure reuses the rule's data halves
  (`companyContactErasureData`, `inquiryErasureData`) and scopes them to one `companyId`.
- **A DB pre-filter may only narrow to what the pure rule would also exclude.** The `none:`
  filters (live permission, recent letter, recent enquiry) in `prospectRetention.ts` mirror
  `judgeProspect()`. The rule still runs on every row the filter lets through, so an error in
  the filter can only hide a row; it can never put a customer on the list.
- **Reuse a guard from the database layer, not from the route.** The erase route gives a 409 for
  any account the list would not show, so nobody can point the button at a customer by id.
  `eraseProspectContact()` re-runs the same rule for that one company.
- **Unit tests can import any `src/lib` TS module through `ts-extensionless-resolve.mjs`**, `@/`
  aliases included. Write a pure helper in a `*Rule.ts` file with only pure imports and test it
  directly.
