'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Upload, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// Upload / replace / remove a profile picture.
export function AvatarManager({
  targetUserId,
  initialAvatarUrl,
  name,
}: {
  targetUserId: string;
  initialAvatarUrl?: string | null;
  name?: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const { update } = useSession();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatarUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshChrome = async () => {
    await update();
    router.refresh();
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('targetUserId', targetUserId);
      const res = await fetch('/api/avatar', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setAvatarUrl(`/api/avatar/${targetUserId}?t=${Date.now()}`);
      await refreshChrome();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await fetch(`/api/avatar/${targetUserId}`, { method: 'DELETE' });
      setAvatarUrl(null);
      await refreshChrome();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt={name || t.avatar.section} className="w-16 h-16 rounded-full object-cover border border-gray-200" />
      ) : (
        <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
          <span className="text-blue-700 font-bold text-2xl">{name?.[0] ?? '?'}</span>
        </div>
      )}
      <div>
        <p className="text-xs text-gray-500 mb-1">{t.avatar.title}</p>
        {error && <p className="text-xs text-red-600 mb-1">{error}</p>}
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
          />
          <Button type="button" variant="outline" size="sm" loading={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4 mr-1" />
            {avatarUrl ? t.avatar.replace : t.avatar.upload}
          </Button>
          {avatarUrl && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={remove}>
              <Trash2 className="h-4 w-4 mr-1" />
              {t.avatar.remove}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
