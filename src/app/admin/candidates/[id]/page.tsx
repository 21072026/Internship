'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { RoleConvertButton } from '@/components/RoleConvertButton';
import { ArrowLeft, KeyRound, Trash2, Plus } from 'lucide-react';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { UserQuickActions } from '@/components/UserQuickActions';
import { CvManager } from '@/components/CvManager';
import { nextAction } from '@/lib/matching';
import { EvaluationPanel } from '@/components/EvaluationPanel';
import { GoalsPanel } from '@/components/GoalsPanel';
import { PersonTodos } from '@/components/todos/PersonTodos';
import { MeetingSchedulerPanel } from '@/components/MeetingSchedulerPanel';
import { DocumentsManager } from '@/components/DocumentsManager';
import { CertificateGenerator } from '@/components/CertificateGenerator';
import { canIssueCertificate } from '@/lib/certificateEligibility';
import { UserActivityPanel } from '@/components/UserActivityPanel';
import { CandidateEraseDangerZone } from '@/components/CandidateEraseDangerZone';
import { AddInteractionForm } from '@/components/AddInteractionForm';
import { MenteeActivationPanel } from '@/components/MenteeActivationPanel';
import { DropoffReasonDialog } from '@/components/DropoffReasonDialog';
import { OfferManagementPanel } from '@/components/OfferManagementPanel';
import { ReferrerPicker } from '@/components/ReferrerPicker';
import { TagEditor } from '@/components/TagEditor';
import { encodeReferrer, referrerLabel } from '@/lib/referrer';
import { useT, useLocale } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/lib/relativeTime';
import { PersonHoverCard } from '@/components/PersonHoverCard';

interface Interaction { id: string; date: string; notes: string; type: string }
interface StatusChange { id: string; fromStatus: string; toStatus: string; createdAt: string; changedBy: { fullName: string } }
interface Relation {
  id: string;
  status: string;
  pipelineStatus: string;
  startDate: string;
  completedAt: string | null;
  stageDeadline?: string | null;
  mentor: { id: string; fullName: string; email: string };
  company: { id: string; name: string; industry?: string } | null;
  project: { id: string; name: string } | null;
  cohort: { id: string; name: string } | null;
  interactions: Interaction[];
  statusChanges: StatusChange[];
}
interface MenteeDetail {
  id: string;
  fullName: string;
  email: string;
  phone?: string;
  whatsapp?: string;
  city?: string;
  /** IANA zone, null when the candidate never saved one (#1210). */
  timezone?: string | null;
  birthDate?: string;
  role?: string;
  referralSource?: string;
  sourceId?: string | null;
  source?: { id: string; name: string } | null;
  referredById?: string | null;
  referredBy?: { id: string; fullName: string; role: string } | null;
  university?: string;
  department?: string;
  graduationYear?: number;
  skills: string[];
  cvUrl?: string;
  // No password set yet → the candidate cannot sign in (#1123).
  pendingActivation?: boolean;
  tags?: { tag: { id: string; name: string; color?: string | null } }[];
  menteeRelations: Relation[];
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm text-gray-900">{value}</p>
    </div>
  );
}

