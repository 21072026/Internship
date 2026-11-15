// The server half of src/lib/salesBookRule.ts: whose sales book a session
// sees. Read LIVE (the dispatcher flag is, src/lib/salesDispatcher.ts).
// Server-only.
import type { Session } from 'next-auth';
import { isSalesDispatcher } from '@/lib/salesDispatcher';
import { salesBookWhere, type SalesBookWhere } from '@/lib/salesBookRule';

export async function salesBookScope(session: Session): Promise<SalesBookWhere> {
  return salesBookWhere({ userId: session.user.id, dispatcher: await isSalesDispatcher(session.user.id) });
}
