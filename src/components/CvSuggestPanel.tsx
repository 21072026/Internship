'use client';

import { useState } from 'react';
import { Sparkles, Check, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

interface Suggestions {
  phone?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  skills: string[];
}

type LinkField = 'phone' | 'linkedinUrl' | 'githubUrl' | 'portfolioUrl';
const LINK_FIELDS: LinkField[] = ['phone', 'linkedinUrl', 'githubUrl', 'portfolioUrl'];

// EPIC B1 — "Suggest from CV". Pulls high-precision suggestions from the stored
// CV (local parse, no AI) and lets the user apply each one into the form. The
// parent owns the form, so applying is delegated via callbacks.
export function CvSuggestPanel({
  targetUserId,
  onApplyField,
  onApplySkills,
}: {
  targetUserId: string;
  onApplyField: (field: LinkField, value: string) => void;
  onApplySkills: (skills: string[]) => void;
}) {
  const t = useT();
  const c = t.cvSuggest;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sugg, setSugg] = useState<Suggestions | null>(null);
  const [applied, setApplied] = useState<Record<string, boolean>>({});

  const run = async () => {
    setLoading(true); setError(''); setSugg(null);
    try {
      const res = await fetch(`/api/cv/${targetUserId}/suggest`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || c.failed);
      setSugg(body.suggestions as Suggestions);
    } catch (e) {
      setError(e instanceof Error ? e.message : c.failed);
    } finally {
      setLoading(false);
    }
  };

  const fieldLabel = (f: LinkField) => (c.fields as Record<string, string>)[f] ?? f;
  const linkCount = sugg ? LINK_FIELDS.filter((f) => sugg[f]).length : 0;
  const nothing = sugg && linkCount === 0 && sugg.skills.length === 0;

  return (
    <div className="mt-3">
      <Button type="button" variant="outline" size="sm" loading={loading} onClick={run}>
        <Sparkles className="h-4 w-4 mr-1" /> {c.button}
      </Button>
      <p className="text-xs text-gray-400 mt-1">{c.hint}</p>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      {sugg && (
        <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
          {nothing && <p className="text-sm text-gray-500">{c.none}</p>}

          {LINK_FIELDS.filter((f) => sugg[f]).map((f) => (
            <div key={f} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-400">{fieldLabel(f)}</p>
                <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{sugg[f]}</p>
              </div>
              <button
                type="button"
                disabled={applied[f]}
                onClick={() => { onApplyField(f, sugg[f]!); setApplied((a) => ({ ...a, [f]: true })); }}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-gray-800 disabled:text-green-600 disabled:border-green-200"
              >
                {applied[f] ? <><Check className="h-3.5 w-3.5" /> {c.applied}</> : <><Plus className="h-3.5 w-3.5" /> {c.apply}</>}
              </button>
            </div>
          ))}

          {sugg.skills.length > 0 && (
            <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs text-gray-400">{c.skills} ({sugg.skills.length})</p>
                <button
                  type="button"
                  disabled={applied.skills}
                  onClick={() => { onApplySkills(sugg.skills); setApplied((a) => ({ ...a, skills: true })); }}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-gray-800 disabled:text-green-600 disabled:border-green-200"
                >
                  {applied.skills ? <><Check className="h-3.5 w-3.5" /> {c.applied}</> : <><Plus className="h-3.5 w-3.5" /> {c.applyAll}</>}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {sugg.skills.map((s) => (
                  <span key={s} className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">{s}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
