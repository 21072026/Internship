'use client';
import { useT, useLocale } from "@/i18n/client";
import { mentorshipAssignmentError } from "@/lib/mentorshipAssignmentError";
import Link from "next/link";

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MentorshipRequestQueue } from '@/components/admin/MentorshipRequestQueue';
import { Select } from '@/components/ui/Select';
import { SavedViews } from '@/components/SavedViews';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { BookOpen, Plus } from 'lucide-react';
import { formatDate } from '@/lib/relativeTime';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { formatMentorAvailability } from '@/lib/mentorAvailabilityLabel';
import type { MentorAvailability } from '@/lib/mentorAvailability';
import { PersonHoverCard } from '@/components/PersonHoverCard';

// The assign dropdowns show a name plus capacity/availability (#942), so this
// asks the API for the `mentorAvailability` field set — still no email/phone/
// university in the response (#855).
interface User {
  id: string;
  fullName: string;
  role: string;
  mentorCapacity: number | null;
  activeMenteeCount: number;
  availability: MentorAvailability;
}

interface Company {
  id: string;
  name: string;
}

interface MentorshipRelation {
  id: string;
  status: string;
  startDate: string;
  // How the pairing ended, when COMPLETED does not say it (#1801/#2289). The
  // list shows it, because a pairing the mentee left is not a pairing that
  // finished and a row that renders both as "Completed" is the falsehood these
  // workflows exist to remove.
  lifecycleState?: string | null;
  mentor: { id: string; fullName: string; email: string };
  mentee: { id: string; fullName: string; email: string };
  company: { id: string; name: string } | null;
  _count: { interactions: number };
}

/**
 * The pairing whose mentor is being changed (#2289). A minimal shape, not a
 * MentorshipRelation: the same dialog is opened from the assign form's
 * `already_mentored` refusal, where all the server gives us is the relation id
 * and the current mentor's name — the mentor's own id is unknown there, and the
 * server refuses `same_mentor` anyway.
 */
interface TransferTarget {
  relationId: string;
  menteeId: string | null;
  menteeName: string;
  mentorId: string | null;
  mentorName: string | null;
}

/** The expected role for a picker first, everyone else after, names sorted. */
function sortForPicker(users: User[], expected: string): User[] {
  return [...users].sort((a, b) => {
    if ((a.role === expected) !== (b.role === expected)) return a.role === expected ? -1 : 1;
    return a.fullName.localeCompare(b.fullName);
  });
}

