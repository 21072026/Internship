import { prisma } from '@/lib/prisma';
import { requestSession } from '@/lib/requestSession';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { applyTerminologyMemo } from '@/lib/terminology';
import { terminologyFor } from '@/lib/terminology.server';
import { DictionaryScope } from './client';
import { toClientDictionary, type ClientDictionary } from './dictionaries';
import { SCOPE_NAMESPACES, type I18nScopeId } from './scopes.generated';
import { getLocale, overlaidDictionary, resolveRequestOrg } from './server';

/**
 * A programme's own vocabulary (#3400) for the pages of ONE programme an admin
 * opens (`/admin/programs/[id]/…`). Mounted in that segment's layout with the
 * route's id; the id is honoured only when it names a programme of the caller's
 * own org (anything else renders exactly as without the scope). It re-provides
 * the namespaces of `scope` with the programme layer applied over the
 * dictionary the outer `<I18nScope>` already gave — same memo, same rule
 * (src/lib/terminology.ts), so a programme with no row of its own reads exactly
 * its org's words.
 */
export async function ProgramTerminologyScope({
  programId,
  scope,
  children,
}: {
  programId: string;
  scope: I18nScopeId;
  children: React.ReactNode;
}) {
  const { vertical } = await resolveRequestOrg();
  const session = await requestSession();
  if (!session?.user?.id) return <>{children}</>;
  const orgId = await settingsOrgOf(session);
  const program = await prisma.cohort.findFirst({ where: { id: programId, orgId }, select: { id: true } });
  if (!program) return <>{children}</>;
  const terms = await terminologyFor(vertical, { orgId, programId: program.id });
  if (Object.keys(terms).length === 0) return <>{children}</>;
  const locale = await getLocale();
  // The programme document REPLACES the org's (the settings chain), so it is
  // applied over the overlaid base, not over the org-terminology dictionary.
  const { product, overlaid } = await overlaidDictionary(locale);
  const programDict = applyTerminologyMemo(`${vertical}\u0000${product}`, overlaid, locale, terms);
  const names = SCOPE_NAMESPACES[scope];
  const all = toClientDictionary(programDict) as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const n of names) if (n in all) picked[n] = all[n];
  return <DictionaryScope dict={picked as Partial<ClientDictionary>}>{children}</DictionaryScope>;
}
