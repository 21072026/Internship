'use client';

import { useCallback, useEffect, useState } from 'react';
import { Quote, Check, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// The author's approval screen (#1098): the exact excerpt an admin wants to
// publish, approve or decline. Reached from the in-app notification; works
// for any signed-in role since any participant can author an evaluation.
export default function TestimonialApprovePage() {
  const t = useT();
  const [pending, setPending] = useState<{ id: string; publicExcerpt: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/testimonials/approve')
      .then((r) => (r.ok ? r.json() : { pending: [] }))
      .then((d) => setPending(d.pending ?? []))
      .catch(() => setPending([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      const res = await fetch('/api/testimonials/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evaluationId: id, approve }),
      });
      if (res.ok) setPending((prev) => (prev ?? []).filter((p) => p.id !== id));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.testimonials.approveTitle}</h1>
        <p className="text-gray-500 mt-1">{t.testimonials.approveSubtitle}</p>
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Quote className="h-5 w-5 text-blue-600" />
            <CardTitle>{t.testimonials.approvePending}</CardTitle>
          </div>
        </CardHeader>
        {pending === null ? (
          <p className="py-4 text-sm text-gray-400">{t.common.loading}</p>
        ) : pending.length === 0 ? (
          <p className="py-4 text-sm text-gray-500" data-testid="testimonial-approve-empty">{t.testimonials.approveEmpty}</p>
        ) : (
          <ul className="space-y-4">
            {pending.map((p) => (
              <li key={p.id} className="rounded-xl border border-gray-100 dark:border-gray-800 p-4" data-testid={`testimonial-approve-${p.id}`}>
                <blockquote className="text-sm text-gray-800 dark:text-gray-200 italic leading-relaxed">
                  “{p.publicExcerpt}”
                </blockquote>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" loading={busy === p.id} onClick={() => decide(p.id, true)} data-testid={`testimonial-approve-yes-${p.id}`}>
                    <Check className="h-4 w-4" />
                    {t.testimonials.approveYes}
                  </Button>
                  <Button size="sm" variant="outline" loading={busy === p.id} onClick={() => decide(p.id, false)} data-testid={`testimonial-approve-no-${p.id}`}>
                    <X className="h-4 w-4" />
                    {t.testimonials.approveNo}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
