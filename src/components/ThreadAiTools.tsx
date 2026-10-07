'use client';

import { useState } from 'react';
import { Sparkles, RefreshCw, X } from 'lucide-react';
import { useT } from '@/i18n/client';
import { AiText } from '@/components/ai/AiText';

// Thread catch-up and suggested replies (#2048). Both ask the server
// (POST /api/conversations/[id]/summary | suggest-reply), which decides who may
// ask, whose consent it needs and whether a stored answer will do. A suggested
// reply only ever comes back as TEXT for the composer — this component has no
// way to send anything, by construction: it hands the draft to `onDraft`.

type Failure = 'consent_required' | 'quota_exceeded' | 'provider_error' | 'not_configured' | 'generic';

function useFailureText() {
  const t = useT();
  const A = t.messages.ai;
  return (f: Failure) =>
    f === 'consent_required' ? A.consentRequired
      : f === 'quota_exceeded' ? A.quotaExceeded
        : f === 'provider_error' ? A.providerError
          : f === 'not_configured' ? A.notConfigured
            : A.failed;
}

async function ask(url: string, body: object): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; failure: Failure }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data };
    const code = data.code as string | undefined;
    const known: Failure[] = ['consent_required', 'quota_exceeded', 'provider_error', 'not_configured'];
    return { ok: false, failure: known.includes(code as Failure) ? (code as Failure) : 'generic' };
  } catch {
    return { ok: false, failure: 'generic' };
  }
}

export function ThreadCatchUp({ conversationId }: { conversationId: string }) {
  const t = useT();
  const A = t.messages.ai;
  const failureText = useFailureText();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (regenerate = false) => {
    setBusy(true);
    setError(null);
    const r = await ask(`/api/conversations/${encodeURIComponent(conversationId)}/summary`, regenerate ? { regenerate: true } : {});
    setBusy(false);
    if (!r.ok) { setError(failureText(r.failure)); return; }
    setSummary(typeof r.data.summary === 'string' ? r.data.summary : null);
    setCached(Boolean(r.data.cached));
  };

  return (
    <div className="mb-3" data-testid="thread-catchup">
      {summary === null ? (
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          data-testid="thread-catchup-button"
        >
          <Sparkles className="h-3.5 w-3.5 text-violet-600" aria-hidden />
          {busy ? A.working : A.catchUp}
        </button>
      ) : (
        <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm dark:border-violet-900" data-testid="thread-catchup-summary">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-800">
              <Sparkles className="h-3.5 w-3.5" aria-hidden /> {A.catchUpTitle}
              {cached && <span className="font-normal text-violet-600">· {A.saved}</span>}
            </p>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => void run(true)} disabled={busy} aria-label={A.regenerate} title={A.regenerate} className="rounded p-1 text-violet-700 hover:bg-violet-100">
                <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
              </button>
              <button type="button" onClick={() => setSummary(null)} aria-label={A.close} className="rounded p-1 text-violet-700 hover:bg-violet-100">
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>
          <AiText as="p" text={summary} className="text-gray-800" />
          <p className="mt-2 text-xs text-violet-700">{A.disclaimer}</p>
        </div>
      )}
      {error && <p className="mt-1.5 text-xs text-red-600" role="alert" data-testid="thread-catchup-error">{error}</p>}
    </div>
  );
}

export function SuggestReply({ conversationId, onDraft }: { conversationId: string; onDraft: (text: string) => void }) {
  const t = useT();
  const A = t.messages.ai;
  const failureText = useFailureText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (tone: 'brief' | 'warm' | 'formal') => {
    setBusy(tone);
    setError(null);
    const r = await ask(`/api/conversations/${encodeURIComponent(conversationId)}/suggest-reply`, { tone });
    setBusy(null);
    if (!r.ok) { setError(failureText(r.failure)); return; }
    if (typeof r.data.draft === 'string' && r.data.draft) { onDraft(r.data.draft); setOpen(false); }
  };

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex shrink-0 items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
        data-testid="suggest-reply-toggle"
      >
        <Sparkles className="h-3.5 w-3.5 text-violet-600" aria-hidden />
        {A.suggestReply}
      </button>
      {open && (
        <span className="absolute bottom-full left-0 z-20 mb-1 flex flex-col gap-1 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900" data-testid="suggest-reply-tones">
          <span className="px-1 text-[11px] text-gray-400">{A.toneHint}</span>
          {(['brief', 'warm', 'formal'] as const).map((tone) => (
            <button
              key={tone}
              type="button"
              disabled={busy !== null}
              onClick={() => void run(tone)}
              className="whitespace-nowrap rounded-md px-2 py-1 text-left text-xs text-gray-700 hover:bg-violet-50 disabled:opacity-60 dark:text-gray-200 dark:hover:bg-gray-800"
              data-testid={`suggest-reply-${tone}`}
            >
              {busy === tone ? A.working : A.tones[tone]}
            </button>
          ))}
          {error && <span className="max-w-[16rem] px-1 text-[11px] text-red-600" role="alert" data-testid="suggest-reply-error">{error}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * The mentor's grounded draft for this mentee (#2048, part 2): the first
 * message, a check-in to a quiet mentee, or the outcome note — the server
 * picks the moment from the relation's state and writes in the mentee's
 * language. Like the suggested reply it only ever comes back as text.
 */
export function MentorDraft({ relationId, onDraft }: { relationId: string; onDraft: (text: string) => void }) {
  const t = useT();
  const A = t.messages.ai;
  const failureText = useFailureText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await ask(`/api/mentorship/${encodeURIComponent(relationId)}/ai-draft`, { moment: 'auto' });
    setBusy(false);
    if (!r.ok) { setError(failureText(r.failure)); return; }
    const draft = r.data.draft as { body?: string } | undefined;
    if (draft?.body) onDraft(draft.body);
  };

  return (
    <span className="relative inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="inline-flex shrink-0 items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-60"
        data-testid="mentor-ai-draft"
      >
        <Sparkles className="h-3.5 w-3.5 text-violet-600" aria-hidden />
        {busy ? A.working : A.draftForMentee}
      </button>
      {error && <span className="text-[11px] text-red-600" role="alert" data-testid="mentor-ai-draft-error">{error}</span>}
    </span>
  );
}
