// Copy every Google calendar connection and its event links into the
// provider-neutral tables (#1989, expand phase). Registered ONCE in
// prisma/backfills/registry.mjs.
//
// Insert-only: a (userId, GOOGLE) connection or a (meeting|series, connection)
// link that already exists in the new table is left as it is, so a manual
// re-run never overwrites a token refreshed or a link written since. It never
// deletes and never touches the old tables — they stay as the rollback until a
// separate contract PR drops them. ONCE, because after the switch a person who
// disconnects deletes only the new row; re-copying the old one on every deploy
// would silently reconnect them.
//
// The sealed token columns are copied verbatim: same secretBox purpose
// ('google-calendar'), so they decrypt exactly as before.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const old = await prisma.googleCalendarConnection.findMany();
  const created = await prisma.calendarConnection.createMany({
    data: old.map((c) => ({
      userId: c.userId,
      provider: 'GOOGLE',
      accountEmail: c.googleEmail,
      calendarId: c.calendarId,
      scope: c.scope,
      accessTokenEnc: c.accessTokenEnc,
      refreshTokenEnc: c.refreshTokenEnc,
      expiresAt: c.expiresAt,
      lastSyncAt: c.lastSyncAt,
      lastError: c.lastError,
      createdAt: c.createdAt,
    })),
    skipDuplicates: true,
  });

  // Old connection id → new connection id, through the user.
  const fresh = await prisma.calendarConnection.findMany({
    where: { provider: 'GOOGLE', userId: { in: old.map((c) => c.userId) } },
    select: { id: true, userId: true },
  });
  const newIdByUser = new Map(fresh.map((c) => [c.userId, c.id]));
  const newIdByOld = new Map(old.map((c) => [c.id, newIdByUser.get(c.userId)]));

  const links = await prisma.googleCalendarEventLink.findMany();
  const linkData = links
    .filter((l) => newIdByOld.get(l.connectionId))
    .map((l) => ({
      meetingId: l.meetingId,
      seriesId: l.seriesId,
      connectionId: newIdByOld.get(l.connectionId),
      externalEventId: l.googleEventId,
      pushedAt: l.pushedAt,
    }));
  const linked = await prisma.calendarEventLink.createMany({ data: linkData, skipDuplicates: true });

  const [oldConnections, newConnections, oldLinks, newLinks] = await Promise.all([
    prisma.googleCalendarConnection.count(),
    prisma.calendarConnection.count({ where: { provider: 'GOOGLE' } }),
    prisma.googleCalendarEventLink.count(),
    prisma.calendarEventLink.count({ where: { connection: { provider: 'GOOGLE' } } }),
  ]);
  // The counts the contract PR is gated on: it may drop the old tables only
  // once production reports oldConnections <= newConnections.
  console.log(
    `backfill-calendar-connections: connections created=${created.count} (old=${oldConnections} new=${newConnections}); ` +
      `links created=${linked.count} (old=${oldLinks} new=${newLinks})`
  );
}

main()
  .catch((error) => {
    console.error('backfill-calendar-connections failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
