import { WifiOff } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';

// Offline fallback shown by the service worker when a navigation fails with no
// cached copy available.
export default async function OfflinePage() {
  const { t } = await getServerDictionary();
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="text-center max-w-sm">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
          <WifiOff className="h-7 w-7 text-gray-400" />
        </div>
        <h1 className="text-xl font-bold text-gray-900">{t.offline.title}</h1>
        <p className="text-gray-500 text-sm mt-2">{t.offline.body}</p>
        {/* Relative on purpose (#2609). This page is precached PER ORIGIN, and
            since #2492 the marketing host installs as its own PWA — a hardcoded
            https://interncrm.com sent a SaleVali user to a different product,
            and target="_blank" opened it in a chrome-less window inside the
            installed app (the #2147 dead end). `/` is always the origin the app
            was installed from, which is the right answer on every host. */}
        {/* A plain <a>, not next/link, and the rule is disabled rather than
            satisfied: this is the OFFLINE fallback. A Link does a client-side
            RSC fetch, which has nothing to answer it when the network is gone;
            a full navigation goes through the service worker's fetch handler,
            which is the only thing that can serve a cached copy of `/`. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="inline-block mt-4 text-sm font-medium text-blue-600 hover:text-blue-700 underline"
        >
          {t.offline.home}
        </a>
      </div>
    </div>
  );
}
