'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from "next/link";
import { useT, useLocale } from "@/i18n/client";
import { pipelineLabel } from '@/lib/pipeline';
import { Card } from '@/components/ui/Card';
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
  menteeRelations: {
    pipelineStatus?: string;
    mentor: { id: string; fullName: string };
    company: { id: string; name: string } | null;
  }[];
}

const graduationYearOptions = [
  { value: '', label: 'All Years' },
  ...Array.from({ length: 16 }, (_, i) => ({
    value: String(2020 + i),
    label: String(2020 + i),
  })),
];

export default function CandidatesPage() {
  const t = useT();
  const locale = useLocale();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [error, setError] = useState('');

  const exportCsv = () => {
    const cols = ['Name', 'Email', 'Phone', 'WhatsApp', 'City', 'University', 'Department', 'Graduation', 'Skills', 'Stage', 'Project', 'Mentor'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = candidates.map((c) => {
      const rel = c.menteeRelations[0];
      return [
        c.fullName, c.email, c.phone, c.whatsapp, c.city, c.university, c.department,
        c.graduationYear, c.skills.join('; '),
        rel?.pipelineStatus ? pipelineLabel(rel.pipelineStatus, locale) : '',
        rel?.company?.name ?? '', rel?.mentor?.fullName ?? '',
      ].map(esc).join(',');
    });
    const csv = [cols.join(','), ...rows].join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `candidates-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Read an optional ?status= filter from the URL (e.g. from dashboard pipeline bars)
  useEffect(() => {
    setStatusFilter(new URLSearchParams(window.location.search).get('status') || '');
  }, []);

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (skillFilter) params.set('skills', skillFilter);
      if (yearFilter) params.set('graduationYear', yearFilter);
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (cityFilter) params.set('city', cityFilter);

      const res = await fetch(`/api/candidates?${params}`);
      const data = await res.json();
      setCandidates(data.candidates || []);
    } catch {
      setError('Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }, [skillFilter, yearFilter, search, statusFilter, cityFilter]);

  useEffect(() => {
    const timeout = setTimeout(fetchCandidates, 300);
    return () => clearTimeout(timeout);
  }, [fetchCandidates]);

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.candidates.title}</h1>
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
        <Button variant="outline" onClick={exportCsv} disabled={candidates.length === 0}>
          <Download className="h-4 w-4" />
          {t.candidates.exportCsv}
        </Button>
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
          <span className="text-sm font-medium text-gray-700">Filters</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name, email, university..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
            />
          </div>
          <Input
            placeholder="Filter by skills (comma-separated)"
            value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)}
          />
          <Select
            options={graduationYearOptions}
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            placeholder="All graduation years"
          />
          <Input
            placeholder={t.candidates.cityPlaceholder}
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
          />
        </div>
        {(search || skillFilter || yearFilter || cityFilter) && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => {
              setSearch('');
              setSkillFilter('');
              setYearFilter('');
              setCityFilter('');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Results count */}
      <p className="text-sm text-gray-500 mb-4">
        {loading ? 'Loading...' : `${candidates.length} candidate${candidates.length !== 1 ? 's' : ''} found`}
      </p>

      {/* Candidates Grid */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : candidates.length === 0 ? (
        <Card className="text-center py-12">
          <Users className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t.candidates.none}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {candidates.map((candidate) => {
            const activeRelation = candidate.menteeRelations[0];

            return (
              <Card key={candidate.id}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <Link
                      href={`/admin/candidates/${candidate.id}`}
                      className="font-semibold text-gray-900 hover:text-blue-700 hover:underline"
                    >
                      {candidate.fullName}
                    </Link>
                    <p className="text-sm text-gray-500">{candidate.email}</p>
                  </div>
                  {activeRelation ? (
                    <Badge variant="success" className="flex-shrink-0">{t.candidates.assigned}</Badge>
                  ) : (
                    <Badge variant="warning" className="flex-shrink-0">{t.candidates.unassigned}</Badge>
                  )}
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
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
