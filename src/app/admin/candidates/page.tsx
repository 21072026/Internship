'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Users, ExternalLink, Search, Filter } from 'lucide-react';

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
  createdAt: string;
  menteeRelations: {
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
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [error, setError] = useState('');

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (skillFilter) params.set('skills', skillFilter);
      if (yearFilter) params.set('graduationYear', yearFilter);
      if (search) params.set('search', search);

      const res = await fetch(`/api/candidates?${params}`);
      const data = await res.json();
      setCandidates(data.candidates || []);
    } catch {
      setError('Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }, [skillFilter, yearFilter, search]);

  useEffect(() => {
    const timeout = setTimeout(fetchCandidates, 300);
    return () => clearTimeout(timeout);
  }, [fetchCandidates]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Candidates</h1>
        <p className="text-gray-500 mt-1">Browse and filter registered mentees</p>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
        </div>
        {(search || skillFilter || yearFilter) && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => {
              setSearch('');
              setSkillFilter('');
              setYearFilter('');
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
          <p className="text-gray-500">No candidates found matching your filters</p>
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
                    <Badge variant="success" className="flex-shrink-0">Assigned</Badge>
                  ) : (
                    <Badge variant="warning" className="flex-shrink-0">Unassigned</Badge>
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
                    <p className="text-xs text-gray-600">📅 Class of {candidate.graduationYear}</p>
                  )}
                  {candidate.phone && (
                    <p className="text-xs text-gray-600">📞 {candidate.phone}</p>
                  )}
                  {activeRelation && (
                    <p className="text-xs text-blue-600">
                      👤 Mentor: {activeRelation.mentor.fullName}
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
                    View CV
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
