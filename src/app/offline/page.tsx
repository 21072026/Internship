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
      </div>
    </div>
  );
}
