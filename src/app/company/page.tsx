'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { pipelineLabel } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

interface Relation {
  id: string;
  pipelineStatus: string;
  mentee: { fullName: string; university?: string };
  mentor: { fullName: string };
}

// Read-only company overview: the mentees linked to this company.
export default function CompanyOverviewPage() {
  const t = useT();
  const locale = useLocale();
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
        <h1 className="text-2xl font-bold text-gray-900">{t.company.title}</h1>
        <p className="text-gray-500 mt-1">{t.company.subtitle}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.company.candidates} ({relations.length})</CardTitle>
        </CardHeader>
        {loading ? (
          <p className="text-center py-12 text-gray-400">{t.common.loading}</p>
        ) : relations.length === 0 ? (
          <p className="text-center py-12 text-gray-400">{t.company.none}</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {relations.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{r.mentee.fullName}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {r.mentee.university ? `${r.mentee.university} · ` : ''}
                    {t.company.mentor}: {r.mentor.fullName}
                  </p>
                </div>
                <Badge variant="info" className="flex-shrink-0">
                  {pipelineLabel(r.pipelineStatus, locale)}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
