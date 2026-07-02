'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Users, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useT } from '@/i18n/client';

interface MentorUser {
  id: string;
  fullName: string;
  email: string;
  department?: string;
  skills?: string[];
  mentorCapacity?: number | null;
  _count: { mentorRelations: number };
}

export default function MentorsPage() {
  const t = useT();
  const [mentors, setMentors] = useState<MentorUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<MentorUser | null>(null);
  const [skillsText, setSkillsText] = useState('');
  const [capacityText, setCapacityText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/users')
      .then((res) => res.json())
      .then(({ users }) => {
        setMentors((users ?? []).filter((u: { role: string }) => u.role === 'MENTOR'));
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEdit = (m: MentorUser) => {
    setEditing(m);
    setSkillsText((m.skills ?? []).join(', '));
    setCapacityText(m.mentorCapacity != null ? String(m.mentorCapacity) : '');
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const skills = skillsText.split(',').map((s) => s.trim()).filter(Boolean);
      const mentorCapacity = capacityText.trim() === '' ? null : Number(capacityText);
      await fetch(`/api/users/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills, mentorCapacity }),
      });
      setEditing(null);
      load();
    } finally {
      setSaving(false);
    }
  };

  const q = search.trim().toLowerCase();
  const shown = mentors.filter(
    (m) =>
      !q ||
      m.fullName.toLowerCase().includes(q) ||
      m.email.toLowerCase().includes(q) ||
      (m.skills ?? []).some((s) => s.toLowerCase().includes(q))
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentors.title}</h1>
        <p className="text-gray-500 mt-1">{t.mentors.subtitle}</p>
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t.mentors.searchPlaceholder}
        className="mb-4 w-full sm:w-80 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
      />

      <Card>
        <CardHeader>
          <CardTitle>{t.mentors.title} ({shown.length})</CardTitle>
        </CardHeader>

        {loading ? (
          <p className="text-center py-12 text-gray-400">{t.common.loading}</p>
        ) : shown.length === 0 ? (
          <p className="text-center py-12 text-gray-400">{t.mentors.none}</p>
        ) : (
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {shown.map((m) => {
              const cap = m.mentorCapacity;
              const atCapacity = cap != null && cap > 0 && m._count.mentorRelations >= cap;
              return (
                <div key={m.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <span className="text-green-700 font-semibold text-sm">{m.fullName?.[0] || 'M'}</span>
                    </div>
                    <div className="min-w-0">
                      <Link href={`/admin/mentors/${m.id}`} className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 truncate block">{m.fullName}</Link>
                      <p className="text-xs text-gray-500 truncate">
                        {m.email}
                        {m.department ? ` · ${m.department}` : ''}
                      </p>
                      {/* Expertise chips power the skill-match suggestions. */}
                      {m.skills && m.skills.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {m.skills.map((s) => (
                            <span key={s} className="inline-flex rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 text-[11px]">
                              {s}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1.5 text-[11px] text-amber-600">{t.mentors.noExpertise}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <Badge variant={atCapacity ? 'warning' : 'info'} className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {m._count.mentorRelations}{cap != null ? `/${cap}` : ''} {t.mentors.mentee}
                    </Badge>
                    <Button variant="outline" size="sm" onClick={() => openEdit(m)}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t.mentors.editExpertise}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">{t.mentors.editExpertise}</h2>
            <p className="text-sm text-gray-500 mb-4">{editing.fullName}</p>
            <div className="space-y-4">
              <Input
                label={t.mentors.skillsLabel}
                hint={t.mentors.skillsHint}
                value={skillsText}
                onChange={(e) => setSkillsText(e.target.value)}
                placeholder="React, Node, AWS"
              />
              <Input
                label={t.mentors.capacityLabel}
                hint={t.mentors.capacityHint}
                type="number"
                min={0}
                value={capacityText}
                onChange={(e) => setCapacityText(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <Button variant="outline" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
              <Button onClick={save} loading={saving}>{t.common.save}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