export default function MentorshipPage() {
  const t = useT();
  const locale = useLocale();
  const [relations, setRelations] = useState<MentorshipRelation[]>([]);
  const [total, setTotal] = useState(0);
  const [mentors, setMentors] = useState<User[]>([]);
  const [mentees, setMentees] = useState<User[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const assignDialogRef = useModalFocus<HTMLDivElement>(showForm, () => setShowForm(false));
  const [formData, setFormData] = useState({ mentorId: '', menteeId: '', companyId: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'COMPLETED'>('ALL');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  // Confirmation held for a picked mentor whose server-reported
  // availability.status is at_capacity/not_accepting (#942) — read straight
  // off the `mentors` list already fetched from /api/users?view=mentorAvailability,
  // never recomputed here.
  const [pendingConfirm, setPendingConfirm] = useState<'at_capacity' | 'not_accepting' | null>(null);
  // Change mentor (#2289): the target pairing, the form, and the outcome line.
  const [transferTarget, setTransferTarget] = useState<TransferTarget | null>(null);
  const [transferData, setTransferData] = useState({ toMentorId: '', reasonCode: '', reasonNote: '' });
  const [transferError, setTransferError] = useState('');
  const [transferring, setTransferring] = useState(false);
  // Which of the two things the server did — 'corrected' or 'transferred' — is
  // its answer, not a guess here: the admin needs to know whether a record was
  // closed behind them.
  const [notice, setNotice] = useState('');
  const transferDialogRef = useModalFocus<HTMLDivElement>(transferTarget !== null, () =>
    setTransferTarget(null)
  );
  // The mentor named by an `already_mentored` refusal, so the assign dialog can
  // offer the change instead of only reporting the wall (#2289).
  const [assignBlocked, setAssignBlocked] = useState<{ relationId: string; mentorName: string | null } | null>(null);

  const fetchRelations = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (search) params.set('search', search);
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/mentorship?${params}`);
      const data = await res.json();
      setRelations(data.relations || []);
      setTotal(typeof data.total === 'number' ? data.total : (data.relations?.length ?? 0));
    } catch {
      setError(t.mentorships.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search, page, t.mentorships.loadFailed]);

  const fetchPickers = async () => {
    try {
      const [usersRes, companiesRes] = await Promise.all([
        fetch('/api/users?view=mentorAvailability'),
        fetch('/api/companies'),
      ]);
      const [usersData, companiesData] = await Promise.all([usersRes.json(), companiesRes.json()]);
      // Both pickers hold the same people (#1141): admins mentor, and a mentor
      // can be mentored in turn. `sortForPicker` keeps each list's usual role
      // first, so the common case still reads as "pick a mentor / pick a mentee".
      const participants = (usersData.users || []).filter((u: User) =>
        ['ADMIN', 'MENTOR', 'MENTEE'].includes(u.role)
      );
      setMentors(sortForPicker(participants, 'MENTOR'));
      setMentees(sortForPicker(participants, 'MENTEE'));
      setCompanies(companiesData.companies || []);
    } catch {
      setError(t.mentorships.loadFailed);
    }
  };

  useEffect(() => {
    fetchPickers();
  }, []);

  useEffect(() => {
    const timeout = setTimeout(fetchRelations, 300);
    return () => clearTimeout(timeout);
  }, [fetchRelations]);

  // Any filter change returns to the first page.
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const handleCreate = async () => {
    if (!formData.mentorId || !formData.menteeId) {
      setFormError(t.mentorships.mentorMenteeRequired);
      return;
    }
    setSubmitting(true);
    setFormError('');
    setAssignBlocked(null);
    try {
      const res = await fetch('/api/mentorship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mentorId: formData.mentorId,
          menteeId: formData.menteeId,
          companyId: formData.companyId || undefined,
        }),
      });
      if (!res.ok) {
        // Switch on the body's `code`, never on the status: 409 is
        // already_mentored (#419) today but the route also answers 403 for the
        // plan gate, and a future 409 may mean something else. The server's
        // `error` string is English literal text and is never rendered — the
        // shared resolver translates every code this route can answer,
        // including the plan gate's quota sentence (#2283 follow-up).
        const body = await res.json().catch(() => ({}));
        setFormError(mentorshipAssignmentError(t, body, t.mentorships.assignFailed));
        // A correct refusal the admin could not act on is how people learn to
        // fake a completion (#2289): the route names the current mentor and
        // their relation, so offer the change right here instead of leaving
        // them to work out the close-then-assign sequence.
        if (body?.code === 'already_mentored' && body.activeRelationId) {
          setAssignBlocked({ relationId: body.activeRelationId, mentorName: body.activeMentorName ?? null });
        }
        return;
      }
      await fetchRelations();
      setShowForm(false);
      setFormData({ mentorId: '', menteeId: '', companyId: '' });
    } catch {
      setFormError(t.mentorships.assignFailed);
    } finally {
      setSubmitting(false);
    }
  };

  // Gate before handleCreate (#942): interrupts with a confirmation dialog
  // only when the picked mentor's own availability.status is at_capacity/
  // not_accepting. An available mentor — or a picker that failed to load
  // availability at all — goes straight through, same as before #942.
  const submitCreate = () => {
    if (!formData.mentorId || !formData.menteeId) {
      setFormError(t.mentorships.mentorMenteeRequired);
      return;
    }
    const status = mentors.find((m) => m.id === formData.mentorId)?.availability?.status;
    if (status === 'at_capacity' || status === 'not_accepting') {
      setPendingConfirm(status);
      return;
    }
    handleCreate();
  };

  const confirmCreate = () => {
    setPendingConfirm(null);
    handleCreate();
  };

  const handleComplete = async (id: string) => {
    await fetch(`/api/mentorship/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED' }),
    });
    await fetchRelations();
  };

  // Reassign (or clear) the company on an existing mentorship. The backend PUT
  // already accepts companyId; this just exposes it in the UI.
  const handleChangeCompany = async (id: string, companyId: string) => {
    await fetch(`/api/mentorship/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: companyId || null }),
    });
    await fetchRelations();
  };

  const openTransfer = (target: TransferTarget, presetMentorId = '') => {
    setNotice('');
    setTransferError('');
    setTransferData({ toMentorId: presetMentorId, reasonCode: '', reasonNote: '' });
    setTransferTarget(target);
  };

  const submitTransfer = async () => {
    if (!transferTarget) return;
    // Client-side mirrors of the server's own refusals, so the common mistakes
    // cost no round trip. The server re-checks all three — this is convenience,
    // not the rule (src/app/api/mentorship/[id]/transfer/route.ts).
    if (!transferData.toMentorId) {
      setTransferError(t.changeMentor.selectNewMentor);
      return;
    }
    if (!transferData.reasonCode) {
      setTransferError(t.changeMentor.reasonRequired);
      return;
    }
    if (transferData.reasonCode === 'other' && !transferData.reasonNote.trim()) {
      setTransferError(t.changeMentor.noteRequired);
      return;
    }
    setTransferring(true);
    setTransferError('');
    try {
      const res = await fetch(`/api/mentorship/${transferTarget.relationId}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toMentorId: transferData.toMentorId,
          reasonCode: transferData.reasonCode,
          reasonNote: transferData.reasonNote.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Same shared resolver as the assign dialog: switch on `code`, never on
        // the status, and never render the server's English `error` literal.
        setTransferError(mentorshipAssignmentError(t, body, t.changeMentor.failed));
        return;
      }
      // Say which of the two things happened. An admin who is not told whether
      // a pairing was closed behind them has to go and look.
      const template =
        body.mode === 'corrected' ? t.changeMentor.correctedResult : t.changeMentor.transferredResult;
      setNotice(
        template
          .replace('{mentee}', transferTarget.menteeName)
          .replace('{mentor}', String(body.mentorName ?? ''))
      );
      setTransferTarget(null);
      setAssignBlocked(null);
      setShowForm(false);
      await fetchRelations();
    } catch {
      setTransferError(t.changeMentor.failed);
    } finally {
      setTransferring(false);
    }
  };

  // Someone whose role isn't the one this picker is for carries a role suffix, so
  // "assign a mentor's mentor" is a deliberate choice rather than a surprise. The
  // person already picked on the other side drops out — nobody mentors themselves.
  const roleSuffix = (role: string, expected: string) =>
    role === expected
      ? ''
      : ` · ${role === 'ADMIN' ? t.modeSwitch.admin : role === 'MENTOR' ? t.modeSwitch.mentor : t.modeSwitch.mentee}`;
  // Full or paused mentors stay in the list and stay selectable (#942) — the
  // capacity/status suffix is advisory only, never a filter or a disable.
  const mentorOptions = mentors
    .filter((m) => m.id !== formData.menteeId)
    .map((m) => ({
      value: m.id,
      label: `${m.fullName}${roleSuffix(m.role, 'MENTOR')} · ${formatMentorAvailability(m, t.mentorAvailability)}`,
    }));
  const menteeOptions = mentees
    .filter((m) => m.id !== formData.mentorId)
    .map((m) => ({ value: m.id, label: m.fullName + roleSuffix(m.role, 'MENTEE') }));
  const companyOptions = [
    { value: '', label: t.mentorships.noCompany },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
  ];
  // The change-mentor picker drops the two people it cannot be: the mentee, and
  // the mentor they already have. Full or paused mentors stay selectable here
  // for the same reason as above, and one more: an admin moving a mentee off a
  // mentor who left has to be able to put them somewhere.
  const transferMentorOptions = mentors
    .filter((m) => m.id !== transferTarget?.mentorId && m.id !== transferTarget?.menteeId)
    .map((m) => ({
      value: m.id,
      label: `${m.fullName}${roleSuffix(m.role, 'MENTOR')} · ${formatMentorAvailability(m, t.mentorAvailability)}`,
    }));
  // Order fixed here, not by iterating the reason dictionary: the two admin-only
  // codes belong at the end, and `wrong_assignment` is the one an admin reaches
  // for most (they just picked the wrong name), so it leads them.
  const END_REASON_ORDER = [
    'wrong_assignment',
    'mentor_unavailable',
    'no_fit',
    'changed_goals',
    'mentee_request',
    'other',
  ] as const;
  const reasonOptions = END_REASON_ORDER.map((code) => ({
    value: code,
    label: t.changeMentor.reasons[code],
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentorships.title}</h1>
          <p className="text-gray-500 mt-1">{t.mentorships.subtitle}</p>
        </div>
        <Button
          onClick={() => {
            // A stale refusal from the last attempt must not greet the next one.
            setFormError('');
            setAssignBlocked(null);
            setShowForm(true);
          }}
        >
          <Plus className="h-4 w-4" />
          {t.mentorships.assign}
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {notice && (
        <div
          data-testid="mentorship-notice"
          className="mb-4 flex items-start justify-between gap-3 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm"
        >
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} className="shrink-0 font-medium underline">
            {t.changeMentor.dismiss}
          </button>
        </div>
      )}

      <MentorshipRequestQueue mentors={mentors} onApproved={() => fetchRelations()} />

      {/* Create Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            ref={assignDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mentorship-assign-title"
            tabIndex={-1}
            className="bg-white rounded-2xl p-6 w-full max-w-md"
          >
            <h2 id="mentorship-assign-title" className="text-xl font-bold text-gray-900 mb-6">{t.mentorships.assign}</h2>
            {formError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{formError}</div>
            )}
            {assignBlocked && (
              <div
                data-testid="assign-blocked-offer"
                className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-sm"
              >
                {assignBlocked.mentorName && (
                  <p className="mb-2">
                    {t.changeMentor.alreadyMentoredOffer.replace('{mentor}', assignBlocked.mentorName)}
                  </p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="change-mentor-instead"
                  onClick={() => {
                    // The assign dialog steps aside — two stacked modals would
                    // both be aria-modal and trap focus against each other.
                    setShowForm(false);
                    openTransfer(
                      {
                        relationId: assignBlocked.relationId,
                        menteeId: formData.menteeId || null,
                        menteeName:
                          mentees.find((m) => m.id === formData.menteeId)?.fullName ?? t.mentorships.mentee,
                        // Unknown from a 409 body — see TransferTarget. The
                        // picker therefore cannot pre-drop the current mentor,
                        // and the server answers `same_mentor` if they are picked.
                        mentorId: null,
                        mentorName: assignBlocked.mentorName,
                      },
                      // The mentor the admin had already chosen carries over —
                      // that is the assignment they were trying to make.
                      formData.mentorId
                    );
                  }}
                >
                  {t.changeMentor.changeInstead}
                </Button>
              </div>
            )}
            <div className="space-y-4">
              <Select
                label={t.mentorships.mentor}
                required
                options={mentorOptions}
                placeholder={t.mentorships.selectMentor}
                value={formData.mentorId}
                onChange={(e) => setFormData((p) => ({ ...p, mentorId: e.target.value }))}
              />
              <Select
                label={t.mentorships.mentee}
                required
                options={menteeOptions}
                placeholder={t.mentorships.selectMentee}
                value={formData.menteeId}
                onChange={(e) => setFormData((p) => ({ ...p, menteeId: e.target.value }))}
              />
              <Select
                label={t.mentorships.companyOptional}
                options={companyOptions}
                value={formData.companyId}
                onChange={(e) => setFormData((p) => ({ ...p, companyId: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <Button variant="outline" onClick={() => setShowForm(false)}>{t.common.cancel}</Button>
              <Button onClick={submitCreate} loading={submitting}>{t.mentorships.assignSubmit}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Change mentor (#2289) — one dialog for both outcomes; which one applies
          is the server's call, decided from the pairing's own history. */}
      {transferTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            ref={transferDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="change-mentor-title"
            tabIndex={-1}
            data-testid="change-mentor-dialog"
            className="bg-white rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto"
          >
            <h2 id="change-mentor-title" className="text-xl font-bold text-gray-900 mb-2">
              {t.changeMentor.title}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {t.changeMentor.context
                .replace('{mentee}', transferTarget.menteeName)
                .replace('{mentor}', transferTarget.mentorName ?? t.common.none)}
            </p>
            <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4">
              {t.changeMentor.hint}
            </p>
            {transferError && (
              <div
                data-testid="change-mentor-error"
                className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm"
              >
                {transferError}
              </div>
            )}
            <div className="space-y-4">
              <Select
                label={t.changeMentor.newMentor}
                required
                data-testid="change-mentor-select"
                options={transferMentorOptions}
                placeholder={t.changeMentor.selectNewMentor}
                value={transferData.toMentorId}
                onChange={(e) => setTransferData((p) => ({ ...p, toMentorId: e.target.value }))}
              />
              <Select
                label={t.changeMentor.reason}
                required
                data-testid="change-mentor-reason"
                options={reasonOptions}
                placeholder={t.changeMentor.selectReason}
                value={transferData.reasonCode}
                onChange={(e) => setTransferData((p) => ({ ...p, reasonCode: e.target.value }))}
              />
              <div>
                <label htmlFor="change-mentor-note" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.changeMentor.note}
                </label>
                <textarea
                  id="change-mentor-note"
                  data-testid="change-mentor-note"
                  rows={3}
                  value={transferData.reasonNote}
                  onChange={(e) => setTransferData((p) => ({ ...p, reasonNote: e.target.value }))}
                  placeholder={t.changeMentor.notePlaceholder}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                />
              </div>
              <p className="text-xs text-gray-500">{t.changeMentor.privacy}</p>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <Button variant="outline" onClick={() => setTransferTarget(null)}>
                {t.common.cancel}
              </Button>
              <Button onClick={submitTransfer} loading={transferring} data-testid="change-mentor-submit">
                {t.changeMentor.submit}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingConfirm !== null}
        message={pendingConfirm === 'at_capacity' ? t.assignMentor.confirmAtCapacity : t.assignMentor.confirmNotAccepting}
        cancelLabel={t.common.cancel}
        confirmLabel={t.assignMentor.confirmAnyway}
        loading={submitting}
        onConfirm={confirmCreate}
        onCancel={() => setPendingConfirm(null)}
      />

      {/* Search + status filter */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(['ALL', 'ACTIVE', 'COMPLETED'] as const).map((sf) => (
          <button
            key={sf}
            onClick={() => setStatusFilter(sf)}
            className={`min-h-11 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === sf ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {sf === 'ALL' ? t.usersAdmin.all : sf === 'ACTIVE' ? t.mentorships.active : t.mentorships.completed}
          </button>
        ))}
        <input
          type="search"
          data-testid="mentorship-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.mentorships.searchPlaceholder}
          className="ml-auto min-h-11 w-full sm:w-64 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
        />
      </div>
      <div className="mb-4">
        <SavedViews
          storageKey="mentorship-views"
          current={{ search, statusFilter }}
          onApply={(f) => {
            setSearch(f.search || '');
            setStatusFilter((f.statusFilter as 'ALL' | 'ACTIVE' | 'COMPLETED') || 'ALL');
          }}
        />
      </div>

      {/* Relations */}
      {loading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : relations.length === 0 ? (
        <Card className="text-center py-12">
          <BookOpen className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t.mentorships.none}</p>
        </Card>
      ) : (() => {
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        return (
        <div className="space-y-4">
          {relations.map((rel) => (
            <Card key={rel.id} data-testid={`mentorship-row-${rel.id}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2">
                    <Link href={`/admin/candidates/${rel.mentee.id}`} className="font-semibold text-gray-900 hover:text-blue-700 hover:underline">{rel.mentee.fullName}</Link>
                    <span className="text-gray-400">→</span>
                    <span className="font-semibold text-gray-900">
                      <PersonHoverCard personId={rel.mentor.id} name={rel.mentor.fullName} role="MENTOR" />
                    </span>
                    <StatusBadge status={rel.status} />
                    {/* A pairing the mentee left did not finish. Rendering both
                        as plain "Completed" is the record #1801/#2289 exist to
                        stop being written. */}
                    {(rel.lifecycleState === 'ENDED_REASSIGNED' ||
                      rel.lifecycleState === 'ENDED_REMATCHED') && (
                      <Badge variant="warning" data-testid="lifecycle-badge">
                        {rel.lifecycleState === 'ENDED_REASSIGNED'
                          ? t.changeMentor.badgeReassigned
                          : t.rematchRequest.badge}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
                    {rel.company && (
                      <span>🏢 {rel.company.name}</span>
                    )}
                    <span>📅 {t.mentorships.started} {formatDate(rel.startDate, locale)}</span>
                    <Badge variant="default">{rel._count.interactions} {t.mentorships.interactions}</Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-2 w-full sm:w-auto sm:items-end sm:shrink-0">
                  <Select
                    aria-label={t.mentorships.changeCompany}
                    options={companyOptions}
                    value={rel.company?.id ?? ''}
                    onChange={(e) => handleChangeCompany(rel.id, e.target.value)}
                    className="w-full sm:w-44"
                  />
                  {rel.status === 'ACTIVE' && (
                    <div className="flex flex-col gap-2 w-full sm:w-auto sm:flex-row">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        data-testid={`change-mentor-${rel.id}`}
                        onClick={() =>
                          openTransfer({
                            relationId: rel.id,
                            menteeId: rel.mentee.id,
                            menteeName: rel.mentee.fullName,
                            mentorId: rel.mentor.id,
                            mentorName: rel.mentor.fullName,
                          })
                        }
                      >
                        {t.changeMentor.action}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => handleComplete(rel.id)}
                      >
                        {t.mentorships.markComplete}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t.common.prev}</Button>
              <span className="text-sm text-gray-500">{page} / {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>{t.common.next}</Button>
            </div>
          )}
        </div>
        );
      })()}
    </div>
  );
}
