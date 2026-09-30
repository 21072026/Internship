// Which tenant does a meeting (or a recurring meeting rule) belong to?
//
// `Meeting` and `MeetingSeries` carry no `orgId` of their own: their tenant is
// the tenant of the thing they hang off. With MT_ENFORCE_ISOLATION off (every
// deployment) nothing else scopes them, so an admin of one org could list,
// move, cancel or end another org's meetings by id (#2542 follow-up). The
// by-id checks in src/lib/meetingAccess.ts and the series routes ask this
// first, and answer a foreign row with the same 404 as a missing one.
//
// THE RULE, in order — the first parent that exists decides:
//   1. the relation (a 1:1 meeting),
//   2. the project (a project room, a recurring project call),
//   3. the conversation's project (a group chat bound to a project),
//   4. otherwise the person who called it — a DIRECT conversation, an instant
//      room, a series whose project was deleted (FK SetNull).
// A parent whose `orgId` is NULL is the DEFAULT org's (the tenantFilter.ts
// rule), never "no tenant", so a parent that exists always decides — the
// creator is consulted only when there is no parent at all.
//
// Pure and dependency-free so it is unit-tested
// (scripts/test/meeting-tenant-rule.test.mjs).

type OrgRef = { orgId: string | null } | null | undefined;

export interface MeetingParents {
  relation?: OrgRef;
  project?: OrgRef;
  conversation?: { project?: OrgRef } | null;
}

/**
 * `{ orgId }` when a parent decides the tenant (orgId may be null = default
 * org), or `'creator'` when only the creator's org can say.
 */
export function meetingOrgSource(m: MeetingParents): { orgId: string | null } | 'creator' {
  if (m.relation) return { orgId: m.relation.orgId };
  if (m.project) return { orgId: m.project.orgId };
  if (m.conversation?.project) return { orgId: m.conversation.project.orgId };
  return 'creator';
}
