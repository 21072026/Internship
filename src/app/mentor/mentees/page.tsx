'use client';
import { useT } from "@/i18n/client";

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Users, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { ApplyLinkBox } from '@/components/ApplyLinkBox';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { StartMeetingButton } from '@/components/meeting/StartMeetingButton';
import { PersonHoverCard } from '@/components/PersonHoverCard';

interface MentorshipRelation {
  id: string;
  status: string;
  startDate: string;
  // Stamped by the daily sweep (#1508) when the mentee is still parked at first
  // contact, was messaged and never answered. Null for everybody else.
  dormantSince: string | null;
  dormantNudgeCount: number;
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
  // Dormant mentees are hidden by default — that is the point of flagging them.
  // The toggle is always one click away, and it counts them, so "where did they
  // go?" is answered on the screen rather than in a support message.
  const [showDormant, setShowDormant] = useState(false);

  const fetchRelations = useCallback(async () => {
    const res = await fetch('/api/mentorship');
    const data = await res.json();
    setRelations(data.relations || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRelations();
  }, [fetchRelations]);

  const dormantCount = relations.filter((rel) => rel.dormantSince).length;
  const visibleRelations = showDormant ? relations : relations.filter((rel) => !rel.dormantSince);

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

      {dormantCount > 0 && (
        <div className="mb-4">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowDormant((v) => !v)}
            data-testid="toggle-dormant-mentees"
          >
            {showDormant ? t.mentor.dormantHide : t.mentor.dormantShow.replace('{n}', String(dormantCount))}
          </Button>
        </div>
      )}

      {loading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : visibleRelations.length === 0 ? (
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
          {visibleRelations.map((rel) => (
            <Card key={rel.id}>
              <div className="flex items-start justify-between gap-2 mb-4">
                {/* `min-w-0` + `truncate`: a long address ran out of the card,
                    because the text block would not shrink next to the status
                    badge (#1305). The name is a hover-card trigger (#1302); the
                    truncation stays on the heading so the link inherits it. */}
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-900 text-lg truncate">
                    <PersonHoverCard personId={rel.mentee.id} name={rel.mentee.fullName} role="MENTEE" />
                  </h3>
                  <p className="text-sm text-gray-500 truncate">{rel.mentee.email}</p>
                </div>
                <div className="flex flex-shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={rel.status} />
                  {rel.dormantSince && (
                    <Badge variant="default" title={t.mentor.dormantTitle} data-testid={`dormant-badge-${rel.id}`}>
                      {t.mentor.dormantBadge}
                    </Badge>
                  )}
                </div>
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

              {/* Wraps on a phone: interaction count + three actions did not fit a
                  360px card, so "Detayları gör" was clipped at the card edge (#1305). */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="default">{rel._count.interactions} {t.mentor.interactions}</Badge>
                {rel.dormantSince && rel.dormantNudgeCount > 0 && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t.mentor.dormantNudges.replace('{n}', String(rel.dormantNudgeCount))}
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <StartMeetingButton
                    target={{ relationIds: [rel.id] }}
                    defaultTitle={t.meetings.instant.defaultWith.replace('{name}', rel.mentee.fullName)}
                    testId={`start-meeting-${rel.id}`}
                  />
                  {/* Icon-only: the row already carries two buttons, and writing to
                      a mentee should not cost a detour through the detail page. */}
                  <Link href={`/messages/${rel.id}`} data-testid={`message-mentee-${rel.id}`}>
                    <Button size="sm" variant="outline" aria-label={t.messages.sendMessage} title={t.messages.sendMessage}>
                      <MessageSquare className="h-4 w-4" />
                    </Button>
                  </Link>
                  <Link href={`/mentor/mentees/${rel.id}`}>
                    <Button size="sm" variant="outline">{t.mentor.viewDetails}</Button>
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
