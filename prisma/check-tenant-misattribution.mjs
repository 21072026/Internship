// READ-ONLY detector: default-org users and companies that were most likely
// created BY another tenant (#2542).
//
// Before #2542, four create paths did not stamp `orgId` (POST /api/companies,
// /api/admin/company-users, /api/admin/source-users, /api/source/mentees): the
// tenant middleware that would have is dormant while MT_ENFORCE_ISOLATION is
// off. The deploy backfill (backfill-organization.mjs) then assigned those NULL
// rows to the DEFAULT org. So a company or login a MARKETING admin created
// through one of them is stored as default-org data — and since #2542 filters
// lists by tenant, such a row vanishes from its creator's screens and shows up
// on the default org's. Code cannot correct history; this reports the size of
// it so a reviewed one-off reassignment (or an explicit "none") can follow.
//
// Signals, each one a row whose own org is the default org while the evidence
// points at another tenant:
//   users     — the ActivityLog actor of `companyuser.created`,
//               `sourceuser.created` or `source.mentee_added` belongs to a
//               non-default org.
//   companies — POST /api/companies logs nothing, so the evidence is what hangs
//               off the company: a COMPANY-role login or a mentorship of a
//               non-default org linked to a default-org (or NULL) company.
//
// It NEVER writes and ALWAYS exits 0, like check-active-mentor-duplicates.mjs.
// Run it where the database is: `node prisma/check-tenant-misattribution.mjs`
// inside the prod / shared-preview container.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TAG = 'check-tenant-misattribution';
const USER_CREATE_ACTIONS = ['companyuser.created', 'sourceuser.created', 'source.mentee_added'];

async function main() {
  const defaultOrg = await prisma.organization.findUnique({ where: { slug: 'default' }, select: { id: true } });
  if (!defaultOrg) {
    console.log(`${TAG}: no default org — nothing to check.`);
    return;
  }
  const isDefault = (orgId) => orgId === null || orgId === defaultOrg.id;

  // Users.
  const logs = await prisma.activityLog.findMany({
    where: { action: { in: USER_CREATE_ACTIONS }, targetType: 'user', actorId: { not: null }, targetId: { not: null } },
    select: { action: true, actorId: true, targetId: true },
  });
  const ids = [...new Set(logs.flatMap((l) => [l.actorId, l.targetId]))];
  const people = new Map(
    (await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, orgId: true } })).map((u) => [u.id, u]),
  );
  const users = [];
  for (const l of logs) {
    const actor = people.get(l.actorId);
    const target = people.get(l.targetId);
    if (!actor || !target) continue;
    if (!isDefault(actor.orgId) && isDefault(target.orgId)) {
      users.push({ userId: target.id, userOrg: target.orgId, creatorOrg: actor.orgId, via: l.action });
    }
  }

  // Companies.
  const candidates = await prisma.company.findMany({
    where: { OR: [{ orgId: null }, { orgId: defaultOrg.id }] },
    select: {
      id: true,
      orgId: true,
      users: { where: { NOT: [{ orgId: null }, { orgId: defaultOrg.id }] }, select: { orgId: true } },
      mentorships: { where: { NOT: [{ orgId: null }, { orgId: defaultOrg.id }] }, select: { orgId: true } },
    },
  });
  const companies = candidates
    .filter((c) => c.users.length + c.mentorships.length > 0)
    .map((c) => ({
      companyId: c.id,
      companyOrg: c.orgId,
      linkedOrgs: [...new Set([...c.users, ...c.mentorships].map((r) => r.orgId))],
    }));

  if (users.length === 0 && companies.length === 0) {
    console.log(`${TAG}: OK — no default-org user or company points at another tenant (${logs.length} create logs checked).`);
    return;
  }
  // Ids and org ids only — no names or e-mail addresses in a deploy log.
  console.log(`${TAG}: FOUND ${users.length} user(s) and ${companies.length} company(ies) stored under the default org but linked to another tenant.`);
  for (const u of users) console.log(`${TAG}: user ${u.userId} org=${u.userOrg ?? 'NULL'} creatorOrg=${u.creatorOrg} via=${u.via}`);
  for (const c of companies) console.log(`${TAG}: company ${c.companyId} org=${c.companyOrg ?? 'NULL'} linkedOrgs=${c.linkedOrgs.join(',')}`);
}

main()
  .catch((e) => console.error(`${TAG}: check failed (not blocking):`, e?.message ?? e))
  .finally(() => prisma.$disconnect());
