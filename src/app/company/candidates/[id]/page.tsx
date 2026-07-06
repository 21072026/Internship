'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, ExternalLink, Star, Bookmark, ThumbsDown, Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { pipelineLabel } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

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

// Read-only candidate detail for a COMPANY user (EPIC: company candidate
// detail). Authorized server-side by a mentorship relation to this company.
export default function CompanyCandidateDetailPage() {
  const t = useT();
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [interest, setInterest] = useState<Interest | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<InterestStatus | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/company/candidates/${id}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || t.common.error);
        setCandidate(body.candidate);
      })
      .catch((e) => setError(e instanceof Error ? e.message : t.common.error))
      .finally(() => setLoading(false));

    fetch(`/api/company/interests?menteeId=${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.interest) { setInterest(d.interest); setNote(d.interest.note ?? ''); }
      })
      .catch(() => {});
  }, [id, t.common.error]);

  const setStatus = async (status: InterestStatus) => {
    setSaving(status);
    setSaved(false);
    try {
      const res = await fetch('/api/company/interests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menteeId: id, status, note }),
      });
      if (res.ok) {
        const body = await res.json();
        setInterest(body.interest);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } finally {
      setSaving(null);
    }
  };

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
              <Badge variant="info">{pipelineLabel(candidate.pipelineStatus, locale)}</Badge>
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
        {saved && (
          <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
            <Check className="h-3.5 w-3.5" /> {t.company.interestSaved}
          </p>
        )}
      </Card>
    </div>
  );
}
