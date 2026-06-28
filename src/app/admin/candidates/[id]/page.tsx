'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { ArrowLeft, ExternalLink, KeyRound } from 'lucide-react';
import { pipelineLabel, pipelineOptions } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

interface Interaction { id: string; date: string; notes: string; type: string }
interface StatusChange { id: string; fromStatus: string; toStatus: string; createdAt: string; changedBy: { fullName: string } }
interface Relation {
  id: string;
  status: string;
  pipelineStatus: string;
  startDate: string;
  mentor: { fullName: string; email: string };
  company: { name: string; industry?: string } | null;
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

  useEffect(() => {
    load();
  }, [load]);

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
            {user.cvUrl && (
              <a href={user.cvUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm text-blue-600 hover:underline">
                <ExternalLink className="h-3 w-3" /> {t.candidateDetail.viewCv}
              </a>
            )}
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

              <div className="max-w-xs">
                <Select
                  label={t.candidateDetail.stage}
                  options={pipelineOptions(locale)}
                  value={rel.pipelineStatus}
                  disabled={saving}
                  onChange={(e) => changeStage(rel.id, e.target.value)}
                />
              </div>

              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">{t.candidateDetail.stageHistory} ({rel.statusChanges.length})</p>
                {rel.statusChanges.length === 0 ? (
                  <p className="text-xs text-gray-400">{t.candidateDetail.noChanges}</p>
                ) : (
                  <ol className="space-y-2">
                    {rel.statusChanges.map((sc) => (
                      <li key={sc.id} className="text-sm border-l-2 border-blue-100 pl-3">
                        <span className="text-gray-400">{pipelineLabel(sc.fromStatus, locale)}</span>
                        {' → '}
                        <span className="font-medium">{pipelineLabel(sc.toStatus, locale)}</span>
                        <span className="text-xs text-gray-400"> · {sc.changedBy.fullName} · {new Date(sc.createdAt).toLocaleDateString()}</span>
                      </li>
                    ))}
                  </ol>
                )}
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
      </div>
    </div>
  );
}
