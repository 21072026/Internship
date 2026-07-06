'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge, RoleBadge } from '@/components/ui/Badge';
import { Send, Mail, Copy, Check, CheckCircle2, Circle } from 'lucide-react';
import { useT } from '@/i18n/client';

const inviteSchema = z.object({
  email: z.string().email('Invalid email'),
  role: z.enum(['MENTOR', 'MENTEE', 'ADMIN']),
});

type InviteData = z.infer<typeof inviteSchema>;

const roleOptions = [
  { value: 'MENTEE', label: 'Mentee' },
  { value: 'MENTOR', label: 'Mentor' },
  { value: 'ADMIN', label: 'Admin' },
];

export default function InvitePage() {
  const t = useT();
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Persistent list from the server (survives refresh), plus any freshly-minted
  // register links (the GET list omits tokens for security).
  const [invites, setInvites] = useState<{ id: string; email: string; role: string; used: boolean; createdAt: string; expiresAt: string; openedAt: string | null; registeredAt: string | null; verifiedAt: string | null }[]>([]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    const res = await fetch('/api/invite');
    if (res.ok) setInvites((await res.json()).invitations ?? []);
  }, []);
  useEffect(() => { loadInvites(); }, [loadInvites]);

  const statusOf = (i: { used: boolean; expiresAt: string }) =>
    i.used ? 'accepted' : new Date(i.expiresAt) < new Date() ? 'expired' : 'pending';

  const resend = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/invite/${id}`, { method: 'POST' });
      const d = await res.json();
      if (res.ok) {
        if (d.registerUrl) setLinks((p) => ({ ...p, [id]: d.registerUrl }));
        setSuccess(d.emailSent ? t.invite.resent : t.invite.resentNoEmail);
        await loadInvites();
      }
    } finally {
      setBusyId(null);
    }
  };

  const cancelInvite = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/invite/${id}`, { method: 'DELETE' });
      if (res.ok) await loadInvites();
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

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteData>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { role: 'MENTEE' },
  });

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error || 'Failed to send invitation');
      }

      setSuccess(
        body.emailSent
          ? `Invitation emailed to ${data.email}`
          : `Invitation created for ${data.email} — email not delivered, share the link below manually`
      );
      if (body.invitationId && body.registerUrl) setLinks((p) => ({ ...p, [body.invitationId]: body.registerUrl }));
      await loadInvites();
      reset({ role: 'MENTEE' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  });

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.invite.title}</h1>
        <p className="text-gray-500 mt-1">{t.invite.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-blue-600" />
              <CardTitle>{t.invite.newInvitation}</CardTitle>
            </div>
          </CardHeader>

          {success && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
              ✓ {success}
            </div>
          )}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            <Input
              label={t.invite.emailAddress}
              type="email"
              required
              placeholder="user@example.com"
              {...register('email')}
              error={errors.email?.message}
            />
            <Select
              label={t.invite.role}
              required
              options={roleOptions}
              {...register('role')}
              error={errors.role?.message}
            />
            <Button type="submit" className="w-full" loading={loading}>
              <Send className="h-4 w-4" />
              {t.invite.send}
            </Button>
          </form>

          <p className="mt-4 text-xs text-gray-500">
            {t.invite.companyHint}{' '}
            <Link href="/admin/companies" className="text-blue-600 hover:underline font-medium">
              {t.invite.companyHintLink}
            </Link>
          </p>

          <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-xl">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">{t.invite.howItWorks}</p>
            <ol className="text-sm text-blue-700 dark:text-blue-300 space-y-1 list-decimal list-inside">
              <li>{t.invite.step1}</li>
              <li>{t.invite.step2}</li>
              <li>{t.invite.step3}</li>
              <li>{t.invite.step4}</li>
            </ol>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.invite.recentInvitations}</CardTitle>
          </CardHeader>
          {invites.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              {t.invite.noneSent}
            </p>
          ) : (
            <div className="space-y-3">
              {invites.map((invite) => {
                const status = statusOf(invite);
                const link = links[invite.id];
                // Lifecycle steps in order, each with the moment it was reached.
                const steps: { key: string; label: string; at: string | null }[] = [
                  { key: 'sent', label: t.invite.lifecycle.sent, at: invite.createdAt },
                  { key: 'opened', label: t.invite.lifecycle.opened, at: invite.openedAt },
                  { key: 'registered', label: t.invite.lifecycle.registered, at: invite.registeredAt },
                  { key: 'verified', label: t.invite.lifecycle.verified, at: invite.verifiedAt },
                ];
                return (
                <div key={invite.id} data-testid={`invite-${invite.id}`} className="py-3 border-b border-gray-50 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{invite.email}</p>
                      <p className="text-xs text-gray-400">
                        {new Date(invite.createdAt).toLocaleDateString()} · {(t.invite.status as Record<string, string>)[status]}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <RoleBadge role={invite.role} />
                      <Badge variant={status === 'accepted' ? 'success' : status === 'expired' ? 'warning' : 'default'}>
                        {(t.invite.status as Record<string, string>)[status]}
                      </Badge>
                    </div>
                  </div>
                  <ol className="mt-2 space-y-1">
                    {steps.map((s) => (
                      <li key={s.key} className="flex items-center gap-2 text-xs">
                        {s.at ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 flex-shrink-0" />
                        ) : (
                          <Circle className="h-3.5 w-3.5 text-gray-300 flex-shrink-0" />
                        )}
                        <span className={s.at ? 'text-gray-700 font-medium' : 'text-gray-400'}>{s.label}</span>
                        {s.at && <span className="text-gray-400">· {new Date(s.at).toLocaleString()}</span>}
                      </li>
                    ))}
                  </ol>
                  {!invite.used && (
                    <div className="mt-2 flex items-center gap-3 text-xs">
                      <button type="button" disabled={busyId === invite.id} onClick={() => resend(invite.id)} className="text-blue-600 hover:text-blue-800 font-medium">
                        {t.invite.resend}
                      </button>
                      <button type="button" disabled={busyId === invite.id} onClick={() => cancelInvite(invite.id)} className="text-gray-400 hover:text-red-600">
                        {t.invite.cancel}
                      </button>
                    </div>
                  )}
                  {link && (
                    <div className="mt-2 flex items-center gap-2">
                      <input readOnly value={link} className="flex-1 min-w-0 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-gray-600" />
                      <button type="button" onClick={() => copyLink(link)} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 flex-shrink-0">
                        {copied === link ? (<><Check className="h-3.5 w-3.5" /> {t.invite.copied}</>) : (<><Copy className="h-3.5 w-3.5" /> {t.invite.copy}</>)}
                      </button>
                    </div>
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
