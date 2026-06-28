'use client';

import { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';
import { useT } from '@/i18n/client';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// "Install app" entry for the sidebar. Registers the service worker, then:
// - Chrome/Edge/Android: shows a button wired to the install prompt.
// - iOS Safari (no prompt API): shows a tappable "Add to Home Screen" hint.
// - Already installed (standalone): renders nothing.
export function InstallAppButton() {
  const t = useT();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    // Register the service worker.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) {
      setInstalled(true);
      return;
    }

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIos(/iphone|ipad|ipod/.test(ua));

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') setInstalled(true);
    setDeferred(null);
  };

  if (installed) return null;

  // iOS: no programmatic prompt — offer a hint.
  if (isIos && !deferred) {
    return (
      <div>
        <button
          onClick={() => setShowIosHint((v) => !v)}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
        >
          <Download className="h-4 w-4" />
          {t.pwa.install}
        </button>
        {showIosHint && (
          <p className="px-3 py-2 text-xs text-gray-500 flex items-start gap-1">
            <Share className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            {t.pwa.iosHint}
          </p>
        )}
      </div>
    );
  }

  if (!deferred) return null;

  return (
    <button
      onClick={install}
      className="flex items-center gap-2 w-full px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg transition-colors font-medium"
    >
      <Download className="h-4 w-4" />
      {t.pwa.install}
    </button>
  );
}
