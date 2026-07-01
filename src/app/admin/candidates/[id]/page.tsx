'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { ArrowLeft, KeyRound, Trash2, Plus } from 'lucide-react';
import { pipelineLabel, pipelineOptions, PIPELINE_STATUSES } from '@/lib/pipeline';
import { CvManager } from '@/components/CvManager';
import { nextAction } from '@/lib/matching';
import { EvaluationPanel } from '@/components/EvaluationPanel';
import { GoalsPanel } from '@/components/GoalsPanel';
import { DocumentsManager } from '@/components/DocumentsManager';
import { UserActivityPanel } from '@/components/UserActivityPanel';
import { CandidateEraseDangerZone } from '@/components/CandidateEraseDangerZone';
import { useT, useLocale } from '@/i18n/client';

interface Interaction { id: string; date: string; notes: string; type: string }
interface StatusChange { id: string; fromStatus: string; toStatus: string; createdAt: string; changedBy: { fullName: string } }
interface Relation {
  id: string;
  status: string;
  pipelineStatus: string;
  startDate: string;
  stageDeadline?: string | null;
  mentor: { fullName: string; email: string };
  company: { name: string; industry?: string } | null;
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
  birthDate?: string;
  referralSource?: string;
  sourceId?: string | null;
  source?: { id: string; name: string } | null;
  university?: string;
  department?: string;
  graduationYear?: number;
  skills: string[];
  cvUrl?: string;
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
  const [user, setUser] = useState<MenteeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ id: string; fullName: string; overlap: number; activeCount: number; capacity: number | null; atCapacity: boolean }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [cohorts, setCohorts] = useState<{ id: string; name: string }[]>([]);
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/users/${id}`);
    const data = await res.json();
    setUser(data.user ?? null);
    setLoading(false);
  }, [id]);

  // Change the pipeline stage. Any transition is allowed (incl. moving back,
  // e.g. 700 -> 220); the audit log only ever appends, so history is preserved.
  const changeStage = useCallback(
    async (relationId: string, pipelineStatus: string) => {
      setSaving(true);
      try {
        await fetch(`/api/mentorship/${relationId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pipelineStatus }),
        });
        await load();
      } finally {
        setSaving(false);
      }
    },
    [load]
  );

  const changeProject = useCallback(
    async (relationId: string, projectId: string) => {
      setSaving(true);
      try {
        await fetch(`/api/mentorship/${relationId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: projectId || null }),
        });
        await load();
      } finally {
        setSaving(false);
      }
    },
    [load]
  );

  const resetPassword = useCallback(async () => {
    setResetting(true);
    try {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) setResetUrl(data.resetUrl);
    } finally {
      setResetting(false);
    }
  }, [id]);

  // Manual stage-history corrections (S9.4): add or remove audit entries.
  const [histFrom, setHistFrom] = useState(PIPELINE_STATUSES[0] as string);
  const [histTo, setHistTo] = useState(PIPELINE_STATUSES[0] as string);
  const [histDate, setHistDate] = useState('');
  const [histBusy, setHistBusy] = useState(false);

  const addHistory = useCallback(
    async (relationId: string) => {
      setHistBusy(true);
      try {
        await fetch('/api/status-changes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            relationId,
            fromStatus: histFrom,
            toStatus: histTo,
            ...(histDate ? { createdAt: new Date(histDate).toISOString() } : {}),
          }),
        });
        setHistDate('');
        await load();
      } finally {
        setHistBusy(false);
      }
    },
    [histFrom, histTo, histDate, load]
  );

  const deleteHistory = useCallback(
    async (changeId: string) => {
      await fetch(`/api/status-changes/${changeId}`, { method: 'DELETE' });
      await load();
    },
    [load]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch(`/api/admin/suggest-mentors?menteeId=${id}`)
      .then((r) => (r.ok ? r.json() : { suggestions: [] }))
      .then((d) => setSuggestions(d.suggestions ?? []))
      .catch(() => {});
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => {});
    fetch('/api/cohorts')
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((d) => setCohorts(d.cohorts ?? []))
      .catch(() => {});
    fetch('/api/admin/sources')
      .then((r) => (r.ok ? r.json() : { sources: [] }))
      .then((d) => setSources(d.sources ?? []))
      .catch(() => {});
  }, [id]);

  const changeSource = useCallback(
    async (sourceId: string) => {
      setSaving(true);
      try {
        await fetch(`/api/users/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: sourceId || null }),
        });
        await load();
      } finally {
        setSaving(false);
      }
    },
    [id, load]
  );

  const changeRelField = useCallback(
    async (relationId: string, body: Record<string, unknown>) => {
      setSaving(true);
      try {
        await fetch(`/api/mentorship/${relationId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        await load();
      } finally {
        setSaving(false);
      }
    },
    [load]
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
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{user.fullName}</h1>
            <p className="text-gray-500">{user.email}</p>
          </div>
          <div className="flex items-center gap-3">
            {rel && <Badge variant="info">{pipelineLabel(rel.pipelineStatus, locale)}</Badge>}
            <Button variant="outline" size="sm" loading={resetting} onClick={resetPassword}>
              <KeyRound className="h-4 w-4 mr-1" />
              {t.candidateDetail.resetPassword}
            </Button>
          </div>
        </div>
      </div>

      {resetUrl && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm text-green-800 mb-2">{t.candidateDetail.resetPwHint}</p>
          <input
            readOnly
            value={resetUrl}
            onFocus={(e) => e.target.select()}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-700"
          />
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
            <Field label={t.candidateDetail.birthDate} value={user.birthDate ? new Date(user.birthDate).toLocaleDateString() : null} />
            <Field label={t.candidateDetail.referral} value={user.referralSource} />
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
                <div><span className="text-gray-500">{t.candidateDetail.mentor}:</span> <span className="font-medium">{rel.mentor.fullName}</span></div>
                {rel.company && <div><span className="text-gray-500">{t.candidateDetail.company}:</span> <span className="font-medium">{rel.company.name}</span></div>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
                <Select
                  label={t.candidateDetail.stage}
                  options={pipelineOptions(locale)}
                  value={rel.pipelineStatus}
                  disabled={saving}
                  onChange={(e) => changeStage(rel.id, e.target.value)}
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
                <Select
                  label={t.candidateDetail.source}
                  options={[{ value: '', label: t.candidateDetail.noSource }, ...sources.map((s) => ({ value: s.id, label: s.name }))]}
                  value={user.source?.id ?? ''}
                  disabled={saving}
                  onChange={(e) => changeSource(e.target.value)}
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
                const na = nextAction({ pipelineStatus: rel.pipelineStatus, lastInteractionAt: rel.interactions[0]?.date });
                const color = na.level === 'urgent' ? 'text-red-700 bg-red-50 border-red-200' : na.level === 'warn' ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-green-700 bg-green-50 border-green-200';
                return (
                  <div className={`inline-flex items-center gap-2 text-sm rounded-lg border px-3 py-1.5 ${color}`}>
                    <span className="font-medium">{t.candidateDetail.nextAction}:</span> {na.text}
                  </div>
                );
              })()}

              {suggestions.length > 0 && (
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-2">{t.candidateDetail.suggestedMentors}</p>
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map((s) => (
                      <span key={s.id} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-sm ${s.atCapacity ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                        {s.fullName}
                        <span className="text-xs text-gray-400">· {s.overlap} {t.candidateDetail.matchSkills} · {s.activeCount}{s.capacity ? `/${s.capacity}` : ''}</span>
                        {s.atCapacity && <span className="text-xs text-amber-700 font-medium">· {t.candidateDetail.full}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">{t.candidateDetail.stageHistory} ({rel.statusChanges.length})</p>
                {rel.statusChanges.length === 0 ? (
                  <p className="text-xs text-gray-400">{t.candidateDetail.noChanges}</p>
                ) : (
                  <ol className="space-y-2">
                    {rel.statusChanges.map((sc) => (
                      <li key={sc.id} className="group flex items-center gap-2 text-sm border-l-2 border-blue-100 pl-3">
                        <span className="flex-1 min-w-0">
                          <span className="text-gray-400">{pipelineLabel(sc.fromStatus, locale)}</span>
                          {' → '}
                          <span className="font-medium">{pipelineLabel(sc.toStatus, locale)}</span>
                          <span className="text-xs text-gray-400"> · {sc.changedBy.fullName} · {new Date(sc.createdAt).toLocaleDateString()}</span>
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
                    <Select label={t.candidateDetail.from} options={pipelineOptions(locale)} value={histFrom} onChange={(e) => setHistFrom(e.target.value)} />
                  </div>
                  <div className="w-40">
                    <Select label={t.candidateDetail.to} options={pipelineOptions(locale)} value={histTo} onChange={(e) => setHistTo(e.target.value)} />
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
                  <Button size="sm" loading={histBusy} onClick={() => addHistory(rel.id)}>
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
                        <Badge variant={i.type === 'Meeting' ? 'info' : i.type === 'Feedback' ? 'success' : 'warning'} className="text-xs flex-shrink-0">{i.type}</Badge>
                        <div>
                          <p className="text-gray-700">{i.notes}</p>
                          <p className="text-xs text-gray-400">{new Date(i.date).toLocaleDateString()}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
        {rel && <EvaluationPanel relationId={rel.id} />}
        {rel && <GoalsPanel relationId={rel.id} />}
        <DocumentsManager targetUserId={id} />
        <UserActivityPanel userId={id} />
        {user && <CandidateEraseDangerZone userId={id} fullName={user.fullName} onAnonymized={load} />}
      </div>
    </div>
  );
}
