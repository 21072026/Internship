'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { BookOpen } from 'lucide-react';
import { useLocale } from '@/i18n/client';
import { useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { AsyncSection } from '@/components/ui/AsyncSection';
import { AutoLoggedBadge } from '@/components/AutoLoggedBadge';

interface Interaction {
  id: string;
  date: string;
  notes: string;
  type: string;
  autoLogged?: boolean;
  relation: {
    mentor: { fullName: string };
    mentee: { fullName: string };
  };
}

export default function PortalInteractionsPage() {
  const locale = useLocale();
  const t = useT();
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchInteractions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/interactions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setInteractions(data.interactions || []);
    } catch {
      setError(t.common.error);
    } finally {
      setLoading(false);
    }
  }, [t.common.error]);

  useEffect(() => {
    fetchInteractions();
  }, [fetchInteractions]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.interactions.title}</h1>
        <p className="text-gray-500 mt-1">{t.portal.interactions.subtitle}</p>
      </div>

      <AsyncSection
        loading={loading}
        error={error}
        empty={interactions.length === 0}
        emptyText={<Card className="text-center py-12">
          <BookOpen className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t.portal.interactions.none}</p>
          <p className="text-sm text-gray-400 mt-1">{t.portal.interactions.noneHint}</p>
        </Card>}
        retryText={t.errorBoundary.retry}
        onRetry={fetchInteractions}
        skeleton="list"
      >
        <div className="space-y-4">
          {interactions.map((interaction) => (
            <Card key={interaction.id}>
              <div className="flex items-start gap-4">
                <InteractionTypeBadge type={interaction.type} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-gray-700">{interaction.notes}</p>
                  <AutoLoggedBadge autoLogged={interaction.autoLogged} className="text-xs mt-2" />
                  <p className="text-xs text-gray-400 mt-2">
                    {formatDate(interaction.date, locale, {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </AsyncSection>
    </div>
  );
}
