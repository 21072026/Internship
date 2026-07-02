'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Check, Plus, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

interface Suggestions {
  phone?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  skills: string[];
}

// AI (B3) additionally suggests these biographical fields.
interface AiSuggestions extends Suggestions {
  fullName?: string;
  city?: string;
  university?: string;
  department?: string;
  targetPosition?: string;
}

type LinkField = 'phone' | 'linkedinUrl' | 'githubUrl' | 'portfolioUrl';
const LINK_FIELDS: LinkField[] = ['phone', 'linkedinUrl', 'githubUrl', 'portfolioUrl'];
// Fields the AI flow can additionally apply.
const AI_FIELDS = ['fullName', 'city', 'university', 'department', 'targetPosition', 'phone', 'linkedinUrl', 'githubUrl', 'portfolioUrl'] as const;

// EPIC B1 — local "Suggest from CV" (no AI). EPIC B3 — optional AI extraction,
// shown only when the CV owner has granted AI_CV_PARSING consent and the server
// has an API key. The parent owns the form, so applying is delegated.
export function CvSuggestPanel({
  targetUserId,
  onApplyField,
  onApplySkills,
}: {
  targetUserId: string;
  onApplyField: (field: string, value: string) => void;
  onApplySkills: (skills: string[]) => void;
}) {
  const t = useT();
  const c = t.cvSuggest;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sugg, setSugg] = useState<Suggestions | null>(null);
  const [applied, setApplied] = useState<Record<string, boolean>>({});

  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiSugg, setAiSugg] = useState<AiSuggestions | null>(null);

  // Show the AI option only when the CV owner has consented (B2).
  useEffect(() => {
    fetch('/api/consent').then((r) => r.json())
      .then((d) => setAiEnabled(!!d.consents?.AI_CV_PARSING)).catch(() => {});
  }, []);

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

  const runAi = async () => {
    setAiLoading(true); setAiError(''); setAiSugg(null);
    try {
      const res = await fetch(`/api/cv/${targetUserId}/extract-ai`, { method: 'POST' });
      const body = await res.json();
      if (res.status === 501) throw new Error(c.aiNotConfigured);
      if (!res.ok) throw new Error(body.error || c.failed);
      setAiSugg((body.suggestions ?? { skills: [] }) as AiSuggestions);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : c.failed);
    } finally {
      setAiLoading(false);
    }
  };

  const fieldLabel = (f: string) => (c.fields as Record<string, string>)[f] ?? f;
  const linkCount = sugg ? LINK_FIELDS.filter((f) => sugg[f]).length : 0;
  const nothing = sugg && linkCount === 0 && sugg.skills.length === 0;
  const aiFilled = aiSugg ? AI_FIELDS.filter((f) => (aiSugg as unknown as Record<string, unknown>)[f]) : [];

  const applyBtn = (key: string, onClick: () => void, allLabel = false) => (
    <button
      type="button"
      disabled={applied[key]}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-gray-800 disabled:text-green-600 disabled:border-green-200"
    >
      {applied[key] ? <><Check className="h-3.5 w-3.5" /> {c.applied}</> : <><Plus className="h-3.5 w-3.5" /> {allLabel ? c.applyAll : c.apply}</>}
    </button>
  );

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" loading={loading} onClick={run}>
          <Sparkles className="h-4 w-4 mr-1" /> {c.button}
        </Button>
        {aiEnabled && (
          <Button type="button" variant="outline" size="sm" loading={aiLoading} onClick={runAi}>
            <Wand2 className="h-4 w-4 mr-1" /> {c.aiButton}
          </Button>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-1">{c.hint}</p>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      {aiError && <p className="text-xs text-red-600 mt-2">{aiError}</p>}

      {sugg && (
        <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
          {nothing && <p className="text-sm text-gray-500">{c.none}</p>}

          {LINK_FIELDS.filter((f) => sugg[f]).map((f) => (
            <div key={f} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-400">{fieldLabel(f)}</p>
                <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{sugg[f]}</p>
              </div>
              {applyBtn(f, () => { onApplyField(f, sugg[f]!); setApplied((a) => ({ ...a, [f]: true })); })}
            </div>
          ))}

          {sugg.skills.length > 0 && (
            <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs text-gray-400">{c.skills} ({sugg.skills.length})</p>
                {applyBtn('skills', () => { onApplySkills(sugg.skills); setApplied((a) => ({ ...a, skills: true })); }, true)}
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

      {aiSugg && (
        <div className="mt-3 rounded-lg border border-purple-200 dark:border-purple-900/50 p-3 space-y-3">
          <p className="text-xs font-medium text-purple-700 dark:text-purple-300 flex items-center gap-1"><Wand2 className="h-3.5 w-3.5" /> {c.aiButton}</p>
          {aiFilled.length === 0 && aiSugg.skills.length === 0 && <p className="text-sm text-gray-500">{c.none}</p>}

          {aiFilled.map((f) => (
            <div key={f} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-400">{fieldLabel(f)}</p>
                <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{(aiSugg as unknown as Record<string, string>)[f]}</p>
              </div>
              {applyBtn(`ai-${f}`, () => { onApplyField(f, (aiSugg as unknown as Record<string, string>)[f]); setApplied((a) => ({ ...a, [`ai-${f}`]: true })); })}
            </div>
          ))}

          {aiSugg.skills.length > 0 && (
            <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs text-gray-400">{c.skills} ({aiSugg.skills.length})</p>
                {applyBtn('ai-skills', () => { onApplySkills(aiSugg.skills); setApplied((a) => ({ ...a, 'ai-skills': true })); }, true)}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {aiSugg.skills.map((s) => (
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
