'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ArrowLeft, Plus, Trash2, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { pipelineOptions, pipelineLabel } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';
import { EvaluationPanel } from '@/components/EvaluationPanel';
import { GoalsPanel } from '@/components/GoalsPanel';
import { MeetingRequestsPanel } from '@/components/MeetingRequestsPanel';
import { QuestionsPanel } from '@/components/QuestionsPanel';
import { RelationNotesPanel } from '@/components/RelationNotesPanel';
import { ContactActions } from '@/components/ContactActions';
import { UserActivityPanel } from '@/components/UserActivityPanel';
import { DocumentsManager } from '@/components/DocumentsManager';
import { useToast } from '@/components/ui/Toast';

interface InteractionLog {
  id: string;
  date: string;
  subject?: string | null;
  notes: string;
  type: string;
}

interface RelationDetail {
  id: string;
  status: string;
  pipelineStatus: string;
  startDate: string;
  mentee: {
    id: string;
    fullName: string;
    email: string;
    university?: string;
    department?: string;
    graduationYear?: number;
    skills: string[];
    phone?: string;
    whatsapp?: string;
    city?: string;
    birthDate?: string;
    referralSource?: string;
    cvUrl?: string;
  };
  company: { name: string; industry?: string } | null;
  companyInterest?: { status: 'INTERESTED' | 'SHORTLISTED' | 'PASS'; note?: string | null } | null;
  interactions: InteractionLog[];
  statusChanges: {
    id: string;
    fromStatus: string;
    toStatus: string;
    createdAt: string;
    changedBy: { fullName: string };
  }[];
}

const typeOptions = [
  { value: 'Meeting', label: 'Meeting' },
  { value: 'Feedback', label: 'Feedback' },
  { value: 'Email', label: 'Email' },
];

