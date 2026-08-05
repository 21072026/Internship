'use client';

import { useCallback, useEffect, useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';
import { TEXT_LIMITS } from '@/lib/textLimits';

type Status = 'PENDING' | 'APPROVED' | 'REJECTED';
type Tab = 'pending' | 'decided';

interface Application {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  expertise: unknown;
  experience: string | null;
  motivation: string | null;
  capacity: number | null;
  linkedinUrl: string | null;
  status: Status;
  createdAt: string;
  decidedAt: string | null;
  decidedBy?: { id: string; fullName: string } | null;
  rejectReason: string | null;
}

const STATUS_VARIANT: Record<Status, 'warning' | 'success' | 'danger'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
};

const expertiseList = (expertise: unknown): string[] =>
  Array.isArray(expertise) ? expertise.map((s) => String(s)).filter(Boolean) : [];

// Admin review queue for mentor applications (#906), on top of the #904
// model/API: approve sends a 7-day MENTOR invitation (no account created here —
// that happens when the applicant registers through the link, same as any
// other invitation), reject requires a reason and sends a generic decline.
export default function AdminMentorApplicationsPage() {
  const t = useT();
  const a = t.adminMentorApplications;
  const locale = useLocale();
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<Application[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectDraft, setRejectDraft] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const STATUS_LABEL: Record<Status, string> = {
    PENDING: a.statusPending,
    APPROVED: a.statusApproved,
    REJECTED: a.statusRejected,
  };

  const load = useCallback(async (which: Tab) => {
    setItems(null);
    try {
      if (which === 'pending') {
        const res = await fetch('/api/mentor-applications?status=PENDING');
        const d = res.ok ? await res.json() : { items: [] };
        setItems(d.items ?? []);
      } else {
        const [approvedRes, rejectedRes] = await Promise.all([
          fetch('/api/mentor-applications?status=APPROVED'),
          fetch('/api/mentor-applications?status=REJECTED'),
        ]);
        const [approved, rejected] = await Promise.all([
          approvedRes.ok ? approvedRes.json() : { items: [] },
          rejectedRes.ok ? rejectedRes.json() : { items: [] },
        ]);
        const merged: Application[] = [...(approved.items ?? []), ...(rejected.items ?? [])].sort(
          (x, y) => new Date(y.decidedAt ?? y.createdAt).getTime() - new Date(x.decidedAt ?? x.createdAt).getTime()
        );
        setItems(merged);
      }
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setOpenId(null);
    setRejectingId(null);
    setErr('');
    setNotice('');
  };

  const decide = async (id: string, action: 'approve' | 'reject') => {
    setErr('');
    setNotice('');
    const reason = rejectDraft[id]?.trim();
    if (action === 'reject' && !reason) {
      setErr(a.rejectReasonRequired);
      return;
    }
    setBusyId(id);
    try {
      const res = await fetch(`/api/mentor-applications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'approve' ? { action } : { action, rejectReason: reason }),
      });
      if (res.ok) {
        setNotice(action === 'approve' ? a.approveSuccess : a.rejectSuccess);
        setOpenId(null);
        setRejectingId(null);
        setRejectDraft((cur) => {
          const next = { ...cur };
          delete next[id];
          return next;
        });
        await load(tab);
      } else {
        const body = await res.json().catch(() => null);
        setErr(body?.code === 'already_decided' ? a.alreadyDecided : body?.error || t.common.error);
        if (body?.code === 'already_decided') await load(tab);
      }
    } catch {
      setErr(t.common.error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <GraduationCap className="h-6 w-6 text-blue-600" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
      </div>
      <p className="text-gray-500 mb-6">{a.subtitle}</p>

      <div className="flex gap-2 mb-4" data-testid="mentor-applications-tabs">
        <button
          type="button"
          onClick={() => switchTab('pending')}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            tab === 'pending'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-gray-700'
          }`}
          data-testid="tab-pending"
        >
          {a.tabPending}
        </button>
        <button
          type="button"
          onClick={() => switchTab('decided')}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            tab === 'decided'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-gray-700'
          }`}
          data-testid="tab-decided"
        >
          {a.tabDecided}
        </button>
      </div>

      {notice && (
        <p className="text-sm text-green-700 dark:text-green-400 mb-3" data-testid="mentor-app-notice">
          {notice}
        </p>
      )}
      {err && (
        <p className="text-sm text-red-600 mb-3" data-testid="mentor-app-error">
          {err}
        </p>
      )}

      {items === null ? (
        <p className="text-center py-10 text-gray-400">{t.common.loading}</p>
      ) : items.length === 0 ? (
        <Card>
          <p className="text-center py-10 text-gray-400">{a.empty}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((app) => {
            const expanded = openId === app.id;
            const expertise = expertiseList(app.expertise);
            const isRejecting = rejectingId === app.id;
            const busy = busyId === app.id;
            return (
              <Card key={app.id} data-testid={`mentor-application-${app.id}`}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => {
                    setOpenId(expanded ? null : app.id);
                    setRejectingId(null);
                  }}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 dark:text-gray-100 truncate">
                        {app.fullName}
                        <span className="ml-2 text-xs text-gray-400 font-normal">{app.email}</span>
                      </p>
                      {expertise.length > 0 && <p className="text-sm text-gray-500 truncate">{expertise.join(', ')}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant={STATUS_VARIANT[app.status]} className="text-xs">
                        {STATUS_LABEL[app.status]}
                      </Badge>
                      <span className="text-xs text-gray-400">{relativeTime(new Date(app.createdAt), locale)}</span>
                    </div>
                  </div>
                </button>

                {expanded && (
                  <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800 space-y-3 text-sm">
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                      {app.phone && (
                        <div>
                          <dt className="text-xs text-gray-400">{a.phone}</dt>
                          <dd className="text-gray-800 dark:text-gray-200">{app.phone}</dd>
                        </div>
                      )}
                      {app.capacity != null && (
                        <div>
                          <dt className="text-xs text-gray-400">{a.capacity}</dt>
                          <dd className="text-gray-800 dark:text-gray-200">{app.capacity}</dd>
                        </div>
                      )}
                      {app.linkedinUrl && (
                        <div>
                          <dt className="text-xs text-gray-400">{a.linkedin}</dt>
                          <dd className="truncate">
                            <a href={app.linkedinUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                              {app.linkedinUrl}
                            </a>
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-xs text-gray-400">{a.applied}</dt>
                        <dd className="text-gray-800 dark:text-gray-200">{new Date(app.createdAt).toLocaleString(locale)}</dd>
                      </div>
                      {app.decidedAt && (
                        <div>
                          <dt className="text-xs text-gray-400">{a.decided}</dt>
                          <dd className="text-gray-800 dark:text-gray-200">
                            {new Date(app.decidedAt).toLocaleString(locale)}
                            {app.decidedBy?.fullName ? ` · ${a.decidedByLabel} ${app.decidedBy.fullName}` : ''}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {app.experience && (
                      <div>
                        <dt className="text-xs text-gray-400 mb-0.5">{a.experience}</dt>
                        <dd className="text-gray-700 dark:text-gray-300 whitespace-pre-line">{app.experience}</dd>
                      </div>
                    )}
                    {app.motivation && (
                      <div>
                        <dt className="text-xs text-gray-400 mb-0.5">{a.motivation}</dt>
                        <dd className="text-gray-700 dark:text-gray-300 whitespace-pre-line">{app.motivation}</dd>
                      </div>
                    )}
                    {app.status === 'REJECTED' && app.rejectReason && (
                      <div>
                        <dt className="text-xs text-gray-400 mb-0.5">{a.rejectReasonLabel}</dt>
                        <dd className="text-gray-700 dark:text-gray-300 whitespace-pre-line">{app.rejectReason}</dd>
                      </div>
                    )}

                    {app.status === 'PENDING' && (
                      <div className="pt-2">
                        {isRejecting ? (
                          <div className="space-y-2">
                            <Textarea
                              value={rejectDraft[app.id] ?? ''}
                              onChange={(e) => setRejectDraft((cur) => ({ ...cur, [app.id]: e.target.value }))}
                              placeholder={a.rejectReasonPlaceholder}
                              rows={3}
                              maxLength={TEXT_LIMITS.mentorApplicationRejectReason}
                              showCounter
                              data-testid="reject-reason-input"
                            />
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                disabled={busy}
                                loading={busy}
                                onClick={() => decide(app.id, 'reject')}
                                data-testid="confirm-reject"
                              >
                                {a.confirmReject}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => setRejectingId(null)}
                                data-testid="cancel-reject"
                              >
                                {t.common.cancel}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              disabled={busy}
                              loading={busy}
                              onClick={() => decide(app.id, 'approve')}
                              data-testid="approve-application"
                            >
                              {a.approve}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => setRejectingId(app.id)}
                              data-testid="reject-application"
                            >
                              {a.reject}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
