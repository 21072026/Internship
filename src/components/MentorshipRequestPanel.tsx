'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Send, Clock, CheckCircle2, XCircle, ListChecks } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { useT } from '@/i18n/client';

interface Gate { profile: boolean; cv: boolean; complete: boolean; missing: ('profile' | 'cv')[] }

interface RequestRow {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  message?: string | null;
  preferredMentor?: { id: string; fullName: string } | null;
  createdAt: string;
  decidedAt?: string | null;
}

// Directory mentors for the optional "preferred mentor" picker (#939) — the
// consent-gated GET /api/mentors contract (story #900).
interface DirectoryMentor {
  id: string;
  fullName: string;
  displayName?: string | null;
}

// Mentee-side "request a mentor" panel (#590), shown on the portal dashboard
// while the mentee has no active mentorship. One PENDING request at a time;
// the latest decision stays visible.
export function MentorshipRequestPanel() {
  const t = useT();
  const q = t.mentorshipRequests;
  const dir = t.mentorDirectory;
  // "Request this mentor" deep link (#1773): the directory card and the public
  // profile both link here as /portal?mentor=<id>. It only ever PRESELECTS the
  // picker below — POST /api/mentorship-requests re-validates the id against
  // active MENTOR + publicProfile + a live MENTOR_DIRECTORY_VISIBILITY consent,
  // and that server rule is the only thing that decides.
  const searchParams = useSearchParams();
  const requestedMentorId = searchParams.get('mentor') ?? '';
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [message, setMessage] = useState('');
  // Matching preferences (#939): free-text field, comma-separated languages,
  // and an optional preferred mentor from the consent-gated directory.
  const [preferredField, setPreferredField] = useState('');
  const [preferredLanguages, setPreferredLanguages] = useState('');
  const [preferredMentorId, setPreferredMentorId] = useState('');
  const [mentors, setMentors] = useState<DirectoryMentor[]>([]);
  // The ?mentor=<id> deep link is resolved by its OWN lookup, kept separate
  // from the picker's page of options — see the effects below.
  const [requestedMentor, setRequestedMentor] = useState<DirectoryMentor | null>(null);
  const [requestedMentorChecked, setRequestedMentorChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () =>
    fetch('/api/mentorship-requests')
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((d) => { setRequests(d.requests ?? []); setGate(d.gate ?? null); })
      .catch(() => setRequests([]));

  useEffect(() => { load(); }, []);

  // Only directory-visible mentors are offered — the same set the server
  // accepts as preferredMentorId. A failed fetch just leaves the picker empty.
  // This is the picker's page of OPTIONS, nothing more: it is capped at the
  // API's maximum of 50 while the directory itself pages through up to 500, so
  // "not in here" says nothing about whether a given mentor exists.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/mentors?pageSize=50')
      .then((r) => (r.ok ? r.json() : { mentors: [] }))
      .then((d) => { if (!cancelled) setMentors(d.mentors ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Resolve ?mentor=<id> with a lookup of its own (`mentorId=` re-runs the same
  // consent-gated where-clause for that one id). Deriving this from the paged
  // list instead would misreport the 51st directory mentor as gone, and would
  // turn any failed fetch into a positive claim that the mentor is gone: the
  // `checked` flag is set ONLY on a successful response, so a 401/500/offline
  // falls back to silence rather than to a wrong answer.
  useEffect(() => {
    if (!requestedMentorId) return;
    let cancelled = false;
    fetch(`/api/mentors?mentorId=${encodeURIComponent(requestedMentorId)}&pageSize=1`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('mentor lookup failed'))))
      .then((d: { mentors?: DirectoryMentor[] }) => {
        if (cancelled) return;
        setRequestedMentor(d.mentors?.[0] ?? null);
        setRequestedMentorChecked(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [requestedMentorId]);

  // Seed the picker once the id has resolved to a real, directory-visible
  // mentor. The picker stays editable — a later manual choice is never
  // overwritten, because this only fills a still-empty value.
  useEffect(() => {
    if (!requestedMentor) return;
    setPreferredMentorId((current) => current || requestedMentor.id);
  }, [requestedMentor]);

  if (!requests) return null;
  // The resolved mentor may sit past the picker's first page, so it is merged
  // into the options — otherwise the deep link would preselect a value the
  // <Select> cannot render, and the "pick another one" advice below would point
  // at a list that does not contain the mentor in question.
  const mentorOptions =
    requestedMentor && !mentors.some((m) => m.id === requestedMentor.id)
      ? [...mentors, requestedMentor]
      : mentors;
  // Only claim a mentor is gone when the lookup actually said so, and only
  // while nothing is selected — once the mentee picks someone the notice would
  // contradict the confirmation line right above it.
  const requestedMentorMissing =
    Boolean(requestedMentorId) && requestedMentorChecked && !requestedMentor && !preferredMentorId;
  const selectedMentor = mentorOptions.find((m) => m.id === preferredMentorId);
  const pending = requests.find((r) => r.status === 'PENDING');
  const latest = requests[0];

  const submit = async () => {
    setBusy(true);
    setErr('');
    const languages = preferredLanguages
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    try {
      const res = await fetch('/api/mentorship-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: message.trim() || undefined,
          preferredField: preferredField.trim() || undefined,
          preferredLanguages: languages.length ? languages : undefined,
          preferredMentorId: preferredMentorId || undefined,
        }),
      });
      if (res.ok) {
        setMessage('');
        setPreferredField('');
        setPreferredLanguages('');
        setPreferredMentorId('');
        await load();
      } else {
        const d = await res.json().catch(() => ({}));
        if (d.code === 'rate_limited') setErr(q.rateLimited);
        else if (d.code === 'already_pending') setErr(q.alreadyPending);
        else setErr(d.error || t.common.error);
      }
    } catch {
      setErr(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-6" data-testid="mentorship-request">
      <CardHeader><CardTitle>{q.title}</CardTitle></CardHeader>
      {pending ? (
        <>
          <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2" data-testid="request-pending">
            <Clock className="h-4 w-4" /> {q.pendingInfo}
          </p>
          {/* A "request this mentor" click that lands here has nowhere to go —
              the form is hidden while a request is pending. Say so, rather than
              dropping the ?mentor= param without a trace (#1773). Not when the
              pending request already names that mentor, though: that is the
              state a successful submit from this very panel leaves behind, and
              "not added" would be exactly backwards. */}
          {requestedMentorId && pending.preferredMentor?.id !== requestedMentorId && (
            <p
              className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700"
              data-testid="request-preferred-mentor-pending"
            >
              {dir.requestedMentorPending}
            </p>
          )}
        </>
      ) : (
        <>
          {latest?.status === 'APPROVED' && (
            <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-2 mb-3">
              <CheckCircle2 className="h-4 w-4" /> {q.approvedInfo}
            </p>
          )}
          {latest?.status === 'REJECTED' && (
            <p className="text-sm text-gray-600 dark:text-gray-300 flex items-center gap-2 mb-3">
              <XCircle className="h-4 w-4" /> {q.rejectedInfo}
            </p>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{q.hint}</p>
          {selectedMentor && (
            <p
              className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700"
              data-testid="request-preferred-mentor-confirmation"
            >
              {dir.requestingMentor.replace('{name}', selectedMentor.displayName || selectedMentor.fullName)}
            </p>
          )}
          {requestedMentorMissing && (
            <p
              className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700"
              data-testid="request-preferred-mentor-unavailable"
            >
              {dir.requestedMentorUnavailable}
            </p>
          )}
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={q.messagePlaceholder}
            rows={3}
            maxLength={TEXT_LIMITS.mentorshipRequestMessage}
            showCounter
            className="mb-2"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-1.5">
            <Input
              label={q.preferredFieldLabel}
              value={preferredField}
              onChange={(e) => setPreferredField(e.target.value)}
              placeholder={q.preferredFieldPlaceholder}
              maxLength={120}
              data-testid="request-preferred-field"
            />
            <Input
              label={q.preferredLanguagesLabel}
              value={preferredLanguages}
              onChange={(e) => setPreferredLanguages(e.target.value)}
              placeholder={q.preferredLanguagesPlaceholder}
              data-testid="request-preferred-languages"
            />
            <Select
              label={q.preferredMentorLabel}
              value={preferredMentorId}
              onChange={(e) => setPreferredMentorId(e.target.value)}
              options={[
                { value: '', label: q.preferredMentorNone },
                ...mentorOptions.map((m) => ({ value: m.id, label: m.displayName || m.fullName })),
              ]}
              data-testid="request-preferred-mentor"
            />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{q.preferencesHint}</p>
          {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
          {gate && !gate.complete && (
            <div className="mb-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 p-3" data-testid="request-gate">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5 mb-1">
                <ListChecks className="h-4 w-4" /> {q.gateTitle}
              </p>
              {/* `inline-block py-1.5` on the links, `space-y-1` between the
                  items: a bare `text-xs` link is a 16px-tall tap target, under
                  WCAG 2.2 AA 2.5.8's 24px floor (#826). 12px text + 6px padding
                  each side lands at 28px rather than exactly 24, so rounding
                  cannot put it back under. The spacing keeps the two adjacent
                  targets from colliding, which is the other half of that SC. */}
              <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc list-inside space-y-1">
                {gate.missing.includes('profile') && (
                  <li><Link href="/portal/profile" className="underline inline-block py-1.5">{q.gateProfile}</Link></li>
                )}
                {gate.missing.includes('cv') && (
                  <li><Link href="/portal/profile" className="underline inline-block py-1.5">{q.gateCv}</Link></li>
                )}
              </ul>
            </div>
          )}
          <Button type="button" loading={busy} disabled={!!gate && !gate.complete} onClick={submit} data-testid="request-submit">
            <Send className="h-4 w-4 mr-1" /> {q.submit}
          </Button>
        </>
      )}
    </Card>
  );
}
