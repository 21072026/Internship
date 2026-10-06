import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { appNavLinks } from '@/lib/appNavigation';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { getServerDictionary } from '@/i18n/server';

// GET — the caller's web sidebar as data, for the native app's menu (#2775).
// Same list, same capability filter and the same labels as the web shell
// (src/lib/appNavigation.ts); presentation only — every destination is still
// guarded by its own layout and handlers.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const [capabilities, { t }] = await Promise.all([shellCapabilities(session.user.orgId), getServerDictionary()]);
  const nav = t.nav as Record<string, string>;
  const items = appNavLinks(session.user.role, capabilities).map((l) => ({
    key: l.key,
    href: l.href,
    label: nav[l.key] ?? l.key,
  }));
  return NextResponse.json({ items });
}
