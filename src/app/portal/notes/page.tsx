'use client';

import { useT } from '@/i18n/client';
import { NotesPanel } from '@/components/NotesPanel';

export default function PortalNotesPage() {
  const t = useT();
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.portal.notes.title}</h1>
        <p className="text-gray-500 mt-1">{t.portal.notes.privateHint}</p>
      </div>
      <div className="max-w-2xl">
        <NotesPanel />
      </div>
    </div>
  );
}
