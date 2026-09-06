import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { CALENDAR_PROVIDERS } from '@/lib/calendarProviders';
import { sanitizeError } from '@/lib/sanitizeError';

// GET — every calendar provider's state FOR THE SIGNED-IN USER (#1993).
//
// The aggregate read behind the "Connected calendars" card. The per-provider
// OAuth routes under /api/integrations/google/* are untouched; this only adds a
// place to ask "what does my side of this look like?" for all providers at once.
//
// Security, deliberately narrow:
//   - the only identity this route reads is `session.user.id`. There is no
//     `userId` parameter to tamper with, so one person's card can never be
//     pointed at another person's connection.
//   - each provider's `readConnection` selects an explicit allowlist of columns.
//     `accessTokenEnc` / `refreshTokenEnc` are never fetched at all, rather than
//     fetched and then deleted from the response — a stripping step is one
//     forgotten edit away from leaking, an allowlist is not.
//   - `lastError` is provider text and can echo the account or a token, so it
//     goes through the shared sanitizer (#2008) before it leaves the server.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const providers = await Promise.all(
    CALENDAR_PROVIDERS.map(async (p) => {
      const configured = p.isConfigured();
      const enabled = p.isEnabled();
      // Read the row even when the provider is switched off: a connection made
      // before the operator disabled it still exists, and pretending otherwise
      // is the same silent lie this card was built to stop.
      const conn = configured ? await p.readConnection(userId) : null;
      return {
        provider: p.id,
        label: p.label,
        configured,
        enabled,
        connected: !!conn,
        accountEmail: conn?.accountEmail ?? null,
        lastSyncAt: conn?.lastSyncAt?.toISOString() ?? null,
        lastError: sanitizeError(conn?.lastError),
        connectPath: p.connectPath,
        disconnectPath: p.disconnectPath,
      };
    })
  );

  return NextResponse.json({ providers });
}
