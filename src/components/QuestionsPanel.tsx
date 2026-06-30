'use client';

import { useCallback, useEffect, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';

interface Q {
  id: string;
  question: string;
  answer: string | null;
}

// mode='ask' → mentee asks questions + reads answers.
// mode='answer' → mentor answers open questions.
export function QuestionsPanel({ relationId, mode }: { relationId: string; mode: 'ask' | 'answer' }) {
  const t = useT();
  const [items, setItems] = useState<Q[]>([]);
  const [question, setQuestion] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/questions?relationId=${relationId}`);
    if (res.ok) setItems((await res.json()).questions ?? []);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/questions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relationId, question }),
      });
      if (res.ok) { setQuestion(''); await load(); }
    } finally {
      setBusy(false);
    }
  };

  const answer = async (id: string) => {
    const a = (drafts[id] ?? '').trim();
    if (!a) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/questions/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: a }),
      });
      if (res.ok) { setDrafts((p) => ({ ...p, [id]: '' })); await load(); }
    } finally {
      setBusy(false);
    }
  };

  const shown = mode === 'answer' ? items.filter((q) => !q.answer) : items;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><HelpCircle className="h-4 w-4 text-gray-400" />{t.portal.qa.title}</CardTitle>
      </CardHeader>

      {mode === 'ask' && (
        <form onSubmit={ask} className="space-y-2 mb-4">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder={t.portal.qa.placeholder}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
          <Button type="submit" size="sm" loading={busy} disabled={!question.trim()}>{t.portal.qa.ask}</Button>
        </form>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-gray-400">{mode === 'answer' ? t.portal.qa.noneAnswer : t.portal.qa.none}</p>
      ) : (
        <div className="space-y-3">
          {shown.map((q) => (
            <div key={q.id} data-testid={`q-${q.id}`} className="rounded-lg border border-gray-100 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-gray-900 flex-1">{q.question}</p>
                <Badge variant={q.answer ? 'success' : 'warning'}>{q.answer ? t.portal.qa.answered : t.portal.qa.open}</Badge>
              </div>
              {q.answer && <p className="text-sm text-gray-600 mt-2 pl-3 border-l-2 border-green-200 whitespace-pre-wrap">{q.answer}</p>}
              {mode === 'answer' && !q.answer && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <textarea
                    value={drafts[q.id] ?? ''}
                    onChange={(e) => setDrafts((p) => ({ ...p, [q.id]: e.target.value }))}
                    rows={2}
                    placeholder={t.portal.qa.answerPlaceholder}
                    className="flex-1 min-w-[200px] rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <Button size="sm" loading={busy} disabled={!(drafts[q.id] ?? '').trim()} onClick={() => answer(q.id)}>{t.portal.qa.answer}</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
