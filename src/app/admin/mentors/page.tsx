'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Users } from 'lucide-react';

interface MentorUser {
  id: string;
  fullName: string;
  email: string;
  department?: string;
  phone?: string;
  _count: { mentorRelations: number };
}

export default function MentorsPage() {
  const [mentors, setMentors] = useState<MentorUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/users')
      .then((res) => res.json())
      .then(({ users }) => {
        setMentors((users ?? []).filter((u: { role: string }) => u.role === 'MENTOR'));
        setLoading(false);
      });
  }, []);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Mentors</h1>
        <p className="text-gray-500 mt-1">All mentors on the platform</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Mentors ({mentors.length})</CardTitle>
        </CardHeader>

        {loading ? (
          <p className="text-center py-12 text-gray-400">Loading...</p>
        ) : mentors.length === 0 ? (
          <p className="text-center py-12 text-gray-400">No mentors yet</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {mentors.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-green-700 font-semibold text-sm">{m.fullName?.[0] || 'M'}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{m.fullName}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {m.email}
                      {m.department ? ` · ${m.department}` : ''}
                    </p>
                  </div>
                </div>
                <Badge variant="info" className="flex items-center gap-1 flex-shrink-0">
                  <Users className="h-3 w-3" />
                  {m._count.mentorRelations} mentee
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
