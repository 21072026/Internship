'use client';
import { useT } from "@/i18n/client";

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Users } from 'lucide-react';
import Link from 'next/link';
import { ApplyLinkBox } from '@/components/ApplyLinkBox';
import { EmptyState } from '@/components/EmptyState';

interface MentorshipRelation {
  id: string;
  status: string;
  startDate: string;
  mentee: {
    id: string;
    fullName: string;
    email: string;
    university?: string;
    department?: string;
    graduationYear?: number;
    skills: string[];
    phone?: string;
    cvUrl?: string;
  };
  company: { id: string; name: string; industry?: string } | null;
  _count: { interactions: number };
}

export default function MenteesPage() {
  const t = useT();
  const [relations, setRelations] = useState<MentorshipRelation[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRelations = useCallback(async () => {
    const res = await fetch('/api/mentorship');
    const data = await res.json();
    setRelations(data.relations || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRelations();
  }, [fetchRelations]);

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentor.myMentees}</h1>
          <p className="text-gray-500 mt-1">{t.mentor.menteesSubtitle}</p>
        </div>
        <Link href="/mentor/mentees/new">
          <Button>
            <Users className="h-4 w-4" />
            {t.mentor.addMentee}
          </Button>
        </Link>
      </div>

      <ApplyLinkBox />

      {loading ? (
        <div className="text-center py-12 text-gray-400">{t.common.loading}</div>
      ) : relations.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={t.mentor.noMenteesAssigned}
            description={t.mentor.noMenteesHint}
            actionLabel={t.mentor.addMentee}
            actionHref="/mentor/mentees/new"
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {relations.map((rel) => (
            <Card key={rel.id}>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-gray-900 text-lg">{rel.mentee.fullName}</h3>
                  <p className="text-sm text-gray-500">{rel.mentee.email}</p>
                </div>
                <StatusBadge status={rel.status} />
              </div>

              <div className="space-y-2 mb-4">
                {rel.mentee.university && (
                  <p className="text-sm text-gray-600">🎓 {rel.mentee.university} · {rel.mentee.department}</p>
                )}
                {rel.mentee.graduationYear && (
                  <p className="text-sm text-gray-600">📅 {t.candidates.classOf} {rel.mentee.graduationYear}</p>
                )}
                {rel.mentee.phone && (
                  <p className="text-sm text-gray-600">📞 {rel.mentee.phone}</p>
                )}
                {rel.company && (
                  <p className="text-sm text-blue-600">🏢 {rel.company.name}</p>
                )}
              </div>

              {rel.mentee.skills.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-4">
                  {rel.mentee.skills.map((skill) => (
                    <Badge key={skill} variant="info" className="text-xs">{skill}</Badge>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between">
                <Badge variant="default">{rel._count.interactions} {t.mentor.interactions}</Badge>
                <Link href={`/mentor/mentees/${rel.id}`}>
                  <Button size="sm" variant="outline">{t.mentor.viewDetails}</Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
