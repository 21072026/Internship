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
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Badge, RoleBadge } from '@/components/ui/Badge';
import { Send, Mail, Copy, Check, CheckCircle2, Circle } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate, formatDateTime } from '@/lib/relativeTime';
import { formatMentorAvailability } from '@/lib/mentorAvailabilityLabel';
import type { MentorAvailability } from '@/lib/mentorAvailability';
import { copyToClipboard } from '@/lib/clipboard';

const inviteSchema = z.object({
  // Optional since #670: an empty address mints a shareable link instead of
  // sending mail. Anything typed still has to be a real address.
  email: z.union([z.string().email('Invalid email'), z.literal('')]).optional(),
  label: z.string().max(120).optional(),
  role: z.enum(['MENTOR', 'MENTEE', 'ADMIN']),
  // Optional counterpart + project: with these set, registering through the link
  // creates the mentorship and the project membership straight away (#51).
  mentorId: z.string().optional(),
  menteeId: z.string().optional(),
  projectId: z.string().optional(),
});

type InviteData = z.infer<typeof inviteSchema>;

const roleOptions = [
  { value: 'MENTEE', label: 'Mentee' },
  { value: 'MENTOR', label: 'Mentor' },
  { value: 'ADMIN', label: 'Admin' },
];

export default function InvitePage() {
  const t = useT();
  const locale = useLocale();
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Persistent list from the server (survives refresh), plus any freshly-minted
  // register links (the GET list omits tokens for security).
  const [invites, setInvites] = useState<{ id: string; email: string | null; label: string | null; role: string; used: boolean; createdAt: string; expiresAt: string; openedAt: string | null; registeredAt: string | null; verifiedAt: string | null; registerUrl: string | null }[]>([]);
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
     const didCopy = await copyToClipboard(url);

     if (!didCopy) return;

      setCopied(url);
      setTimeout(() => setCopied(null), 1500);
    };

  // Pickers for the auto-connect fields. The mentor picker carries
  // capacity/availability (#942) so the admin can see load before pre-linking
  // a mentor to a MENTEE invite; the mentee picker only ever needs a name.
  const [mentors, setMentors] = useState<
    { id: string; fullName: string; mentorCapacity: number | null; activeMenteeCount: number; availability: MentorAvailability }[]
  >([]);
  const [mentees, setMentees] = useState<{ id: string; fullName: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch('/api/users?view=mentorAvailability')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => {
        const users = (d.users ?? []) as {
          id: string;
          fullName: string;
          role: string;
          mentorCapacity: number | null;
          activeMenteeCount: number;
          availability: MentorAvailability;
        }[];
        setMentors(
          users
            .filter((u) => u.role === 'MENTOR' || u.role === 'ADMIN')
            .map((u) => ({
              id: u.id,
              fullName: u.fullName,
              mentorCapacity: u.mentorCapacity,
              activeMenteeCount: u.activeMenteeCount,
              availability: u.availability,
            }))
        );
        setMentees(users.filter((u) => u.role === 'MENTEE').map((u) => ({ id: u.id, fullName: u.fullName })));
      })
      .catch(() => {});
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => {});
  }, []);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<InviteData>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { role: 'MENTEE' },
  });

  const watchedRole = watch('role');

  // Does the actual POST — called either directly (available mentor, or no
  // mentor picked at all) or after the confirmation dialog is accepted
  // (at_capacity/not_accepting). The response's `warnings` (#942) are
  // accepted defensively and otherwise ignored: the confirmation already
  // happened client-side before this ran, so a second dialog off the same
  // warning would just be a duplicate.
  const sendInvite = async (data: InviteData) => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          // Empty select → no counterpart, rather than an empty string the API
          // would have to interpret.
          mentorId: data.mentorId || undefined,
          menteeId: data.menteeId || undefined,
          projectId: data.projectId || undefined,
          email: data.email || undefined,
          label: data.label || undefined,
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error || 'Failed to send invitation');
      }

      setSuccess(
        body.emailSent
          ? `${t.invite.emailedTo} ${data.email}`
          : data.email
            ? t.invite.createdNoEmail
            : t.invite.createdLinkOnly
      );
      if (body.invitationId && body.registerUrl) setLinks((p) => ({ ...p, [body.invitationId]: body.registerUrl }));
      await loadInvites();
      reset({ role: 'MENTEE' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  // Held for confirmation (#942) when a MENTEE invite pre-links a mentor
  // whose server-reported availability.status is at_capacity/not_accepting —
  // read straight off the `mentors` list already fetched from
  // /api/users?view=mentorAvailability, never recomputed here.
  const [pendingInvite, setPendingInvite] = useState<{ data: InviteData; status: 'at_capacity' | 'not_accepting' } | null>(null);

  // Gate before sendInvite: only interrupts with a dialog when the invite
  // pre-links a mentor (role MENTEE + mentorId chosen) whose availability is
  // at_capacity/not_accepting. Everything else — no mentor picked, or one
  // that's available — goes straight through, same as before #942.
  const onSubmit = handleSubmit((data) => {
    if (data.role === 'MENTEE' && data.mentorId) {
      const status = mentors.find((m) => m.id === data.mentorId)?.availability?.status;
      if (status === 'at_capacity' || status === 'not_accepting') {
        setPendingInvite({ data, status });
        return;
      }
    }
    sendInvite(data);
  });

  const confirmInvite = () => {
    if (!pendingInvite) return;
    const { data } = pendingInvite;
    setPendingInvite(null);
    sendInvite(data);
  };

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.invite.title}</h1>
          <p className="text-gray-500 mt-1">{t.invite.subtitle}</p>
        </div>
        {/* Bulk invitations (#2070) — a whole roster in one paste. */}
        <Link
          href="/admin/invite/bulk"
          data-testid="bulk-invite-link"
          className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          {t.bulkInvite.entryLink}
        </Link>
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
            {/* Email-less invitations (#670): leaving this empty produces a link
                to hand over in person — the invitee may not have an address on
                file, or the sender simply may not know it. */}
            <Input
              label={t.invite.emailAddressOptional}
              type="email"
              placeholder="user@example.com"
              hint={t.invite.emailOptionalHint}
              data-testid="invite-email"
              {...register('email')}
              error={errors.email?.message}
            />
            <Input
              label={t.invite.labelField}
              placeholder={t.invite.labelPlaceholder}
              hint={t.invite.labelHint}
              data-testid="invite-label"
              {...register('label')}
              error={errors.label?.message}
            />
            <Select
              label={t.invite.role}
              required
              options={roleOptions}
              {...register('role')}
              error={errors.role?.message}
            />
            {/* "Click the link and you are connected" (#51): the same behaviour a
                mentor's own invite has, now available to an admin for either side. */}
            {watchedRole === 'MENTEE' && (
              <Select
                label={t.invite.connectMentor}
                // Full or paused mentors stay in the list and stay selectable
                // (#942) — the capacity/status suffix is advisory only, never
                // a filter or a disable.
                options={[
                  { value: '', label: '—' },
                  ...mentors.map((m) => ({
                    value: m.id,
                    label: `${m.fullName} · ${formatMentorAvailability(m, t.mentorAvailability)}`,
                  })),
                ]}
                {...register('mentorId')}
              />
            )}
            {watchedRole === 'MENTOR' && (
              <Select
                label={t.invite.connectMentee}
                options={[{ value: '', label: '—' }, ...mentees.map((m) => ({ value: m.id, label: m.fullName }))]}
                {...register('menteeId')}
              />
            )}
            {watchedRole !== 'ADMIN' && (
              <Select
                label={t.invite.addToProject}
                options={[{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                {...register('projectId')}
              />
            )}
            {watchedRole !== 'ADMIN' && <p className="-mt-2 text-xs text-gray-500">{t.invite.connectHint}</p>}
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
              <li>{t.invite.stepLinkOnly}</li>
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
          {/* The full history, its filters and the bulk actions live on the
              board (#2071); this card stays because it is the only place a
              freshly-minted link is ever shown — the GET deliberately omits
              tokens, so a link not copied here cannot be recovered. */}
          <p className="mb-4 text-xs text-gray-500">
            {t.invite.boardHint}{' '}
            <Link href="/admin/invitations" className="text-blue-600 hover:underline font-medium" data-testid="invite-open-board">
              {t.invite.openBoard}
            </Link>
          </p>
          {invites.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              {t.invite.noneSent}
            </p>
          ) : (
            <div className="space-y-3">
              {invites.map((invite) => {
                const status = statusOf(invite);
                // The freshly-minted link from this session's POST, else the one
                // the list itself carries for our own still-usable email-less
                // invitations (#670) — those have no other way back.
                const link = links[invite.id] ?? invite.registerUrl;
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
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {invite.email ?? invite.label ?? t.invite.linkInvitation}
                      </p>
                      <p className="text-xs text-gray-400 truncate">
                        {invite.email && invite.label ? `${invite.label} · ` : ''}
                        {formatDate(invite.createdAt, locale)} · {(t.invite.status as Record<string, string>)[status]}
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
                        {s.at && <span className="text-gray-400">· {formatDateTime(s.at, locale)}</span>}
                      </li>
                    ))}
                  </ol>
                  {!invite.used && (
                    <div className="mt-2 flex items-center gap-3 text-xs">
                      <button type="button" disabled={busyId === invite.id} onClick={() => resend(invite.id)} className="text-blue-600 hover:text-blue-800 font-medium">
                        {invite.email ? t.invite.resend : t.invite.extend}
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

      <ConfirmDialog
        open={pendingInvite !== null}
        message={pendingInvite?.status === 'at_capacity' ? t.assignMentor.confirmAtCapacity : t.assignMentor.confirmNotAccepting}
        cancelLabel={t.common.cancel}
        confirmLabel={t.assignMentor.confirmAnyway}
        loading={loading}
        onConfirm={confirmInvite}
        onCancel={() => setPendingInvite(null)}
      />
    </div>
  );
}
