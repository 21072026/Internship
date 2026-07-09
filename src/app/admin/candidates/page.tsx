'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { SavedViews } from '@/components/SavedViews';
import { AssignMentorInline } from '@/components/admin/AssignMentorInline';
import { EmptyState } from '@/components/EmptyState';
import Link from "next/link";
import { useT, useLocale } from "@/i18n/client";
import { pipelineLabel } from '@/lib/pipeline';
import { Card } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Users, ExternalLink, Search, Filter, Download } from 'lucide-react';

interface Candidate {
  id: string;
  fullName: string;
  email: string;
  university?: string;
  department?: string;
  graduationYear?: number;
  skills: string[];
  cvUrl?: string;
  phone?: string;
  whatsapp?: string;
  city?: string;
  createdAt: string;
  isActive: boolean;
  menteeRelations: {
    pipelineStatus?: string;
    mentor: { id: string; fullName: string };
    company: { id: string; name: string } | null;
  }[];
}

const MIN_GRAD_YEAR = 2010;
const MAX_GRAD_YEAR = new Date().getFullYear() + 5;
const gradYears = Array.from({ length: MAX_GRAD_YEAR - MIN_GRAD_YEAR + 1 }, (_, i) => ({
  value: String(MIN_GRAD_YEAR + i),
  label: String(MIN_GRAD_YEAR + i),
}));

