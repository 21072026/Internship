'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { MessageSquare } from 'lucide-react';
import { useT } from '@/i18n/client';

interface Relation {
  id: string;
  mentor: { fullName: string };
}

// Mentee view: list of conversation threads (one per mentorship).
export default function PortalMessagesPage() {
  const t = useT();
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/mentorship')
      .then((r) => r.json())
      .then((d) => setRelations(d.relations ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.messages.title}</h1>
        <p className="text-gray-500 mt-1">{t.messages.listSubtitle}</p>
      </div>
      <Card>
        <CardHeader><CardTitle>{t.messages.threads}</CardTitle></CardHeader>
        {loading ? (
          <p className="text-center py-10 text-gray-400">{t.common.loading}</p>
        ) : relations.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{t.messages.noThreads}</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {relations.map((r) => (
              <Link key={r.id} href={`/messages/${r.id}`} className="flex items-center gap-3 py-3 hover:bg-gray-50 rounded-lg px-2">
                <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center">
                  <MessageSquare className="h-4 w-4 text-blue-600" />
                </div>
                <span className="text-sm font-medium text-gray-900">{r.mentor?.fullName ?? '—'}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
