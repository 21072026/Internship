# 2026-10-29 — Chat identity linking (#1937)

- A user lookup by e-mail must be pinned (`orgId` in the same `where`) or
  `check:user-email-lookups` fails — matching a workspace's directory against
  `{ orgId: workspace.orgId, email: { in: … } }` is pinned by construction.
- Exercising a unique constraint "for real" in a spec: `await expect(prisma.x.create(...)).rejects.toThrow(Prisma.PrismaClientKnownRequestError)`.
  Prisma logs the P2002 to stderr anyway; that noise in the run output is expected.
- When a new person-linked row type is added, put it in `accountErasure.ts`'s anonymise
  transaction in the same PR — a hard delete cascades, but anonymise keeps the user row.
