'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, ExternalLink, Star, Bookmark, ThumbsDown, Check, ShieldCheck, FolderGit2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';

type InterestStatus = 'INTERESTED' | 'SHORTLISTED' | 'PASS';
interface Interest { status: InterestStatus; note?: string | null }

interface Candidate {
  id: string;
  fullName: string;
  avatarUrl?: string | null;
  university?: string | null;
  department?: string | null;
  graduationYear?: number | null;
  city?: string | null;
  bio?: string | null;
  targetPosition?: string | null;
  skills: string[];
  skillLevels?: Record<string, number> | null;
  cvUrl?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  portfolioUrl?: string | null;
  pipelineStatus: string;
  mentorName: string;
}

interface VerifiedEvaluation {
  id: string;
  type: 'INTERIM' | 'FINAL';
  scores: Record<string, number> | null;
  comment?: string | null;
  createdAt: string;
  authorName: string;
}
interface VerifiedProject {
  id: string;
  name: string;
  description?: string | null;
  technologies: string[];
  repoUrl?: string | null;
  demoUrl?: string | null;
  status: string;
  tasksTotal: number;
  tasksDone: number;
}
interface Verified {
  evaluations: VerifiedEvaluation[];
  projects: VerifiedProject[];
}

// Read-only candidate detail for a COMPANY user (EPIC: company candidate
// detail). Authorized server-side by a mentorship relation to this company.
export default function CompanyCandidateDetailPage() {
  const t = useT();
  const label = useStageLabel();
  const { id } = useParams<{ id: string }>();
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [verified, setVerified] = useState<Verified | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [interest, setInterest] = useState<Interest | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<InterestStatus | null>(null);
  const [saved, setSaved] = useState(false);
  // Debounced note auto-save state (distinct from the status-change "saved").
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved'>('idle');
  // The last note value we persisted, so the auto-save effect only fires on a
  // genuine change (and never on the initial load).
  const savedNote = useRef('');

  useEffect(() => {
    fetch(`/api/company/candidates/${id}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || t.common.error);
        setCandidate(body.candidate);
        setVerified(body.verified ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : t.common.error))
      .finally(() => setLoading(false));

    fetch(`/api/company/interests?menteeId=${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.interest) { setInterest(d.interest); setNote(d.interest.note ?? ''); savedNote.current = d.interest.note ?? ''; }
      })
      .catch(() => {});
  }, [id, t.common.error]);

  // POST the interest (create/update). The server only re-notifies the mentor
  // when the status actually changes, so note-only saves stay silent.
  const persist = useCallback(async (status: InterestStatus, noteVal: string): Promise<Interest | null> => {
    const res = await fetch('/api/company/interests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menteeId: id, status, note: noteVal }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    savedNote.current = noteVal;
    setInterest(body.interest);
    return body.interest;
  }, [id]);

  const setStatus = async (status: InterestStatus) => {
    setSaving(status);
    setSaved(false);
    try {
      if (await persist(status, note)) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } finally {
      setSaving(null);
    }
  };

  // Auto-save the note after the user pauses typing. Requires an existing
  // status to attach to (the API needs one); before any status is picked, the
  // note is saved with the first status click instead. This fixes the case
  // where a status was chosen first and the note typed afterwards.
  useEffect(() => {
    if (!interest) return;
    if (note === savedNote.current) return;
    setNoteState('saving');
    const timer = setTimeout(async () => {
      const ok = await persist(interest.status, note);
      setNoteState(ok ? 'saved' : 'idle');
      if (ok) setTimeout(() => setNoteState('idle'), 2000);
    }, 800);
    return () => clearTimeout(timer);
  }, [note, interest, persist]);

  if (loading) return <p className="text-center py-12 text-gray-400">{t.common.loading}</p>;
  if (error || !candidate) return <p className="text-center py-12 text-gray-400">{error || t.common.notFound}</p>;

  const links = [
    { label: 'LinkedIn', url: candidate.linkedinUrl },
    { label: 'GitHub', url: candidate.githubUrl },
    { label: t.profileForm.portfolio, url: candidate.portfolioUrl },
  ].filter((l) => l.url);

  return (
    <div>
      <Link href="/company" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline mb-4">
        <ArrowLeft className="h-4 w-4" /> {t.company.back}
      </Link>

      <Card>
        <div className="flex items-start gap-4 mb-4">
          {candidate.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={candidate.avatarUrl} alt={candidate.fullName} className="w-16 h-16 rounded-2xl object-cover border border-gray-200 dark:border-gray-700" />
          ) : (
            <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/40 rounded-2xl flex items-center justify-center flex-shrink-0">
              <span className="text-blue-700 dark:text-blue-300 font-bold text-2xl">{candidate.fullName?.[0] ?? '?'}</span>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{candidate.fullName}</h1>
              <Badge variant="info">{label(candidate.pipelineStatus)}</Badge>
            </div>
            {candidate.targetPosition && <p className="text-blue-600 dark:text-blue-400 text-sm font-medium mt-0.5">{candidate.targetPosition}</p>}
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t.company.mentor}: {candidate.mentorName}</p>
          </div>
        </div>

        {candidate.bio && <p className="text-sm text-gray-700 dark:text-gray-300 mb-4 whitespace-pre-line">{candidate.bio}</p>}

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mb-4">
          {candidate.university && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t.profileForm.university}</dt>
              <dd className="text-gray-900 dark:text-gray-100">{candidate.university}</dd>
            </div>
          )}
          {candidate.department && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t.profileForm.department}</dt>
              <dd className="text-gray-900 dark:text-gray-100">{candidate.department}</dd>
            </div>
          )}
          {candidate.graduationYear && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t.profileForm.graduationYear}</dt>
              <dd className="text-gray-900 dark:text-gray-100">{candidate.graduationYear}</dd>
            </div>
          )}
          {candidate.city && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t.profileForm.city}</dt>
              <dd className="text-gray-900 dark:text-gray-100">{candidate.city}</dd>
            </div>
          )}
        </dl>

        {candidate.skills.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t.profileForm.skills}</p>
            <div className="flex flex-wrap gap-1.5">
              {candidate.skills.map((s) => (
                <Badge key={s} variant="info" className="text-xs">
                  {s}{candidate.skillLevels?.[s] ? ` · ${candidate.skillLevels[s]}/5` : ''}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-100 dark:border-gray-800">
          {candidate.cvUrl && (
            <a href={candidate.cvUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline">
              <FileText className="h-4 w-4" /> {t.cv.view}
            </a>
          )}
          {links.map((l) => (
            <a key={l.label} href={l.url!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300 hover:underline">
              <ExternalLink className="h-4 w-4" /> {l.label}
            </a>
          ))}
        </div>
      </Card>

      {verified && (
        <Card className="mt-4" data-testid="verified-card">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t.company.verifiedTitle}</p>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t.company.verifiedHint}</p>

          {verified.evaluations.length === 0 && verified.projects.length === 0 && (
            <p className="text-sm text-gray-400">{t.company.verifiedNone}</p>
          )}

          {verified.evaluations.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t.company.verifiedEvaluations}</p>
              <ul className="space-y-2">
                {verified.evaluations.map((e) => {
                  const scores = e.scores ? Object.entries(e.scores) : [];
                  const avg = scores.length ? scores.reduce((s, [, v]) => s + Number(v), 0) / scores.length : null;
                  return (
                    <li key={e.id} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3 bg-green-50 dark:bg-green-900/10">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <Badge variant={e.type === 'FINAL' ? 'success' : 'info'} className="text-xs">
                          {e.type === 'FINAL' ? t.company.verifiedFinal : t.company.verifiedInterim}
                        </Badge>
                        {avg !== null && (
                          <span className="inline-flex items-center gap-0.5 text-xs text-amber-600 dark:text-amber-400">
                            <Star className="h-3.5 w-3.5 fill-current" /> {avg.toFixed(1)}/5
                          </span>
                        )}
                        <span className="text-xs text-gray-400">{t.company.verifiedBy.replace('{name}', e.authorName)}</span>
                      </div>
                      {e.comment && <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">{e.comment}</p>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {verified.projects.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t.company.verifiedProjects}</p>
              <ul className="space-y-2">
                {verified.projects.map((p) => (
                  <li key={p.id} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <FolderGit2 className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</span>
                      {p.tasksTotal > 0 && (
                        <span className="text-xs text-gray-400">
                          {t.company.verifiedTasks.replace('{done}', String(p.tasksDone)).replace('{total}', String(p.tasksTotal))}
                        </span>
                      )}
                    </div>
                    {p.description && <p className="text-sm text-gray-600 dark:text-gray-300 mb-1.5 whitespace-pre-line">{p.description}</p>}
                    {p.technologies.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {p.technologies.map((tech) => (
                          <Badge key={tech} variant="info" className="text-xs">{tech}</Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      {p.repoUrl && (
                        <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">
                          <ExternalLink className="h-3.5 w-3.5" /> {p.repoUrl.includes('github') ? 'GitHub' : 'Repo'}
                        </a>
                      )}
                      {p.demoUrl && (
                        <a href={p.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">
                          <ExternalLink className="h-3.5 w-3.5" /> Demo
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <Card className="mt-4">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">{t.company.interestTitle}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t.company.interestHint}</p>

        <div className="flex flex-wrap gap-2 mb-3">
          <Button
            type="button"
            variant={interest?.status === 'INTERESTED' ? 'primary' : 'outline'}
            size="sm"
            loading={saving === 'INTERESTED'}
            onClick={() => setStatus('INTERESTED')}
          >
            <Star className="h-4 w-4 mr-1" /> {t.company.interested}
          </Button>
          <Button
            type="button"
            variant={interest?.status === 'SHORTLISTED' ? 'primary' : 'outline'}
            size="sm"
            loading={saving === 'SHORTLISTED'}
            onClick={() => setStatus('SHORTLISTED')}
          >
            <Bookmark className="h-4 w-4 mr-1" /> {t.company.shortlisted}
          </Button>
          <Button
            type="button"
            variant={interest?.status === 'PASS' ? 'danger' : 'outline'}
            size="sm"
            loading={saving === 'PASS'}
            onClick={() => setStatus('PASS')}
          >
            <ThumbsDown className="h-4 w-4 mr-1" /> {t.company.pass}
          </Button>
        </div>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t.company.notePlaceholder}
          rows={3}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm mb-2"
        />
        {saved ? (
          <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
            <Check className="h-3.5 w-3.5" /> {t.company.interestSaved}
          </p>
        ) : noteState === 'saving' ? (
          <p className="text-xs text-gray-400 flex items-center gap-1">{t.company.noteSaving}</p>
        ) : noteState === 'saved' ? (
          <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
            <Check className="h-3.5 w-3.5" /> {t.company.noteSaved}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
