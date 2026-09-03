// Idempotent backfill for the API key lifecycle (#1545) and the tenant half
// of #1466: every ApiKey row minted before those columns existed gets the
// default Organization and the scope set it already had in practice.
//
// `db push` gives new columns their defaults, so this script is a *data*
// normaliser, not a schema step:
//   - orgId  : NULL on legacy rows → the single default org (same org, same
//              slug resolution as prisma/backfill-organization.mjs).
//   - scopes : NULL/empty on any row → 'candidates:read', which is exactly the
//              surface those keys could already read (GET /api/v1/candidates is
//              the only /api/v1 route). This never widens a key.
//
// It deliberately does NOT touch expiresAt (a legacy key stays non-expiring
// until an admin decides otherwise — silently expiring live integrations would
// be an outage) and never touches revokedAt.
//
// Runs on deploy next to the other backfills. Safe to run repeatedly.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_SLUG = process.env.DEFAULT_ORG_SLUG || 'default';
const DEFAULT_SCOPES = 'candidates:read';

async function main() {
  const org = await prisma.organization.findUnique({
    where: { slug: DEFAULT_SLUG },
    select: { id: true },
  });

  let assigned = 0;
  if (org) {
    // backfill-organization.mjs creates/updates the default org; if it has not
    // run yet on a fresh DB there is simply nothing to point at, and the next
    // deploy's run picks these rows up.
    const res = await prisma.apiKey.updateMany({
      where: { orgId: null },
      data: { orgId: org.id },
    });
    assigned = res.count;
  } else {
    console.log(`backfill-api-key-lifecycle: no "${DEFAULT_SLUG}" org yet; skipping orgId.`);
  }

  const scoped = await prisma.apiKey.updateMany({
    where: { scopes: '' },
    data: { scopes: DEFAULT_SCOPES },
  });

  console.log(
    `backfill-api-key-lifecycle: orgId +${assigned}, scopes +${scoped.count} (default "${DEFAULT_SCOPES}").`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
