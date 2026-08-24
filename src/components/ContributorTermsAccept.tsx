'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';

/**
 * The click-wrap itself (#1025).
 *
 * Three properties here are legal requirements, not styling choices:
 *  - the checkbox starts UNTICKED (`useState(false)`), so acceptance is an act;
 *  - the button is disabled until it is ticked, so there is no way to accept
 *    without the deliberate click;
 *  - the version that was on screen is sent with the POST, so a text that
 *    changed between render and click is refused (409) instead of being
 *    recorded as consent to wording the person never saw.
 */
export function ContributorTermsAccept({
  version,
  termsKey,
  nextHref,
  labels,
}: {
  version: string;
  termsKey: string;
  nextHref: string;
  labels: {
    intro: string;
    checkbox: string;
    button: string;
    versionChanged: string;
  };
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/contributor-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, key: termsKey }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        // The text on screen is stale. Untick and reload so they read the new
        // wording before accepting it.
        setChecked(false);
        setError(data?.code === 'version_changed' ? labels.versionChanged : (data?.error ?? 'Failed'));
        router.refresh();
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? 'Failed');
        return;
      }
      router.push(nextHref);
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-gray-100 dark:border-gray-800 pt-5" data-testid="terms-accept">
      <p className="text-sm text-gray-600 dark:text-gray-300">{labels.intro}</p>

      <label className="mt-3 flex items-start gap-2.5 text-sm text-gray-800 dark:text-gray-100 cursor-pointer">
        <input
          type="checkbox"
          data-testid="terms-accept-checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span>{labels.checkbox}</span>
      </label>

      {error && (
        <p data-testid="terms-accept-error" className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          {error}
        </p>
      )}

      <button
        type="button"
        data-testid="terms-accept-submit"
        disabled={!checked || busy}
        onClick={submit}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        {labels.button}
      </button>
    </div>
  );
}
