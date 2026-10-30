// THE writer of a `User` row (#1998). Server-only.
//
// Sixteen paths make an account — registration and invite acceptance, an
// admin adding a company or source login, a mentor or source adding a mentee,
// the public application and org signup, SSO provisioning, the CSV import,
// the v1 API and its bulk import, the roster feed, the marketing import, the
// migration tool and the sample programme. They all call createUser(), so
// `user.created` cannot fire on some of them and not the others, and
// `npm run check:user-create` keeps it that way (a bare `user.create` anywhere
// else is red).
//
// What createUser() does NOT decide: whether the address is free. That is the
// world rule (src/lib/userWorld.ts, docs/worlds.md) and stays where each path
// asks it, before the write — the database only catches a copy in the same org.
//
// The event: with the root client it is emitted after the insert; inside a
// caller's transaction it is written THROUGH that transaction
// (emitInTransaction), so a rolled-back unit — a refused signup step, an
// import's dry run — leaves no event behind.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { emit, emitInTransaction } from '@/lib/events/emit';

export const USER_CREATE_SOURCES = [
  'register',
  'invite',
  'signup',
  'apply',
  'sso',
  'admin',
  'mentor',
  'source',
  'import',
  'api',
  'api_import',
  'roster',
  'marketing_import',
  'migration',
  'sample',
] as const;
export type UserCreateSource = (typeof USER_CREATE_SOURCES)[number];

type Db = typeof prisma | Prisma.TransactionClient;

export async function createUser<T extends Prisma.UserCreateArgs>(
  db: Db,
  args: Prisma.SelectSubset<T, Prisma.UserCreateArgs>,
  ctx: { source: UserCreateSource; actorId?: string | null },
): Promise<Prisma.UserGetPayload<T>> {
  // The event needs the id, the role and the org whatever the caller selects.
  const a = args as Prisma.UserCreateArgs;
  const withKeys = a.select ? { ...a, select: { ...a.select, id: true, role: true, orgId: true } } : a;
  const created = (await db.user.create(withKeys)) as unknown as { id: string; role: string; orgId: string | null };
  const payload = { userId: created.id, role: String(created.role), source: ctx.source };
  const emitCtx = { orgId: created.orgId ?? null, actor: ctx.actorId ? { id: ctx.actorId, type: 'user' as const } : { id: null, type: 'system' as const } };
  if (db === prisma) await emit('user.created', payload, emitCtx);
  else await emitInTransaction(db as Prisma.TransactionClient, 'user.created', payload, emitCtx);
  return created as unknown as Prisma.UserGetPayload<T>;
}
