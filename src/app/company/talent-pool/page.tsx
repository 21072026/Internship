'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, Sparkles, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT } from '@/i18n/client';

interface Candidate {
  id: string;
  fullName: string;
  university?: string | null;
  department?: string | null;
  graduationYear?: number | null;
  city?: string | null;
  targetPosition?: string | null;
  skills: string[];
  avatarUrl?: string | null;
}

// Premium talent-pool search (Faz 1). Shows a locked upsell when the company
// lacks the TALENT_POOL_SEARCH entitlement (API returns 403 feature_locked).
export default function TalentPoolPage() {
  const t = useT();
  const tp = t.talentPool;
  const [q, setQ] = useState('');
  const [skill, setSkill] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (skill) params.set('skill', skill);
      const res = await fetch(`/api/company/talent-pool?${params.toString()}`);
      if (res.status === 403) { setLocked(true); return; }
      const d = await res.json();
      setLocked(false);
      setCandidates(d.candidates ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [q, skill]);

  // Debounce searches; initial load on mount.
  useEffect(() => {
    const timer = setTimeout(load, 300);
    return () => clearTimeout(timer);
  }, [load]);

  if (locked) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">{tp.title}</h1>
        <p className="text-gray-500 mb-6">{tp.subtitle}</p>
        <Card className="text-center py-12 max-w-lg mx-auto">
          <Sparkles className="h-12 w-12 text-blue-500 mx-auto mb-4" />
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">{tp.lockedTitle}</p>
          <p className="text-sm text-gray-500 max-w-sm mx-auto">{tp.lockedBody}</p>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{tp.title}</h1>
        <p className="text-gray-500 mt-1">{tp.subtitle}</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tp.searchPlaceholder}
            className="pl-10 w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
        </div>
        <input
          type="text"
          value={skill}
          onChange={(e) => setSkill(e.target.value)}
          placeholder={tp.skillPlaceholder}
          className="sm:w-56 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
        />
      </div>

      {loading ? (
        <Card><SkeletonRows rows={4} /></Card>
      ) : candidates.length === 0 ? (
        <Card className="text-center py-12 text-gray-400">{tp.none}</Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {candidates.map((c) => (
            <Card key={c.id}>
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-xl bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-blue-700 dark:text-blue-300 font-bold">{c.fullName?.[0] ?? '?'}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">{c.fullName}</p>
                  {c.targetPosition && <p className="text-xs text-blue-600 dark:text-blue-400 truncate">{c.targetPosition}</p>}
                  <p className="text-xs text-gray-500 truncate">
                    {[c.university, c.department].filter(Boolean).join(' · ')}
                    {c.graduationYear ? ` · ${c.graduationYear}` : ''}
                  </p>
                </div>
              </div>
              {c.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {c.skills.slice(0, 6).map((s) => (
                    <Badge key={s} variant="info" className="text-xs">{s}</Badge>
                  ))}
                </div>
              )}
              <Link
                href={`/p/${c.id}`}
                target="_blank"
                className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline mt-3"
              >
                <ExternalLink className="h-3.5 w-3.5" /> {tp.viewProfile}
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
