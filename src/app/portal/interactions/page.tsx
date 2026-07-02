'use client';

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
    mentor: { fullName: string };
    mentee: { fullName: string };
  };
}

export default function PortalInteractionsPage() {
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
        <h1 className="text-2xl font-bold text-gray-900">Interaction Logs</h1>
        <p className="text-gray-500 mt-1">Your interaction history with your mentor</p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : interactions.length === 0 ? (
        <Card className="text-center py-12">
          <BookOpen className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No interactions logged yet</p>
          <p className="text-sm text-gray-400 mt-1">
            Your mentor will log interactions here as your sessions happen.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {interactions.map((interaction) => (
            <Card key={interaction.id}>
              <div className="flex items-start gap-4">
                <InteractionTypeBadge type={interaction.type} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-gray-700">{interaction.notes}</p>
                  <p className="text-xs text-gray-400 mt-2">
                    {new Date(interaction.date).toLocaleDateString('en-US', {
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
      )}
    </div>
  );
}