export default function AdminMenteeDetailPage() {
  const id = useParams().id as string;
  const t = useT();
  const locale = useLocale();
  const label = useStageLabel();
  const stages = useResolvedStages();
  const toast = useToast();
  const [user, setUser] = useState<MenteeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Whether the last reset attempt got its email out. The link itself is never
  // returned to the browser any more (#875).
  const [resetSent, setResetSent] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [cohorts, setCohorts] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/users/${id}`);
    const data = await res.json();
    setUser(data.user ?? null);
    setLoading(false);
  }, [id]);

  // Change the pipeline stage. Any transition is allowed (incl. moving back,
  // e.g. 700 -> 220); the audit log only ever appends, so history is preserved.
  // reasonCode/reasonNote (#810) are required server-side when pipelineStatus
  // is a negative/off-path stage — the caller gates that via DropoffReasonDialog
  // before invoking this, see requestStageChange below.
  const changeStage = useCallback(
    async (relationId: string, pipelineStatus: string, reasonCode?: string, reasonNote?: string) => {
      setSaving(true);
      try {
        const res = await fetch(`/api/mentorship/${relationId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pipelineStatus, ...(reasonCode ? { reasonCode, reasonNote } : {}) }),
        });
        if (!res.ok) throw new Error();
        await load();
        toast(t.candidateDetail.saved);
      } catch {
        toast(t.candidateDetail.saveError, 'error');
      } finally {
        setSaving(false);
      }
    },
    [load, toast, t]
  );

  const changeProject = useCallback(
    async (relationId: string, projectId: string) => {
      setSaving(true);
      try {
        const res = await fetch(`/api/mentorship/${relationId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: projectId || null }),
        });
        if (!res.ok) throw new Error();
        await load();
        toast(t.candidateDetail.saved);
      } catch {
        toast(t.candidateDetail.saveError, 'error');
      } finally {
        setSaving(false);
      }
    },
    [load, toast, t]
  );

  const resetPassword = useCallback(async () => {
    setResetting(true);
    try {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) setResetSent(data.emailSent !== false);
    } finally {
      setResetting(false);
    }
  }, [id]);

  // Manual stage-history corrections (S9.4): add or remove audit entries.
  const [histFrom, setHistFrom] = useState(stages[0]?.key ?? '');
  const [histTo, setHistTo] = useState(stages[0]?.key ?? '');
  const [histDate, setHistDate] = useState('');
  const [histBusy, setHistBusy] = useState(false);

  const addHistory = useCallback(
    async (relationId: string, reasonCode?: string, reasonNote?: string) => {
      setHistBusy(true);
      try {
        const res = await fetch('/api/status-changes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            relationId,
            fromStatus: histFrom,
            toStatus: histTo,
            ...(histDate ? { createdAt: new Date(histDate).toISOString() } : {}),
            ...(reasonCode ? { reasonCode, reasonNote } : {}),
          }),
        });
        if (!res.ok) {
          toast(t.candidateDetail.saveError, 'error');
          return;
        }
        setHistDate('');
        await load();
      } finally {
        setHistBusy(false);
      }
    },
    [histFrom, histTo, histDate, load, toast, t]
  );

  // Gate for any move into a negative/off-path stage (#810): the live stage
  // select and the manual history-correction form both funnel through this
  // before calling their API, so neither can silently 400 with no way to
  // supply the reason the server now requires.
  const [pendingMove, setPendingMove] = useState<
    { kind: 'live'; relationId: string; toStatus: string } | { kind: 'history'; relationId: string; toStatus: string } | null
  >(null);
  const isNegativeStage = useCallback((key: string) => stages.find((s) => s.key === key)?.isOffPath ?? false, [stages]);

  const requestStageChange = (relationId: string, toStatus: string) => {
    if (isNegativeStage(toStatus)) {
      setPendingMove({ kind: 'live', relationId, toStatus });
    } else {
      changeStage(relationId, toStatus);
    }
  };

  const requestHistoryAdd = (relationId: string) => {
    if (isNegativeStage(histTo)) {
      setPendingMove({ kind: 'history', relationId, toStatus: histTo });
    } else {
      addHistory(relationId);
    }
  };

  const confirmPendingMove = (reasonCode: string, reasonNote: string) => {
    if (!pendingMove) return;
    if (pendingMove.kind === 'live') changeStage(pendingMove.relationId, pendingMove.toStatus, reasonCode, reasonNote);
    else addHistory(pendingMove.relationId, reasonCode, reasonNote);
    setPendingMove(null);
  };

  const deleteHistory = useCallback(
    async (changeId: string) => {
      try {
        const res = await fetch(`/api/status-changes/${changeId}`, { method: 'DELETE' });
        if (!res.ok) {
          toast(t.common.error, 'error');
          return;
        }
        await load();
      } catch {
        toast(t.common.error, 'error');
      }
    },
    [load, toast, t.common.error]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects(d.projects ?? []))
      .catch((e) => console.error('[candidate] projects load failed', e));
    fetch('/api/cohorts')
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((d) => setCohorts(d.cohorts ?? []))
      .catch((e) => console.error('[candidate] cohorts load failed', e));
  }, [id]);

  // One field, one write (#1296): whichever kind was picked is set and the other
  // is cleared, so a candidate never carries both a referring person and a
  // referral source.
  const changeReferrer = useCallback(
    async (fields: { referredById: string | null; sourceId: string | null }) => {
      setSaving(true);
      try {
        const res = await fetch(`/api/users/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
        });
        if (!res.ok) throw new Error();
        await load();
        toast(t.candidateDetail.saved);
      } catch {
        toast(t.candidateDetail.saveError, 'error');
      } finally {
        setSaving(false);
      }
    },
    [id, load, toast, t]
  );

  const changeRelField = useCallback(
    async (relationId: string, body: Record<string, unknown>) => {
      setSaving(true);
      try {
        const res = await fetch(`/api/mentorship/${relationId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error();
        await load();
        toast(t.candidateDetail.saved);
      } catch {
        toast(t.candidateDetail.saveError, 'error');
      } finally {
        setSaving(false);
      }
    },
    [load, toast, t]
  );

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;
  if (!user) return <div className="text-center py-12 text-gray-400">{t.common.notFound}</div>;

  const rel = user.menteeRelations[0];

  return (
    <div>
      <div className="mb-6">
        <Link href="/admin/candidates" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="h-4 w-4" />
          {t.candidateDetail.back}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 break-words">{user.fullName}</h1>
            <p className="text-gray-500 break-words">{user.email}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {rel && <Badge variant="info">{label(rel.pipelineStatus)}</Badge>}
            {/* Message / view-as shortcuts, right where the profile is read (#51). */}
            <UserQuickActions userId={user.id} role={user.role} />
            {/* Convert right where the person is looked at (#1252). */}
            {user.role && <RoleConvertButton userId={user.id} fullName={user.fullName} role={user.role} onDone={load} />}
            <Button variant="outline" size="sm" loading={resetting} onClick={resetPassword}>
              <KeyRound className="h-4 w-4 mr-1" />
              {t.candidateDetail.resetPassword}
            </Button>
          </div>
        </div>
      </div>

      {/* A candidate typed in by a mentor (or imported) has no login yet — the
          reset-password button above can't help, its mail goes to a stand-in
          address. This is the way in (#1123). */}
      <MenteeActivationPanel
        menteeId={user.id}
        email={user.email}
        pending={user.role === 'MENTEE' && !!user.pendingActivation}
        onUpdated={load}
      />

      {resetSent !== null && (
        <div
          className={`mb-6 rounded-lg border p-4 ${
            resetSent ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'
          }`}
        >
          <p className={`text-sm ${resetSent ? 'text-green-800' : 'text-amber-800'}`}>
            {resetSent ? t.candidateDetail.resetPwHint : t.candidateDetail.resetPwFailed}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t.candidateDetail.profile}</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            <Field label={t.candidateDetail.university} value={user.university} />
            <Field label={t.candidateDetail.department} value={user.department} />
            <Field label={t.candidateDetail.graduationYear} value={user.graduationYear} />
            <Field label={t.candidateDetail.phone} value={user.phone} />
            <Field label={t.candidateDetail.whatsapp} value={user.whatsapp} />
            <Field label={t.candidateDetail.city} value={user.city} />
            <Field label={t.candidateDetail.birthDate} value={user.birthDate ? formatDate(user.birthDate, locale) : null} />
            {user.skills.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">{t.candidateDetail.skills}</p>
                <div className="flex flex-wrap gap-1">
                  {user.skills.map((s) => (
                    <Badge key={s} variant="info" className="text-xs">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
            {/* Who brought this candidate in — ONE field (#1296). A registered
                person (set automatically by invite/referral links) or a Source
                row; new sources can be added right here. */}
            <ReferrerPicker
              value={encodeReferrer(user)}
              valueLabel={referrerLabel(user)}
              excludeUserId={user.id}
              legacyText={user.referralSource}
              disabled={saving}
              onChange={changeReferrer}
            />
            {/* Free-form labels (#887) — a cohort is the one official period
                group this candidate belongs to; tags are as many free marks as
                the team needs. */}
            <TagEditor userId={user.id} initial={(user.tags ?? []).map((ut) => ut.tag)} />
            <div className="pt-1">
              <CvManager targetUserId={user.id} initialCvUrl={user.cvUrl} />
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t.candidateDetail.mentorship}</CardTitle>
          </CardHeader>
          {!rel ? (
            <p className="text-sm text-gray-400 py-6 text-center">{t.candidateDetail.notAssigned}</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <div><span className="text-gray-500">{t.candidateDetail.mentor}:</span> <span className="font-medium" data-testid="mentorship-mentor"><PersonHoverCard personId={rel.mentor.id} name={rel.mentor.fullName} role="MENTOR" /></span></div>
                {rel.company && <div><span className="text-gray-500">{t.candidateDetail.company}:</span> <span className="font-medium">{rel.company.name}</span></div>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
                <Select
                  label={t.candidateDetail.stage}
                  data-testid="stage-select"
                  options={stages.map((s) => ({ value: s.key, label: s.label }))}
                  value={rel.pipelineStatus}
                  disabled={saving}
                  onChange={(e) => requestStageChange(rel.id, e.target.value)}
                />
                <Select
                  label={t.candidateDetail.project}
                  options={[{ value: '', label: t.candidateDetail.noProject }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                  value={rel.project?.id ?? ''}
                  disabled={saving}
                  onChange={(e) => changeProject(rel.id, e.target.value)}
                />
                <Select
                  label={t.candidateDetail.cohort}
                  options={[{ value: '', label: t.candidateDetail.noCohort }, ...cohorts.map((c) => ({ value: c.id, label: c.name }))]}
                  value={rel.cohort?.id ?? ''}
                  disabled={saving}
                  onChange={(e) => changeRelField(rel.id, { cohortId: e.target.value || null })}
                />
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.candidateDetail.stageDeadline}</label>
                  <input
                    type="date"
                    value={rel.stageDeadline ? rel.stageDeadline.slice(0, 10) : ''}
                    disabled={saving}
                    onChange={(e) => changeRelField(rel.id, { stageDeadline: e.target.value || null })}
                    className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm"
                  />
                  {rel.stageDeadline && new Date(rel.stageDeadline) < new Date() && ![ 'HIRED_660', 'EMPLOYED_700' ].includes(rel.pipelineStatus) && (
                    <p className="text-xs text-red-600 mt-1">{t.candidateDetail.overdue}</p>
                  )}
                </div>
              </div>

              {(() => {
                const na = nextAction({ pipelineStatus: rel.pipelineStatus, lastInteractionAt: rel.interactions[0]?.date }, t.nextActions);
                const color = na.level === 'urgent' ? 'text-red-700 bg-red-50 border-red-200' : na.level === 'warn' ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-green-700 bg-green-50 border-green-200';
                return (
                  <div className={`inline-flex items-center gap-2 text-sm rounded-lg border px-3 py-1.5 ${color}`}>
                    <span className="font-medium">{t.candidateDetail.nextAction}:</span> {na.text}
                  </div>
                );
              })()}

              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">{t.candidateDetail.stageHistory} ({rel.statusChanges.length})</p>
                {rel.statusChanges.length === 0 ? (
                  <p className="text-xs text-gray-400">{t.candidateDetail.noChanges}</p>
                ) : (
                  <ol className="space-y-2">
                    {rel.statusChanges.map((sc) => (
                      <li key={sc.id} className="group flex items-center gap-2 text-sm border-l-2 border-blue-100 pl-3">
                        <span className="flex-1 min-w-0">
                          <span className="text-gray-400">{label(sc.fromStatus)}</span>
                          {' → '}
                          <span className="font-medium">{label(sc.toStatus)}</span>
                          <span className="text-xs text-gray-400"> · {sc.changedBy.fullName} · {formatDate(sc.createdAt, locale)}</span>
                        </span>
                        <button
                          onClick={() => deleteHistory(sc.id)}
                          title={t.candidateDetail.deleteEntry}
                          className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ol>
                )}

                {/* Manually add a correcting history entry */}
                <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <div className="w-40">
                    <Select label={t.candidateDetail.from} options={stages.map((s) => ({ value: s.key, label: s.label }))} value={histFrom} onChange={(e) => setHistFrom(e.target.value)} />
                  </div>
                  <div className="w-40">
                    <Select label={t.candidateDetail.to} options={stages.map((s) => ({ value: s.key, label: s.label }))} value={histTo} onChange={(e) => setHistTo(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t.candidateDetail.date}</label>
                    <input
                      type="date"
                      value={histDate}
                      onChange={(e) => setHistDate(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <Button size="sm" loading={histBusy} onClick={() => requestHistoryAdd(rel.id)}>
                    <Plus className="h-4 w-4 mr-1" />
                    {t.candidateDetail.addEntry}
                  </Button>
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">{t.candidateDetail.interactions} ({rel.interactions.length})</p>
                {rel.interactions.length === 0 ? (
                  <p className="text-xs text-gray-400">{t.candidateDetail.noInteractions}</p>
                ) : (
                  <div className="space-y-2">
                    {rel.interactions.map((i) => (
                      <div key={i.id} className="flex items-start gap-2 text-sm">
                        <InteractionTypeBadge type={i.type} className="text-xs flex-shrink-0" />
                        <div>
                          <p className="text-gray-700">{i.notes}</p>
                          <p className="text-xs text-gray-400">{formatDate(i.date, locale)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <AddInteractionForm relationId={rel.id} onAdded={load} />
              </div>
            </div>
          )}
        </Card>
        {rel && (
          <OfferManagementPanel
            relationId={rel.id}
            menteeName={user.fullName}
            companyId={rel.company?.id ?? null}
            companyName={rel.company?.name}
            pipelineStatus={rel.pipelineStatus}
            stages={stages}
            onMoveToStage={(stageKey) => changeStage(rel.id, stageKey)}
          />
        )}
        {rel && <MeetingSchedulerPanel relationId={rel.id} menteeName={user.fullName} menteeTimezone={user.timezone ?? null} />}
        {rel && <EvaluationPanel relationId={rel.id} />}
        {rel && <GoalsPanel relationId={rel.id} />}
        <PersonTodos userId={id} fullName={user?.fullName} />
        {rel && canIssueCertificate(rel, stages) && (
          <Card>
            <CardHeader><CardTitle>{t.certificate.title}</CardTitle></CardHeader>
            <CertificateGenerator
              relationId={rel.id}
              eligible
              mentee={{ fullName: user.fullName, skills: user.skills }}
              mentor={{ fullName: rel.mentor.fullName }}
              companyName={rel.company?.name ?? null}
              startDate={rel.startDate}
              completedAt={rel.completedAt}
              onGenerated={load}
            />
          </Card>
        )}
        <DocumentsManager targetUserId={id} />
        <UserActivityPanel userId={id} />
        {user && <CandidateEraseDangerZone userId={id} fullName={user.fullName} onAnonymized={load} />}
      </div>

      <DropoffReasonDialog
        open={!!pendingMove}
        stageLabel={pendingMove ? label(pendingMove.toStatus) : ''}
        loading={saving || histBusy}
        onConfirm={confirmPendingMove}
        onCancel={() => setPendingMove(null)}
      />
    </div>
  );
}