export default function CandidatesPage() {
  const t = useT();
  const locale = useLocale();
  const { data: session } = useSession();
  const [mentors, setMentors] = useState<{ id: string; fullName: string }[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 24;
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const COLS = ['Name', 'Email', 'Phone', 'WhatsApp', 'City', 'University', 'Department', 'Graduation', 'Skills', 'Stage', 'Project', 'Mentor'];
  const toRow = (c: Candidate) => {
    const rel = c.menteeRelations[0];
    return [
      c.fullName, c.email, c.phone, c.whatsapp, c.city, c.university, c.department,
      c.graduationYear, c.skills.join('; '),
      rel?.pipelineStatus ? pipelineLabel(rel.pipelineStatus, locale) : '',
      rel?.company?.name ?? '', rel?.mentor?.fullName ?? '',
    ];
  };

  // Exports cover ALL matching candidates (every page), not just the page in
  // view — fetch the full filtered set with all=1 before building the file.
  const fetchAllForExport = async (): Promise<Candidate[]> => {
    const params = buildFilterParams();
    params.set('all', '1');
    const res = await fetch(`/api/candidates?${params}`);
    const data = await res.json();
    return (data.candidates || []) as Candidate[];
  };

  const exportCsv = async () => {
    const rows0 = await fetchAllForExport();
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = rows0.map((c) => toRow(c).map(esc).join(','));
    const csv = [COLS.join(','), ...rows].join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `candidates-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = async () => {
    const rows0 = await fetchAllForExport();
    const { exportXlsx } = await import('@/lib/excel');
    await exportXlsx(`candidates-${new Date().toISOString().slice(0, 10)}`, COLS, rows0.map(toRow), 'Candidates');
  };

  // Read an optional ?status= filter from the URL (e.g. from dashboard pipeline bars)
  useEffect(() => {
    setStatusFilter(new URLSearchParams(window.location.search).get('status') || '');
  }, []);

  // Build the shared filter query string (without pagination params).
  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (skillFilter) params.set('skills', skillFilter);
    if (yearFilter) params.set('graduationYear', yearFilter);
    if (search) params.set('search', search);
    if (statusFilter) params.set('status', statusFilter);
    if (cityFilter) params.set('city', cityFilter);
    if (projectFilter) params.set('project', projectFilter);
    if (sourceFilter) params.set('source', sourceFilter);
    return params;
  }, [skillFilter, yearFilter, search, statusFilter, cityFilter, projectFilter, sourceFilter]);

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildFilterParams();
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/candidates?${params}`);
      const data = await res.json();
      setCandidates(data.candidates || []);
      setTotal(typeof data.total === 'number' ? data.total : (data.candidates?.length ?? 0));
    } catch {
      setError('Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }, [buildFilterParams, page]);

  useEffect(() => {
    fetch('/api/admin/sources')
      .then((r) => (r.ok ? r.json() : { sources: [] }))
      .then((d) => setSources(d.sources ?? []))
      .catch(() => {});
    // Mentors available to assign a candidate to (admins can mentor too).
    fetch('/api/users')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) =>
        setMentors(
          ((d.users ?? []) as { id: string; fullName: string; role: string }[])
            .filter((u) => u.role === 'MENTOR' || u.role === 'ADMIN')
            .map((u) => ({ id: u.id, fullName: u.fullName }))
        )
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timeout = setTimeout(fetchCandidates, 300);
    return () => clearTimeout(timeout);
  }, [fetchCandidates]);

  // Any filter change returns to the first page.
  useEffect(() => {
    setPage(1);
  }, [search, skillFilter, yearFilter, statusFilter, cityFilter, projectFilter, sourceFilter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = candidates.length > 0 && candidates.every((c) => selected.has(c.id));
  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allVisibleSelected) return new Set();
      const next = new Set(prev);
      candidates.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const runBulkAction = async (action: 'activate' | 'deactivate') => {
    setBulkBusy(true);
    try {
      const res = await fetch('/api/admin/candidates/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateIds: Array.from(selected), action }),
      });
      if (res.ok) {
        setSelected(new Set());
        await fetchCandidates();
      }
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.candidates.title}</h1>
        <p className="text-gray-500 mt-1">{t.candidates.subtitle}</p>
        {statusFilter && (
          <div className="mt-3 inline-flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-full px-3 py-1 text-sm text-blue-700">
            {pipelineLabel(statusFilter, locale)}
            <button
              type="button"
              onClick={() => {
                setStatusFilter('');
                window.history.replaceState(null, '', '/admin/candidates');
              }}
              className="text-blue-500 hover:text-blue-800"
              aria-label="clear filter"
            >
              ✕
            </button>
          </div>
        )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={candidates.length === 0}>
            <Download className="h-4 w-4" />
            {t.candidates.exportCsv}
          </Button>
          <Button variant="outline" onClick={exportExcel} disabled={candidates.length === 0}>
            <Download className="h-4 w-4" />
            {t.candidates.exportExcel}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-700">{t.candidates.filters}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder={t.candidates.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
            />
          </div>
          <Input
            placeholder={t.candidates.skillsPlaceholder}
            value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)}
          />
          <Select
            options={[{ value: '', label: t.candidates.allYears }, ...gradYears]}
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            placeholder={t.candidates.allGradYears}
          />
          <Input
            placeholder={t.candidates.cityPlaceholder}
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
          />
          <Input
            placeholder={t.candidates.projectPlaceholder}
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          />
          <Select
            options={[{ value: '', label: t.candidates.allSources }, ...sources.map((s) => ({ value: s.id, label: s.name }))]}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          />
        </div>
        {(search || skillFilter || yearFilter || cityFilter || projectFilter || sourceFilter) && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => {
              setSearch('');
              setSkillFilter('');
              setYearFilter('');
              setCityFilter('');
              setProjectFilter('');
              setSourceFilter('');
            }}
          >
            {t.candidates.clearFilters}
          </Button>
        )}
        <div className="mt-3 border-t border-gray-100 pt-3">
          <SavedViews
            storageKey="candidate-views"
            current={{ search, skillFilter, yearFilter, statusFilter, cityFilter, projectFilter }}
            onApply={(f) => {
              setSearch(f.search || '');
              setSkillFilter(f.skillFilter || '');
              setYearFilter(f.yearFilter || '');
              setStatusFilter(f.statusFilter || '');
              setCityFilter(f.cityFilter || '');
              setProjectFilter(f.projectFilter || '');
            }}
          />
        </div>
      </div>

      {/* Results count + bulk selection */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          {!loading && candidates.length > 0 && (
            <label className="flex items-center gap-1.5 text-sm text-gray-600">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
              {t.candidates.selectAll}
            </label>
          )}
          <p className="text-sm text-gray-500">
            {loading ? t.common.loading : `${total} ${t.candidates.found}`}
          </p>
        </div>
        {selected.size > 0 && (
          <div className="flex items-center gap-2 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-1.5">
            <span className="text-sm text-blue-800 dark:text-blue-200">{selected.size} {t.candidates.selected}</span>
            <Button size="sm" variant="outline" loading={bulkBusy} onClick={() => runBulkAction('deactivate')}>
              {t.candidates.bulkDeactivate}
            </Button>
            <Button size="sm" variant="outline" loading={bulkBusy} onClick={() => runBulkAction('activate')}>
              {t.candidates.bulkActivate}
            </Button>
            <button onClick={() => setSelected(new Set())} className="text-xs text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">
              {t.candidates.clearSelection}
            </button>
          </div>
        )}
      </div>

      {/* Candidates Grid */}
      {loading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : candidates.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={t.candidates.none}
            description={t.emptyState.candidates}
            actionLabel={t.emptyState.inviteCta}
            actionHref="/admin/invite"
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {candidates.map((candidate) => {
            const activeRelation = candidate.menteeRelations[0];

            return (
              <Card key={candidate.id} data-testid={`candidate-card-${candidate.id}`} className={!candidate.isActive ? 'opacity-60' : undefined}>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-start gap-2 min-w-0">
                    <input
                      type="checkbox"
                      className="mt-1 flex-shrink-0"
                      checked={selected.has(candidate.id)}
                      onChange={() => toggleSelect(candidate.id)}
                      aria-label={t.candidates.selectOne}
                    />
                    <div className="min-w-0">
                      <Link
                        href={`/admin/candidates/${candidate.id}`}
                        className="font-semibold text-gray-900 hover:text-blue-700 hover:underline"
                      >
                        {candidate.fullName}
                      </Link>
                      <p className="text-sm text-gray-500">{candidate.email}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    {!candidate.isActive && <Badge variant="danger">{t.candidates.inactive}</Badge>}
                    {activeRelation ? (
                      <Badge variant="success">{t.candidates.assigned}</Badge>
                    ) : (
                      <Badge variant="warning">{t.candidates.unassigned}</Badge>
                    )}
                  </div>
                </div>

                <div className="space-y-2 mb-4">
                  {candidate.university && (
                    <p className="text-xs text-gray-600">
                      🎓 {candidate.university}
                      {candidate.department && ` · ${candidate.department}`}
                    </p>
                  )}
                  {candidate.graduationYear && (
                    <p className="text-xs text-gray-600">📅 {t.candidates.classOf} {candidate.graduationYear}</p>
                  )}
                  {candidate.phone && (
                    <p className="text-xs text-gray-600">📞 {candidate.phone}</p>
                  )}
                  {activeRelation && (
                    <p className="text-xs text-blue-600">
                      👤 {t.candidates.mentor}: {activeRelation.mentor.fullName}
                      {activeRelation.company && ` · ${activeRelation.company.name}`}
                    </p>
                  )}
                </div>

                {candidate.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-4">
                    {candidate.skills.map((skill) => (
                      <Badge key={skill} variant="info" className="text-xs">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                )}

                {candidate.cvUrl && (
                  <a
                    href={candidate.cvUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-blue-600 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {t.candidates.viewCv}
                  </a>
                )}

                {!activeRelation && candidate.isActive && (
                  <AssignMentorInline
                    menteeId={candidate.id}
                    mentors={mentors}
                    meId={session?.user?.id}
                    onAssigned={fetchCandidates}
                  />
                )}
              </Card>
            );
          })}
        </div>
      )}

      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-8">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            {t.common.prev}
          </Button>
          <span className="text-sm text-gray-500">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            {t.common.next}
          </Button>
        </div>
      )}
    </div>
  );
}
