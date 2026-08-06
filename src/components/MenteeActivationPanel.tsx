'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';

const PLACEHOLDER_DOMAIN = '@import.local';

/**
 * Turns a mentee *record* into a real account (#1123).
 *
 * A mentee a mentor added by hand has no password and — when the mentor didn't
 * know the address yet — a generated `@import.local` one, so they can't sign in
 * and no reset mail can reach them. This panel is the way back: correct the
 * address (or leave it, to just resend) and the mentee gets a set-password link
 * on the existing record, keeping its interaction log and stage history.
 *
 * Rendered on both the mentor's mentee detail page and the admin candidate page;
 * `pending` comes from `pendingActivation` on the respective API.
 */
export function MenteeActivationPanel({
  menteeId,
  email,
  pending,
  onUpdated,
}: {
  menteeId: string;
  email: string;
  pending: boolean;
  onUpdated: () => void | Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const isPlaceholder = email.toLowerCase().endsWith(PLACEHOLDER_DOMAIN);
  // A generated address is nothing to edit — start empty so the mentor types
  // the real one; a real-looking address is prefilled so "resend" is one click.
  const [value, setValue] = useState(isPlaceholder ? '' : email);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [mailFailed, setMailFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!pending) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/mentor/mentees/${menteeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t.menteeActivation.failed);
      setLink(data.setPasswordUrl ?? null);
      setMailFailed(data.emailSent === false);
      toast(t.menteeActivation.sent);
      await onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.menteeActivation.failed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="mentee-activation-panel"
      className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4"
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-900">{t.menteeActivation.title}</p>
          <p className="mt-1 text-sm text-amber-800">
            {isPlaceholder ? t.menteeActivation.placeholderNote : t.menteeActivation.noPasswordNote}
          </p>

          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

          <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="w-full sm:max-w-sm">
              <Input
                label={t.menteeActivation.emailLabel}
                data-testid="mentee-activation-email"
                type="email"
                required
                value={value}
                onChange={(ev) => setValue(ev.target.value)}
              />
            </div>
            <Button type="submit" size="sm" loading={saving} data-testid="mentee-activation-submit">
              {isPlaceholder ? t.menteeActivation.saveAndSend : t.menteeActivation.resend}
            </Button>
          </form>

          {link && (
            <div className="mt-3" data-testid="mentee-activation-link">
              <p className="text-sm text-amber-800">
                {mailFailed ? t.menteeActivation.mailFailedHint : t.menteeActivation.linkHint}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={link}
                  onFocus={(ev) => ev.target.select()}
                  className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    navigator.clipboard?.writeText(link);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? t.menteeActivation.copied : t.menteeActivation.copyLink}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
