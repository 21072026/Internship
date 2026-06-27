'use client';
import { useT } from "@/i18n/client";
import Link from "next/link";

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { BookOpen, Plus } from 'lucide-react';

interface User {
  id: string;
  fullName: string;
  email: string;
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

export default function MentorshipPage() {
  const t = useT();
  const [relations, setRelations] = useState<MentorshipRelation[]>([]);
  const [mentors, setMentors] = useState<User[]>([]);
  const [mentees, setMentees] = useState<User[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ mentorId: '', menteeId: '', companyId: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [relRes, usersRes, companiesRes] = await Promise.all([
        fetch('/api/mentorship'),
        fetch('/api/users'),
        fetch('/api/companies'),
      ]);
      const [relData, usersData, companiesData] = await Promise.all([
        relRes.json(),
        usersRes.json(),
        companiesRes.json(),
      ]);
      setRelations(relData.relations || []);
      setMentors((usersData.users || []).filter((u: User & { role: string }) => u.role === 'MENTOR'));
      setMentees((usersData.users || []).filter((u: User & { role: string }) => u.role === 'MENTEE'));
      setCompanies(companiesData.companies || []);
    } catch {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const handleCreate = async () => {
    if (!formData.mentorId || !formData.menteeId) {
      setFormError('Mentor and Mentee are required');
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
      await fetchAll();
      setShowForm(false);
      setFormData({ mentorId: '', menteeId: '', companyId: '' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  };

  const handleComplete = async (id: string) => {
    await fetch(`/api/mentorship/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED' }),
    });
    await fetchAll();
  };

  const mentorOptions = mentors.map((m) => ({ value: m.id, label: m.fullName }));
  const menteeOptions = mentees.map((m) => ({ value: m.id, label: m.fullName }));
  const companyOptions = [
    { value: '', label: 'No company' },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.mentorships.title}</h1>
          <p className="text-gray-500 mt-1">{t.mentorships.subtitle}</p>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" />
          Assign Mentorship
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {/* Create Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-gray-900 mb-6">Assign Mentorship</h2>
            {formError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{formError}</div>
            )}
            <div className="space-y-4">
              <Select
                label="Mentor"
                required
                options={mentorOptions}
                placeholder="Select mentor"
                value={formData.mentorId}
                onChange={(e) => setFormData((p) => ({ ...p, mentorId: e.target.value }))}
              />
              <Select
                label="Mentee"
                required
                options={menteeOptions}
                placeholder="Select mentee"
                value={formData.menteeId}
                onChange={(e) => setFormData((p) => ({ ...p, menteeId: e.target.value }))}
              />
              <Select
                label="Company (optional)"
                options={companyOptions}
                value={formData.companyId}
                onChange={(e) => setFormData((p) => ({ ...p, companyId: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button onClick={handleCreate} loading={submitting}>Assign</Button>
            </div>
          </div>
        </div>
      )}

      {/* Relations */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : relations.length === 0 ? (
        <Card className="text-center py-12">
          <BookOpen className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No mentorships yet</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {relations.map((rel) => (
            <Card key={rel.id}>
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <Link href={`/admin/candidates/${rel.mentee.id}`} className="font-semibold text-gray-900 hover:text-blue-700 hover:underline">{rel.mentee.fullName}</Link>
                    <span className="text-gray-400">→</span>
                    <span className="font-semibold text-gray-900">{rel.mentor.fullName}</span>
                    <StatusBadge status={rel.status} />
                  </div>
                  <div className="flex items-center gap-4 text-sm text-gray-500">
                    {rel.company && (
                      <span>🏢 {rel.company.name}</span>
                    )}
                    <span>📅 Started {new Date(rel.startDate).toLocaleDateString()}</span>
                    <Badge variant="default">{rel._count.interactions} interactions</Badge>
                  </div>
                </div>
                {rel.status === 'ACTIVE' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleComplete(rel.id)}
                  >
                    Mark Complete
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