export default function MenteeDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const t = useT();
  const locale = useLocale();
  const toast = useToast();

  const [relation, setRelation] = useState<RelationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ date: '', subject: '', notes: '', type: 'Meeting' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [savingStage, setSavingStage] = useState(false);
  const [stageError, setStageError] = useState('');

  const fetchRelation = useCallback(async () => {
    const res = await fetch(`/api/mentorship/${id}`);
    const data = await res.json();
    setRelation(data.relation);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    fetchRelation();
  }, [fetchRelation]);

  const handleAddInteraction = async () => {
    if (!formData.date || !formData.notes) {
      setFormError('Date and notes are required');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId: id, ...formData }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Failed');
      }
      await fetchRelation();
      setShowForm(false);
      setFormData({ date: '', subject: '', notes: '', type: 'Meeting' });
      toast(t.mentor.interactionLogged);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteInteraction = async (interactionId: string) => {
    if (!window.confirm(t.common.confirmDelete)) return;
    await fetch(`/api/interactions/${interactionId}`, { method: 'DELETE' });
    await fetchRelation();
    toast(t.mentor.interactionDeleted);
  };

  const handlePipelineChange = async (pipelineStatus: string) => {
    setSavingStage(true);
    setStageError('');
    try {
      const res = await fetch(`/api/mentorship/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineStatus }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Failed to update stage');
      }
      await fetchRelation();
      toast(t.mentor.stageUpdated);
    } catch (err) {
      setStageError(err instanceof Error ? err.message : 'Failed to update stage');
    } finally {
      setSavingStage(false);
    }
  };

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;
  if (!relation) return <div className="text-center py-12 text-gray-400">{t.mentor.relationNotFound}</div>;

  return (
    <div>
      <div className="mb-6">
        <Link href="/mentor/mentees" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="h-4 w-4" />
          {t.mentor.backToMentees}
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{relation.mentee.fullName}</h1>
            <p className="text-gray-500">{relation.mentee.email}</p>
          </div>
          <div className="flex flex-col items-end gap-2 min-w-[240px]">
            <StatusBadge status={relation.status} />
            <div className="w-full">
              <Select
                label={t.mentor.pipelineStage}
                options={pipelineOptions(locale)}
                value={relation.pipelineStatus}
                disabled={savingStage}
                onChange={(e) => handlePipelineChange(e.target.value)}
              />
              {stageError && <p className="text-xs text-red-600 mt-1">{stageError}</p>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Mentee info */}
        <Card>
          <CardHeader>
            <CardTitle>{t.mentor.profile}</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            {relation.mentee.university && (
              <div>
                <p className="text-xs text-gray-500">{t.candidateDetail.university}</p>
                <p className="text-sm text-gray-900">{relation.mentee.university}</p>
              </div>
            )}
            {relation.mentee.department && (
              <div>
                <p className="text-xs text-gray-500">{t.candidateDetail.department}</p>
                <p className="text-sm text-gray-900">{relation.mentee.department}</p>
              </div>
            )}
            {relation.mentee.graduationYear && (
              <div>
                <p className="text-xs text-gray-500">{t.candidateDetail.graduationYear}</p>
                <p className="text-sm text-gray-900">{relation.mentee.graduationYear}</p>
              </div>
            )}
            {relation.mentee.phone && (
              <div>
                <p className="text-xs text-gray-500">{t.candidateDetail.phone}</p>
                <p className="text-sm text-gray-900">{relation.mentee.phone}</p>
              </div>
            )}
            {relation.mentee.whatsapp && (
              <div>
                <p className="text-xs text-gray-500">{t.candidateDetail.whatsapp}</p>
                <p className="text-sm text-gray-900">{relation.mentee.whatsapp}</p>
              </div>
            )}
            {(relation.mentee.whatsapp || relation.mentee.phone) && (
              <ContactActions
                relationId={id}
                phone={relation.mentee.whatsapp || relation.mentee.phone || ''}
                onLogged={fetchRelation}
              />
            )}
            {relation.mentee.city && (
              <div>
                <p className="text-xs text-gray-500">{t.candidateDetail.city}</p>
                <p className="text-sm text-gray-900">{relation.mentee.city}</p>
              </div>
            )}
            {relation.mentee.birthDate && (
              <div>
                <p className="text-xs text-gray-500">{t.candidateDetail.birthDate}</p>
                <p className="text-sm text-gray-900">
                  {new Date(relation.mentee.birthDate).toLocaleDateString()}
                </p>
              </div>
            )}
            {relation.mentee.referralSource && (
              <div>
                <p className="text-xs text-gray-500">{t.candidateDetail.referral}</p>
                <p className="text-sm text-gray-900">{relation.mentee.referralSource}</p>
              </div>
            )}
            {relation.mentee.skills.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">{t.candidateDetail.skills}</p>
                <div className="flex flex-wrap gap-1">
                  {relation.mentee.skills.map((skill) => (
                    <Badge key={skill} variant="info" className="text-xs">{skill}</Badge>
                  ))}
                </div>
              </div>
            )}
            {relation.mentee.cvUrl && (
              <a
                href={relation.mentee.cvUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-blue-600 hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {t.candidateDetail.viewCv}
              </a>
            )}
            {relation.company && (
              <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-950/40 rounded-lg">
                <p className="text-xs text-blue-500 dark:text-blue-400 font-medium mb-1">{t.candidateDetail.company}</p>
                <p className="text-sm font-medium text-blue-900 dark:text-blue-100">{relation.company.name}</p>
                {relation.company.industry && (
                  <p className="text-xs text-blue-700 dark:text-blue-300">{relation.company.industry}</p>
                )}
                {relation.companyInterest && (
                  <div className="mt-2 pt-2 border-t border-blue-100 dark:border-blue-900">
                    <Badge variant={relation.companyInterest.status === 'PASS' ? 'danger' : relation.companyInterest.status === 'SHORTLISTED' ? 'success' : 'info'}>
                      {t.candidateDetail.companyInterest[relation.companyInterest.status.toLowerCase() as 'interested' | 'shortlisted' | 'pass']}
                    </Badge>
                    {relation.companyInterest.note && (
                      <p className="text-xs text-blue-700 dark:text-blue-300 mt-1.5 italic">“{relation.companyInterest.note}”</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* Pipeline stage history */}
        <Card>
          <CardHeader>
            <CardTitle>{t.mentor.stageHistory} ({relation.statusChanges.length})</CardTitle>
          </CardHeader>
          {relation.statusChanges.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">{t.mentor.noStageChanges}</p>
          ) : (
            <ol className="space-y-3">
              {relation.statusChanges.map((sc) => (
                <li key={sc.id} className="text-sm border-l-2 border-blue-100 pl-3">
                  <p className="text-gray-700">
                    <span className="text-gray-400">{pipelineLabel(sc.fromStatus, locale)}</span>
                    {' → '}
                    <span className="font-medium text-gray-900">{pipelineLabel(sc.toStatus, locale)}</span>
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {sc.changedBy.fullName} · {new Date(sc.createdAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {/* Interactions */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t.mentor.interactionLog} ({relation.interactions.length})</CardTitle>
              <Button size="sm" onClick={() => setShowForm(!showForm)}>
                <Plus className="h-4 w-4" />
                {t.mentor.addLog}
              </Button>
            </div>
          </CardHeader>

          {showForm && (
            <div data-testid="interaction-log-form" className="mb-6 p-4 bg-gray-50 rounded-xl space-y-3">
              {formError && (
                <p className="text-sm text-red-600">{formError}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={t.mentor.date}
                  type="date"
                  data-testid="interaction-log-date"
                  value={formData.date}
                  onChange={(e) => setFormData((p) => ({ ...p, date: e.target.value }))}
                />
                <Select
                  label={t.mentor.type}
                  options={typeOptions}
                  value={formData.type}
                  onChange={(e) => setFormData((p) => ({ ...p, type: e.target.value }))}
                />
              </div>
              <Input
                label={t.mentor.subject}
                data-testid="interaction-log-subject"
                value={formData.subject}
                onChange={(e) => setFormData((p) => ({ ...p, subject: e.target.value }))}
                placeholder={t.mentor.subjectPlaceholder}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.mentor.notes}</label>
                <textarea
                  rows={3}
                  data-testid="interaction-log-notes"
                  value={formData.notes}
                  onChange={(e) => setFormData((p) => ({ ...p, notes: e.target.value }))}
                  placeholder="What was discussed..."
                  className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddInteraction} loading={submitting}>{t.mentor.save}</Button>
                <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>{t.mentor.cancel}</Button>
              </div>
            </div>
          )}

          <div className="space-y-3">
            {relation.interactions.length === 0 && (
              <div>
                <p className="text-sm text-gray-400 text-center pt-4 pb-3">{t.mentor.noInteractionsYet}</p>
                <div className="opacity-50 pointer-events-none">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">{t.mentor.exampleLog}</p>
                  <div className="flex items-start gap-3 py-3 border-b border-dashed border-gray-200">
                    <InteractionTypeBadge type="Meeting" className="text-xs flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-700">{t.mentor.exampleLogNote}</p>
                      <p className="text-xs text-gray-400 mt-1">{new Date().toLocaleDateString()}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {relation.interactions.map((interaction) => (
              <div key={interaction.id} className="flex items-start gap-3 py-3 border-b border-gray-50 last:border-0">
                <InteractionTypeBadge type={interaction.type} className="text-xs flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  {interaction.subject && (
                    <p className="text-sm font-medium text-gray-900">{interaction.subject}</p>
                  )}
                  <p className="text-sm text-gray-700">{interaction.notes}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(interaction.date).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => handleDeleteInteraction(interaction.id)}
                  className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </Card>

        <div className="lg:col-span-2">
          <EvaluationPanel relationId={id} />
        </div>

        <div className="lg:col-span-2">
          <GoalsPanel relationId={id} />
        </div>

        <div className="lg:col-span-2">
          <MeetingRequestsPanel relationId={id} mode="manage" />
        </div>

        <div className="lg:col-span-2">
          <QuestionsPanel relationId={id} mode="answer" />
        </div>

        <div className="lg:col-span-2">
          <DocumentsManager targetUserId={relation.mentee.id} />
        </div>

        <div className="lg:col-span-2">
          <RelationNotesPanel relationId={id} />
        </div>

        {/* Activity feed sits last — it's the least frequently acted-on panel,
            so private notes and the working panels stay above the fold. */}
        <div className="lg:col-span-2">
          <UserActivityPanel userId={relation.mentee.id} flagInactive />
        </div>
      </div>
    </div>
  );
}
