'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

type Item = {
  id: string;
  status: string;
  note: string | null;
  proposedSlots: unknown;
  createdAt: string;
  company: { name: string };
  requisition: { id: string; title: string };
  mentee: { fullName: string; menteeRelations: { id: string }[] };
};

function proposedSlots(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((slot): slot is string => typeof slot === 'string') : [];
}

export function InterviewRequestsQueue({ mentor = false }: { mentor?: boolean }) {
  const t = useT();
  const text = t.interviewRequests;
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const res = await fetch('/api/interview-requests');
    const data = await res.json();
    if (res.ok) setItems(data.requests ?? []);
    else setError(data.error ?? text.errors.loadFailed);
  }, [text.errors.loadFailed]);

  useEffect(() => { void load(); }, [load]);
  const decide = async (id: string, action: 'approve' | 'decline') => {
    const res = await fetch(`/api/interview-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) setError((await res.json()).error ?? text.errors.saveFailed);
    await load();
  };

  return (
    <div data-testid={mentor ? 'mentor-interview-requests' : 'admin-interview-requests'}>
      <h1 className="mb-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{text.title}</h1>
      <p className="mb-6 text-gray-500 dark:text-gray-400">{text.subtitle}</p>
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {items.length === 0 ? (
        <Card className="py-10 text-center text-gray-500 dark:text-gray-400">{text.empty}</Card>
      ) : (
        <div className="space-y-4">
          {items.map((item) => {
            const slots = proposedSlots(item.proposedSlots);
            const relationId = item.mentee.menteeRelations[0]?.id;
            const meetingHref = relationId
              ? `${mentor ? '/mentor/meetings' : '/admin/meetings'}?${new URLSearchParams({
                  relationId,
                  interviewRequestId: item.id,
                  requisitionId: item.requisition.id,
                  requisitionTitle: item.requisition.title,
                })}`
              : null;
            return (
              <Card key={item.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words font-semibold text-gray-900 dark:text-gray-100">{item.requisition.title}</h2>
                    <p className="break-words text-sm text-gray-600 dark:text-gray-300">{item.company.name} · {item.mentee.fullName}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{new Date(item.createdAt).toLocaleDateString()}</p>
                    {item.note && <p className="mt-2 break-words text-sm text-gray-700 dark:text-gray-300">{item.note}</p>}
                    {slots.length > 0 && (
                      <div className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                        <p className="font-medium">{text.proposedSlots}</p>
                        <ul className="list-inside list-disc">
                          {slots.map((slot) => <li key={slot}>{new Date(slot).toLocaleString()}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                  <Badge>{text.statuses[item.status as keyof typeof text.statuses] ?? item.status}</Badge>
                </div>
                {item.status === 'PENDING' && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => void decide(item.id, 'approve')}>{text.approve}</Button>
                    <Button size="sm" variant="outline" onClick={() => void decide(item.id, 'decline')}>{text.decline}</Button>
                  </div>
                )}
                {item.status === 'APPROVED' && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <p className="text-sm text-amber-700 dark:text-amber-300">{text.pipelineRecommendation}</p>
                    {meetingHref && (
                      <Link href={meetingHref} className="text-sm font-medium text-blue-600 dark:text-blue-400">
                        {text.scheduleInterview}
                      </Link>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
