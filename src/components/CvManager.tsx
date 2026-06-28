'use client';

import { useRef, useState } from 'react';
import { FileText, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// Upload / view / replace / delete a CV. Used by the mentee (self) on the
// portal profile and by mentor/admin on a mentee's detail page.
export function CvManager({ targetUserId, initialCvUrl }: { targetUserId?: string; initialCvUrl?: string | null }) {
  const t = useT();
  const [cvUrl, setCvUrl] = useState<string | null>(initialCvUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (targetUserId) fd.append('targetUserId', targetUserId);
      const res = await fetch('/api/cv', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCvUrl(targetUserId ? `/api/cv/${targetUserId}` : data.url ?? '/api/cv/me');
      // cache-bust the view link
      setCvUrl((u) => (u ? `${u.split('?')[0]}?t=${Date.now()}` : u));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!cvUrl) return;
    setBusy(true);
    try {
      const base = cvUrl.split('?')[0];
      await fetch(base, { method: 'DELETE' });
      setCvUrl(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{t.cv.title}</p>
      {error && <p className="text-xs text-red-600 mb-1">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {cvUrl ? (
          <a
            href={cvUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
          >
            <FileText className="h-4 w-4" /> {t.cv.view}
          </a>
        ) : (
          <span className="text-sm text-gray-400">{t.cv.none}</span>
        )}

        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
        <Button type="button" variant="outline" size="sm" loading={busy} onClick={() => fileRef.current?.click()}>
          <Upload className="h-4 w-4 mr-1" />
          {cvUrl ? t.cv.replace : t.cv.upload}
        </Button>
        {cvUrl && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={remove}>
            <Trash2 className="h-4 w-4 mr-1" />
            {t.cv.delete}
          </Button>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-1">{t.cv.hint}</p>
    </div>
  );
}
