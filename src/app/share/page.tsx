import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { roleHome } from '@/lib/roleHome';
import { ShareTargetClient } from './ShareTargetClient';

// The PWA share target (#2084). Android (and desktop Chrome) hands a shared
// title/text/url to this route as a plain GET, so the page is reachable by
// anyone who can craft a link — which is exactly why it only ever *displays*
// what it was given. Every write happens behind a button the person presses
// here; nothing is stored on arrival.
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return (value ?? '').slice(0, 2000);
}

/** Only http(s) links are shown as links — never `javascript:` and friends. */
function safeLink(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export default async function SharePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const title = first(sp.title).trim();
  const text = first(sp.text).trim();
  const url = first(sp.url).trim();

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    // Come back to the same shared payload after signing in, so a share from a
    // locked-out phone is not simply lost.
    const qs = new URLSearchParams();
    if (title) qs.set('title', title);
    if (text) qs.set('text', text);
    if (url) qs.set('url', url);
    const next = qs.toString() ? `/share?${qs.toString()}` : '/share';
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(next)}`);
  }

  const { t } = await getServerDictionary();

  // Some apps put the link in `text` instead of `url`; take whichever parses,
  // and only keep `text` as a note when it is not itself the link.
  const fromUrl = safeLink(url);
  const link = fromUrl ?? safeLink(text);
  const note = fromUrl || !link ? text : '';
  // What the to-do would say, before the person edits it.
  const suggested = [title, note, link ?? ''].filter(Boolean).join(' — ').slice(0, 300);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-2xl p-4 lg:p-8">
        <Link
          href={roleHome(session.user.role)}
          className="mb-6 inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          {t.share.back}
        </Link>

        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.share.title}</h1>
        <p className="mt-1 mb-6 text-sm text-gray-500">{t.share.subtitle}</p>

        <ShareTargetClient sharedTitle={title} sharedText={note} link={link} suggested={suggested} />
      </div>
    </div>
  );
}
