import { prisma } from '@/lib/prisma';
import { DEFAULT_TERMS_KEY, getActiveTerms } from '@/lib/contributorTerms';

/**
 * The due-diligence report (#1027): who accepted which contributor terms, when,
 * and for what.
 *
 * The question an acquirer's lawyer asks is "show me that every contributor
 * agreed", and the answer has to be producible from one screen rather than from
 * a database console. So this returns one row per (person × scope) — the
 * platform, plus every project they are on that asks — including the rows where
 * the answer is "no", because a report that only lists acceptances answers the
 * easy half of the question.
 */

export type AcceptanceStatus = 'accepted' | 'outdated' | 'missing';

export interface ReportRow {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  /** null = the platform-level scope. */
  projectId: string | null;
  projectName: string | null;
  termsKey: string;
  /** The version in force for this scope right now. */
  currentVersion: string;
  /** The version they actually accepted, if any. */
  acceptedVersion: string | null;
  acceptedAt: Date | null;
  status: AcceptanceStatus;
  /** Whether evidence was captured — never the value. See the note below. */
  evidence: boolean;
}

export interface Report {
  rows: ReportRow[];
  /** Terms keys in force, so the UI can say which document a row is about. */
  versions: Record<string, string>;
}

/**
 * Roles that are asked to accept at all. COMPANY and SOURCE accounts are
 * counterparties, not contributors — listing them as "not accepted" would fill
 * the report with rows that can never turn green and hide the ones that matter.
 */
const CONTRIBUTOR_ROLES = ['ADMIN', 'MENTOR', 'MENTEE'] as const;

export async function buildAcceptanceReport(): Promise<Report> {
  const [users, projects, acceptances] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: [...CONTRIBUTOR_ROLES] } },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, email: true, role: true },
    }),
    prisma.project.findMany({
      where: { contributorTermsRequired: true },
      select: {
        id: true, name: true, contributorTermsKey: true,
        members: { select: { userId: true } },
        relations: { where: { status: 'ACTIVE' }, select: { menteeId: true, mentorId: true } },
      },
    }),
    prisma.contributorTermsAcceptance.findMany({
      select: { userId: true, termsKey: true, version: true, projectId: true, acceptedAt: true, ipHash: true, uaHash: true },
      orderBy: { acceptedAt: 'asc' },
    }),
  ]);

  // Resolve each key once. A key with no text in force asks nothing of anyone,
  // so it produces no rows at all rather than a wall of un-satisfiable ones.
  const keys = new Set<string>([DEFAULT_TERMS_KEY]);
  for (const p of projects) if (p.contributorTermsKey) keys.add(p.contributorTermsKey);
  const versions: Record<string, string> = {};
  for (const key of keys) {
    const active = await getActiveTerms(key);
    if (active) versions[key] = active.version;
  }

  // Index the acceptances by scope, keeping the FIRST one per (user, key,
  // project): re-accepting the same version must not move the date, and the
  // earliest is the fact worth reporting.
  const byScope = new Map<string, (typeof acceptances)[number]>();
  const scopeKey = (userId: string, key: string, projectId: string | null) => `${userId}|${key}|${projectId ?? ''}`;
  for (const a of acceptances) {
    const k = scopeKey(a.userId, a.termsKey, a.projectId);
    const seen = byScope.get(k);
    if (!seen || a.acceptedAt < seen.acceptedAt) byScope.set(k, a);
  }

  const userById = new Map(users.map((u) => [u.id, u]));
  const rows: ReportRow[] = [];

  const push = (
    user: (typeof users)[number],
    termsKey: string,
    project: { id: string; name: string } | null
  ) => {
    const currentVersion = versions[termsKey];
    if (!currentVersion) return;
    const hit = byScope.get(scopeKey(user.id, termsKey, project?.id ?? null));
    // "outdated" is its own answer, not a variant of "accepted": they agreed to
    // wording that no longer governs, which is exactly what a re-consent
    // campaign needs to be able to find.
    const status: AcceptanceStatus = !hit ? 'missing' : hit.version === currentVersion ? 'accepted' : 'outdated';
    rows.push({
      userId: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      termsKey,
      currentVersion,
      acceptedVersion: hit?.version ?? null,
      acceptedAt: hit?.acceptedAt ?? null,
      status,
      // Deliberately a boolean. The record answers "was this the same client",
      // and the hash itself proves nothing to a reader while being one more
      // identifier to leak out of an exported spreadsheet.
      evidence: !!(hit?.ipHash || hit?.uaHash),
    });
  };

  for (const user of users) push(user, DEFAULT_TERMS_KEY, null);

  for (const p of projects) {
    const memberIds = new Set<string>(p.members.map((m) => m.userId));
    // Both membership sources, same as everywhere else — a report built on one
    // of them would quietly under-count the team.
    for (const r of p.relations) { memberIds.add(r.menteeId); memberIds.add(r.mentorId); }
    for (const id of memberIds) {
      const user = userById.get(id);
      if (user) push(user, p.contributorTermsKey ?? DEFAULT_TERMS_KEY, { id: p.id, name: p.name });
    }
  }

  return { rows, versions };
}
