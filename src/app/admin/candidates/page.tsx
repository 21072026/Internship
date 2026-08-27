'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { SavedViews } from '@/components/SavedViews';
import { AssignMentorInline } from '@/components/admin/AssignMentorInline';
import type { MentorAvailability } from '@/lib/mentorAvailability';
import { EmptyState } from '@/components/EmptyState';
import Link from "next/link";
import { useT } from "@/i18n/client";
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { cvViewHref } from '@/lib/cvLink';
import { Card } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Users, ExternalLink, Search, Filter, Download } from 'lucide-react';
import { LanguageBadge } from '@/components/LanguageBadge';
import { TagFilter, TagChips, type TagOption } from '@/components/TagFilter';
import { PersonHoverCard } from '@/components/PersonHoverCard';

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
  preferredLanguage?: string | null;
  tags?: { tag: TagOption }[];
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
  const stages = useResolvedStages();
  const label = useStageLabel();
  const { data: session } = useSession();
  const [mentors, setMentors] = useState<
    { id: string; fullName: string; mentorCapacity: number | null; activeMenteeCount: number; availability: MentorAvailability }[]
  >([]);
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
  // The org's tag vocabulary and the current selection (#887). `tagMode`
  // decides whether the selection means "any of these" or "all of these".
  const [tags, setTags] = useState<TagOption[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<'and' | 'or'>('or');
  const [bulkTagId, setBulkTagId] = useState('');
  const [bulkNote, setBulkNote] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Deactivated candidates are hidden by default and live in the archive view.
  const [archived, setArchived] = useState(false);

  const COLS = ['Name', 'Email', 'Phone', 'WhatsApp', 'City', 'University', 'Department', 'Graduation', 'Skills', 'Stage', 'Project', 'Mentor'];
  const toRow = (c: Candidate) => {
    const rel = c.menteeRelations[0];
    return [
      c.fullName, c.email, c.phone, c.whatsapp, c.city, c.university, c.department,
      c.graduationYear, c.skills.join('; '),
      rel?.pipelineStatus ? label(rel.pipelineStatus) : '',
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
    if (archived) params.set('archived', '1');
    if (tagFilter.length > 0) {
      params.set('tags', tagFilter.join(','));
      params.set('tagMode', tagMode);
    }
    return params;
  }, [skillFilter, yearFilter, search, statusFilter, cityFilter, projectFilter, sourceFilter, archived, tagFilter, tagMode]);

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
    fetch('/api/tags')
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d) => setTags(d.tags ?? []))
      .catch(() => {});
    fetch('/api/admin/sources')
      .then((r) => (r.ok ? r.json() : { sources: [] }))
      .then((d) => setSources(d.sources ?? []))
      .catch(() => {});
    // Mentors available to assign a candidate to (admins can mentor too), with
    // capacity/availability so AssignMentorInline can label each option (#942).
    // Full or paused mentors are kept in the list, never dropped or disabled —
    // getMentorAvailability() is only advisory here.
    fetch('/api/users?view=mentorAvailability')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) =>
        setMentors(
          (
            (d.users ?? []) as {
              id: string;
              fullName: string;
              role: string;
              mentorCapacity: number | null;
              activeMenteeCount: number;
              availability: MentorAvailability;
            }[]
          )
            .filter((u) => u.role === 'MENTOR' || u.role === 'ADMIN')
            .map((u) => ({
              id: u.id,
              fullName: u.fullName,
              mentorCapacity: u.mentorCapacity,
              activeMenteeCount: u.activeMenteeCount,
              availability: u.availability,
            }))
        )
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timeout = setTimeout(fetchCandidates, 300);
    return () => clearTimeout(timeout);
  }, [fetchCandidates]);

  // Any filter change (including switching to/from the archive) returns to page 1.
  useEffect(() => {
    setPage(1);
  }, [search, skillFilter, yearFilter, statusFilter, cityFilter, projectFilter, sourceFilter, archived, tagFilter, tagMode]);

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

  const runBulkAction = async (action: 'activate' | 'deactivate' | 'advanceStage' | 'addTag' | 'removeTag') => {
    setBulkBusy(true);
    setBulkNote('');
    try {
      const res = await fetch('/api/admin/candidates/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateIds: Array.from(selected),
          action,
          ...(action === 'addTag' || action === 'removeTag' ? { tagId: bulkTagId } : {}),
        }),
      });
      if (res.ok) {
        // People already carrying the maximum number of tags are skipped rather
        // than silently counted as tagged — say so, or the operator believes a
        // label landed on everyone they selected.
        const data = await res.json().catch(() => ({}));
        if (typeof data.skippedAtLimit === 'number' && data.skippedAtLimit > 0) {
          setBulkNote(t.tags.skippedAtLimit.replace('{n}', String(data.skippedAtLimit)));
        }
        setSelected(new Set());
        await fetchCandidates();
      }
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.candidates.title}</h1>
        <p className="text-gray-500 mt-1">{t.candidates.subtitle}</p>
        {statusFilter && (
          <div data-testid="candidates-status-filter-chip" className="mt-3 inline-flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-full px-3 py-1 text-sm text-blue-700">
            {label(statusFilter)}
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
        <div className="flex max-w-full flex-wrap gap-2">
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
        <button
          type="button"
          data-testid="candidates-mobile-filter-toggle"
          aria-expanded={filtersOpen}
          aria-controls="candidate-filters"
          onClick={() => setFiltersOpen((open) => !open)}
          className="flex min-h-11 w-full items-center justify-between gap-2 text-left md:hidden"
        >
          <span className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.candidates.filters}</span>
          </span>
          <span aria-hidden className="text-sm text-gray-500">{filtersOpen ? '−' : '+'}</span>
        </button>
        <div className="hidden items-center gap-2 mb-3 md:flex">
          <Filter className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.candidates.filters}</span>
        </div>
        <div id="candidate-filters" className={`${filtersOpen ? 'block mt-3' : 'hidden'} md:block md:mt-0`}>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder={t.candidates.searchPlaceholder}
              data-testid="candidates-search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-h-11 pl-10 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
            />
          </div>
          <Input
            data-testid="candidates-skill-filter"
            placeholder={t.candidates.skillsPlaceholder}
            value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)}
          />
          <Select
            data-testid="candidates-year-filter"
            aria-label={t.candidates.graduationYearFilterLabel}
            options={[{ value: '', label: t.candidates.allYears }, ...gradYears]}
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
          />
          <Input
            data-testid="candidates-city-filter"
            placeholder={t.candidates.cityPlaceholder}
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
          />
          <Input
            data-testid="candidates-project-filter"
            placeholder={t.candidates.projectPlaceholder}
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          />
          <Select
            data-testid="candidates-source-filter"
            aria-label={t.candidates.sourceFilterLabel}
            options={[{ value: '', label: t.candidates.allSources }, ...sources.map((s) => ({ value: s.id, label: s.name }))]}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          />
          <Select
            data-testid="candidates-stage-filter"
            aria-label={t.candidates.allStages}
            options={[{ value: '', label: t.candidates.allStages }, ...stages.map((s) => ({ value: s.key, label: s.label }))]}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        {(search || skillFilter || yearFilter || cityFilter || projectFilter || sourceFilter || statusFilter || tagFilter.length > 0) && (
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
              setStatusFilter('');
              setTagFilter([]);
            }}
          >
            {t.candidates.clearFilters}
          </Button>
        )}
        <TagFilter
          tags={tags}
          selected={tagFilter}
          mode={tagMode}
          onToggle={(id) =>
            setTagFilter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
          }
          onModeChange={setTagMode}
        />
        <div className="mt-3 border-t border-gray-100 pt-3">
          <SavedViews
            storageKey="candidate-views"
            current={{ search, skillFilter, yearFilter, statusFilter, cityFilter, projectFilter, tagFilter: tagFilter.join(','), tagMode }}
            onApply={(f) => {
              setSearch(f.search || '');
              setSkillFilter(f.skillFilter || '');
              setYearFilter(f.yearFilter || '');
              setStatusFilter(f.statusFilter || '');
              setCityFilter(f.cityFilter || '');
              setProjectFilter(f.projectFilter || '');
              // Saved before tags existed → no key, and the view applies with
              // no tag filter rather than throwing.
              setTagFilter(f.tagFilter ? f.tagFilter.split(',').filter(Boolean) : []);
              setTagMode(f.tagMode === 'and' ? 'and' : 'or');
            }}
          />
        </div>
        </div>
      </div>

      {/* Active vs. archive (deactivated) view */}
      <div className="mb-4 inline-flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden text-sm" role="tablist" aria-label={t.candidates.viewLabel}>
        {([false, true] as const).map((isArchive) => (
          <button
            key={String(isArchive)}
            type="button"
            role="tab"
            aria-selected={archived === isArchive}
            data-testid={isArchive ? 'candidates-tab-archived' : 'candidates-tab-active'}
            onClick={() => {
              if (archived === isArchive) return;
              setArchived(isArchive);
              setSelected(new Set());
            }}
            className={`min-h-11 px-4 py-1.5 ${
              archived === isArchive
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            {isArchive ? t.candidates.archivedTab : t.candidates.activeTab}
          </button>
        ))}
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
            <Button size="sm" variant="outline" loading={bulkBusy} onClick={() => runBulkAction('advanceStage')}>
              {t.candidates.bulkAdvanceStage}
            </Button>
            {/* Tagging in bulk is the whole point of a tag: you notice a shared
                property across a filtered list and mark all of them at once. */}
            {tags.length > 0 && (
              <>
                <select
                  data-testid="bulk-tag-select"
                  aria-label={t.tags.label}
                  value={bulkTagId}
                  onChange={(e) => setBulkTagId(e.target.value)}
                  className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-700 dark:text-gray-200"
                >
                  <option value="">{t.tags.label}</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>{tag.name}</option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="bulk-tag-add"
                  disabled={!bulkTagId}
                  loading={bulkBusy}
                  onClick={() => runBulkAction('addTag')}
                >
                  {t.tags.bulkAdd}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="bulk-tag-remove"
                  disabled={!bulkTagId}
                  loading={bulkBusy}
                  onClick={() => runBulkAction('removeTag')}
                >
                  {t.tags.bulkRemove}
                </Button>
              </>
            )}
            <button onClick={() => setSelected(new Set())} className="text-xs text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">
              {t.candidates.clearSelection}
            </button>
          </div>
        )}
      </div>

      {bulkNote && (
        <p data-testid="bulk-tag-note" className="-mt-2 mb-4 text-sm text-amber-700 dark:text-amber-300">{bulkNote}</p>
      )}

      {/* Candidates Grid */}
      {loading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : candidates.length === 0 ? (
        <Card>
          {archived ? (
            <EmptyState icon={Users} title={t.candidates.noneArchived} />
          ) : (
            <EmptyState
              icon={Users}
              title={t.candidates.none}
              description={t.emptyState.candidates}
              actionLabel={t.emptyState.inviteCta}
              actionHref="/admin/invite"
            />
          )}
        </Card>
      ) : (
        <>
        <div data-testid="candidates-mobile-list" className="space-y-4 md:hidden">
          {candidates.map((candidate) => {
            const activeRelation = candidate.menteeRelations[0];

            return (
              <Card key={candidate.id} padding="sm" data-testid={`candidate-mobile-card-${candidate.id}`} className={!candidate.isActive ? 'opacity-60' : undefined}>
                <div className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 flex-shrink-0"
                    checked={selected.has(candidate.id)}
                    onChange={() => toggleSelect(candidate.id)}
                    aria-label={t.candidates.selectOne}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Link
                        href={`/admin/candidates/${candidate.id}`}
                        className="block break-words font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-700 dark:hover:text-blue-300 hover:underline"
                      >
                        {candidate.fullName}
                      </Link>
                      <LanguageBadge language={candidate.preferredLanguage} />
                    </div>
                    <p className="mt-1 min-w-0 break-words text-sm text-gray-600 dark:text-gray-300">
                      {t.candidates.mentor}:{' '}
                      {activeRelation ? (
                        <PersonHoverCard personId={activeRelation.mentor.id} name={activeRelation.mentor.fullName} role="MENTOR" />
                      ) : (
                        t.candidates.unassigned
                      )}
                    </p>
                  </div>
                  <Badge data-testid="candidate-mobile-stage" variant={activeRelation?.pipelineStatus ? 'info' : 'warning'} className="max-w-[9rem] flex-shrink-0 text-center whitespace-normal break-words">
                    {activeRelation?.pipelineStatus ? label(activeRelation.pipelineStatus) : t.candidates.unassigned}
                  </Badge>
                </div>

                {(candidate.university || candidate.department || candidate.graduationYear || candidate.city || candidate.skills.length > 0) && (
                  <div className="mt-4 min-w-0 space-y-2 border-t border-gray-100 pt-3 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-300">
                    {(candidate.university || candidate.department) && (
                      <p className="break-words">
                        {[candidate.university, candidate.department].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {candidate.graduationYear && <p>{t.candidates.classOf} {candidate.graduationYear}</p>}
                    {candidate.city && <p className="break-words">{candidate.city}</p>}
                    {candidate.skills.length > 0 && (
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {candidate.skills.map((skill) => (
                          <Badge key={skill} variant="info" className="max-w-full whitespace-normal break-words text-xs">{skill}</Badge>
                        ))}
                      </div>
                    )}
                    <TagChips tags={(candidate.tags ?? []).map((ut) => ut.tag)} />
                  </div>
                )}

                {candidate.cvUrl && (
                  <a href={cvViewHref(candidate.cvUrl)} target="_blank" rel="noopener noreferrer" className="mt-3 flex items-center gap-1 text-sm text-blue-600 dark:text-blue-300 hover:underline">
                    <ExternalLink className="h-3 w-3" />
                    {t.candidates.viewCv}
                  </a>
                )}

                {!activeRelation && candidate.isActive && (
                  <AssignMentorInline menteeId={candidate.id} mentors={mentors} meId={session?.user?.id} onAssigned={fetchCandidates} />
                )}
              </Card>
            );
          })}
        </div>
        <div data-testid="candidates-desktop-list" className="hidden md:grid md:grid-cols-2 xl:grid-cols-3 gap-6">
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
                      <p className="flex items-center gap-1.5 text-sm text-gray-500">
                        <span className="truncate">{candidate.email}</span>
                        {/* Which language to write to them in (#1164). */}
                        <LanguageBadge language={candidate.preferredLanguage} />
                      </p>
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
                      👤 {t.candidates.mentor}:{' '}
                      <PersonHoverCard personId={activeRelation.mentor.id} name={activeRelation.mentor.fullName} role="MENTOR" />
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

                {/* Why this person is in a filtered list — the labels they carry. */}
                <div className="mb-4">
                  <TagChips tags={(candidate.tags ?? []).map((ut) => ut.tag)} testId={`candidate-tags-${candidate.id}`} />
                </div>

                {candidate.cvUrl && (
                  <a
                    href={cvViewHref(candidate.cvUrl)}
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
        </>
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
