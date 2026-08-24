'use client';
import { useT, useLocale } from "@/i18n/client";
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
  mentor: { id: string; fullName: string; email: string };
  mentee: { id: string; fullName: string; email: string };
  company: { id: string; name: string } | null;
  _count: { interactions: number };
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
        const body = await res.json();
        throw new Error(body.error || 'Failed');
      }
      await fetchRelations();
      setShowForm(false);
      setFormData({ mentorId: '', menteeId: '', companyId: '' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create');
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

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentorships.title}</h1>
          <p className="text-gray-500 mt-1">{t.mentorships.subtitle}</p>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" />
          {t.mentorships.assign}
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
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
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => handleComplete(rel.id)}
                    >
                      {t.mentorships.markComplete}
                    </Button>
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
