'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { AiBadge } from '@/components/AiBadge';
import { AiText } from '@/components/ai/AiText';
import { CvReviewView } from '@/components/ai/CvReviewView';
import { readStoredFeedback } from '@/lib/cvReviewRules';
import { PracticeReportView } from '@/components/ai/PracticeReportView';
import { readReport } from '@/lib/practiceInterviewRules';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';

// What a person chose to share of their AI results (#2044) — on the mentor's
// view of a mentee. The server returns only what this viewer may read
// (canReadArtifact): the card renders nothing when nothing was shared.
interface Shared {
  id: string;
  taskId: string;
  content: string;
  createdAt: string;
}

export function SharedAiArtifacts({ subjectUserId }: { subjectUserId: string }) {
  const t = useT();
  const a = t.aiArtifact;
  const [items, setItems] = useState<Shared[]>([]);

  useEffect(() => {
    fetch(`/api/ai/artifacts?subjectUserId=${encodeURIComponent(subjectUserId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setItems(d?.artifacts ?? []))
      .catch(() => {});
  }, [subjectUserId]);

  if (items.length === 0) return null;
  return (
    <Card data-testid="shared-ai-artifacts">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-blue-600" />
          <CardTitle>{a.sharedTitle}</CardTitle>
        </div>
      </CardHeader>
      <div className="space-y-3">
        {items.map((x) => (
          <details key={x.id} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3" data-testid={`shared-ai-artifact-${x.id}`}>
            <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
              {(a.tasks as Record<string, string>)[x.taskId] ?? x.taskId}
              <RelativeTime date={x.createdAt} className="ml-2 text-xs font-normal text-gray-500" />
            </summary>
            <AiBadge note className="mt-2 mb-1" />
            {(() => {
              // A scored CV review (#2050) is JSON: shown as the review, not as its source.
              const stored = x.taskId === 'cv_feedback' ? readStoredFeedback(x.content) : null;
              if (stored?.kind === 'review') return <CvReviewView review={stored.review} />;
              // A shared practice-interview report (#2051) is JSON too.
              const practice = x.taskId === 'practice_interview' ? readReport(x.content) : null;
              return practice
                ? <PracticeReportView report={practice} />
                : <AiText text={x.content} className="text-sm text-gray-800 dark:text-gray-200" />;
            })()}
          </details>
        ))}
      </div>
    </Card>
  );
}
