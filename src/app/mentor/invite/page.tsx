'use client';

// A mentor's own invitation desk (#670).
//
// Two things make this different from the admin page: the role is fixed to
// MENTEE (the API enforces that too — a mentor cannot mint an admin invite),
// and the mentorship is implicit. Whoever registers through a link from here is
// this mentor's mentee the moment they finish signing up; the API stamps
// `mentorId` with the session's own id, so nothing here has to say so.
//
// The address is optional. Its absence is the whole point of the page: a mentor
// meets someone at a meetup or a school and wants to hand them a link, not ask
// for an email they may not use. The private note is what makes a wall of
// otherwise-identical links legible afterwards.

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Check, Copy, Send, UserPlus } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

const schema = z.object({
  email: z.union([z.string().email('Invalid email'), z.literal('')]).optional(),
  label: z.string().max(120).optional(),
});
type FormData = z.infer<typeof schema>;

type Invite = {
  id: string;
  email: string | null;
  label: string | null;
  role: string;
  used: boolean;
  createdAt: string;
  expiresAt: string;
  registeredAt: string | null;
  registerUrl: string | null;
};

export default function MentorInvitePage() {
  const t = useT();
  const locale = useLocale();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/invite');
    if (res.ok) setInvites((await res.json()).invitations ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'MENTEE', email: data.email || undefined, label: data.label || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed');
      if (body.invitationId && body.registerUrl) setLinks((p) => ({ ...p, [body.invitationId]: body.registerUrl }));
      setSuccess(
        body.emailSent ? `${t.invite.emailedTo} ${data.email}` : data.email ? t.invite.createdNoEmail : t.invite.createdLinkOnly
      );
      reset({ email: '', label: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  });

  const cancelInvite = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/invite/${id}`, { method: 'DELETE' });
      if (res.ok) await load();
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const statusOf = (i: Invite) => (i.used ? 'accepted' : new Date(i.expiresAt) < new Date() ? 'expired' : 'pending');

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.invite.mentorTitle}</h1>
        <p className="text-gray-500 mt-1">{t.invite.mentorSubtitle}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-green-600" />
              <CardTitle>{t.invite.newInvitation}</CardTitle>
            </div>
          </CardHeader>

          {success && (
            <div
              className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm"
              data-testid="mentor-invite-success"
            >
              ✓ {success}
            </div>
          )}
          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

          <form onSubmit={onSubmit} className="space-y-4">
            <Input
              label={t.invite.emailAddressOptional}
              type="email"
              placeholder="user@example.com"
              hint={t.invite.emailOptionalHint}
              data-testid="mentor-invite-email"
              {...register('email')}
              error={errors.email?.message}
            />
            <Input
              label={t.invite.labelField}
              placeholder={t.invite.labelPlaceholder}
              hint={t.invite.labelHint}
              data-testid="mentor-invite-label"
              {...register('label')}
              error={errors.label?.message}
            />
            <Button type="submit" className="w-full" loading={loading} data-testid="mentor-invite-submit">
              <Send className="h-4 w-4" />
              {t.invite.send}
            </Button>
          </form>

          <div className="mt-6 p-4 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 rounded-xl">
            <p className="text-sm text-green-800 dark:text-green-200">{t.invite.mentorAutoAssign}</p>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.invite.recentInvitations}</CardTitle>
          </CardHeader>
          {invites.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">{t.invite.noneSent}</p>
          ) : (
            <div className="space-y-3" data-testid="mentor-invite-list">
              {invites.map((invite) => {
                const status = statusOf(invite);
                const link = links[invite.id] ?? invite.registerUrl;
                return (
                  <div key={invite.id} data-testid={`invite-${invite.id}`} className="py-3 border-b border-gray-50 last:border-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {invite.email ?? invite.label ?? t.invite.linkInvitation}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                          {invite.email && invite.label ? `${invite.label} · ` : ''}
                          {formatDate(invite.createdAt, locale)}
                        </p>
                      </div>
                      <Badge variant={status === 'accepted' ? 'success' : status === 'expired' ? 'warning' : 'default'}>
                        {(t.invite.status as Record<string, string>)[status]}
                      </Badge>
                    </div>
                    {link && !invite.used && (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          readOnly
                          value={link}
                          aria-label={t.invite.shareLink}
                          className="flex-1 min-w-0 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-gray-600"
                        />
                        <button
                          type="button"
                          onClick={() => copyLink(link)}
                          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 flex-shrink-0"
                        >
                          {copied === link ? (
                            <>
                              <Check className="h-3.5 w-3.5" /> {t.invite.copied}
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5" /> {t.invite.copy}
                            </>
                          )}
                        </button>
                      </div>
                    )}
                    {!invite.used && (
                      <button
                        type="button"
                        disabled={busyId === invite.id}
                        onClick={() => cancelInvite(invite.id)}
                        className="mt-2 text-xs text-gray-400 hover:text-red-600"
                      >
                        {t.invite.cancel}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
