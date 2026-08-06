'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { useT, useLocale } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/lib/relativeTime';

type Status = 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED';

interface ApplicationDetail {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  expertise: string[];
  experience: string | null;
  motivation: string | null;
  capacity: number | null;
  linkedinUrl: string | null;
  status: Status;
  consentAt: string | null;
  createdAt: string;
  rejectReason: string | null;
}

const STATUS_VARIANT: Record<string, 'warning' | 'info' | 'success' | 'danger'> = {
  PENDING: 'warning',
  UNDER_REVIEW: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
};

function Field({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-line">{value}</p>
    </div>
  );
}

export default function MentorApplicationDetailPage() {
  const id = useParams().id as string;
  const t = useT();
  const locale = useLocale();
  const a = t.mentorApplicationsAdmin;
  const toast = useToast();
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [rejectReasonText, setRejectReasonText] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/mentor-applications/${id}`);
    if (res.ok) {
      const d = await res.json();
      setApp(d.application ?? null);
      setNote(d.application?.rejectReason ?? '');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const statusLabel = (s: string) =>
    ({ PENDING: a.statusPending, UNDER_REVIEW: a.statusUnderReview, APPROVED: a.statusApproved, REJECTED: a.statusRejected } as Record<string, string>)[s] ?? s;

  const decide = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/mentor-applications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (d.code === 'already_decided') toast(a.alreadyDecided, 'error');
        else if (d.code === 'role_conflict') toast(a.roleConflict, 'error');
        else toast(d.error || a.actionError, 'error');
        await load();
        return;
      }
      await load();
      if (body.action === 'review') toast(a.reviewStarted);
      else if (body.action === 'approve') {
        toast(a.approvedToast);
        toast(d.accountAction === 'promoted' ? a.accountPromoted : a.accountInvited);
      } else if (body.action === 'reject') toast(a.rejectedToast);
    } catch {
      toast(a.actionError, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    setSavingNote(true);
    try {
      const res = await fetch(`/api/mentor-applications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'note', note }),
      });
      if (!res.ok) throw new Error();
      toast(a.noteSaved);
    } catch {
      toast(a.noteSaveError, 'error');
    } finally {
      setSavingNote(false);
    }
  };

  if (loading) return <p className="text-gray-400 py-12 text-center">…</p>;
  if (!app) return <p className="text-gray-400 py-12 text-center">{a.notFound}</p>;

  const decidable = app.status === 'PENDING' || app.status === 'UNDER_REVIEW';

  return (
    <div>
      <Link href="/admin/mentor-applications" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 mb-4">
        <ArrowLeft className="h-4 w-4" /> {a.backToList}
      </Link>

      <div className="flex items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{app.fullName}</h1>
          <p className="text-gray-500 mt-1">{a.appliedOn.replace('{date}', formatDate(app.createdAt, locale))}</p>
        </div>
        <Badge variant={STATUS_VARIANT[app.status] ?? 'default'}>{statusLabel(app.status)}</Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader><CardTitle>{a.contactSection}</CardTitle></CardHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label={t.applyMentor.email} value={app.email} />
              <Field label={a.phoneLabel} value={app.phone} />
              <Field label={a.linkedinLabel} value={app.linkedinUrl} />
              <Field label={a.capacitySection} value={app.capacity} />
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>{a.skillsSection}</CardTitle></CardHeader>
            {app.expertise && app.expertise.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {app.expertise.map((s) => (
                  <span key={s} className="inline-flex rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2.5 py-1 text-xs">
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">{a.noSkills}</p>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>{a.experienceSection}</CardTitle></CardHeader>
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">{app.experience || '—'}</p>
          </Card>

          <Card>
            <CardHeader><CardTitle>{a.motivationSection}</CardTitle></CardHeader>
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">{app.motivation || '—'}</p>
          </Card>

          <Card>
            <CardHeader><CardTitle>{a.consentSection}</CardTitle></CardHeader>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {app.consentAt ? a.consentedOn.replace('{date}', formatDate(app.consentAt, locale)) : a.noConsent}
            </p>
          </Card>
        </div>

        <div className="space-y-6">
          <Card data-testid="mentor-application-actions">
            <CardHeader><CardTitle>{a.approve} / {a.reject}</CardTitle></CardHeader>
            <div className="space-y-3">
              <Button
                variant="outline"
                className="w-full"
                disabled={app.status !== 'PENDING'}
                loading={busy}
                onClick={() => decide({ action: 'review' })}
              >
                {a.takeUnderReview}
              </Button>
              <Button
                className="w-full"
                disabled={!decidable}
                loading={busy}
                onClick={() => decide({ action: 'approve' })}
                data-testid="mentor-application-approve"
              >
                {a.approve}
              </Button>
              <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">{a.rejectReasonLabel}</label>
                <Textarea
                  rows={2}
                  maxLength={2000}
                  value={rejectReasonText}
                  onChange={(e) => setRejectReasonText(e.target.value)}
                  disabled={!decidable}
                  placeholder={a.rejectReasonHint}
                  data-testid="mentor-application-reject-reason"
                />
                <Button
                  variant="danger"
                  size="sm"
                  className="w-full mt-2"
                  disabled={!decidable || !rejectReasonText.trim()}
                  loading={busy}
                  onClick={() => decide({ action: 'reject', reason: rejectReasonText.trim() })}
                  data-testid="mentor-application-reject"
                >
                  {a.reject}
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>{a.noteLabel}</CardTitle></CardHeader>
            <p className="text-xs text-gray-500 mb-2">{a.noteHint}</p>
            <Textarea rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="mentor-application-note" />
            <Button variant="outline" size="sm" className="mt-2" loading={savingNote} onClick={saveNote}>
              {a.saveNote}
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
