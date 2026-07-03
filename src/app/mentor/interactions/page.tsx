'use client';
import { useT } from "@/i18n/client";

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { BookOpen } from 'lucide-react';

interface Interaction {
  id: string;
  date: string;
  notes: string;
  type: string;
  relation: {
    mentee: { fullName: string };
    mentor: { fullName: string };
  };
}

export default function MentorInteractionsPage() {
  const t = useT();
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchInteractions = useCallback(async () => {
    const res = await fetch('/api/interactions');
    const data = await res.json();
    setInteractions(data.interactions || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchInteractions();
  }, [fetchInteractions]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{t.nav.interactionLogs}</h1>
        <p className="text-gray-500 mt-1">{t.mentor.interactionLogsSubtitle}</p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">{t.common.loading}</div>
      ) : interactions.length === 0 ? (
        <Card className="text-center py-12">
          <BookOpen className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t.mentor.noInteractionsYet}</p>
          <p className="text-sm text-gray-400 mt-1">{t.mentor.goToMenteeToLog}</p>
          <div className="mt-6 max-w-md mx-auto text-left opacity-50 pointer-events-none">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">{t.mentor.exampleLog}</p>
            <div className="flex items-start gap-4 py-3 border-b border-dashed border-gray-200">
              <InteractionTypeBadge type="Meeting" className="text-xs flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-700 mb-1">{t.mentor.exampleLogWith}</p>
                <p className="text-sm text-gray-600">{t.mentor.exampleLogNote}</p>
              </div>
              <span className="text-xs text-gray-400 flex-shrink-0">{new Date().toLocaleDateString()}</span>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="space-y-3">
            {interactions.map((interaction) => (
              <div key={interaction.id} className="flex items-start gap-4 py-4 border-b border-gray-50 last:border-0">
                <InteractionTypeBadge type={interaction.type} className="text-xs flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-700">
                      with {interaction.relation.mentee.fullName}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600">{interaction.notes}</p>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">
                  {new Date(interaction.date).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
