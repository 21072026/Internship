'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Download, Trash2, Upload } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DOCUMENT_TYPES } from '@/lib/documentAccess';
import { useT } from '@/i18n/client';

interface Doc {
  id: string;
  type: string;
  title: string;
  filename: string;
  size: number;
  version: number;
  createdAt: string;
}

// Generic document list + uploader. In `templates` mode it manages the shared
// admin template library; otherwise it manages one user's documents.
export function DocumentsManager({
  targetUserId,
  templates = false,
  canUpload = true,
  canDelete = true,
}: {
  targetUserId?: string;
  templates?: boolean;
  canUpload?: boolean;
  canDelete?: boolean;
}) {
  const t = useT();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [type, setType] = useState('OTHER');
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const query = templates ? 'templates=1' : `userId=${targetUserId ?? ''}`;
  const load = useCallback(async () => {
    const res = await fetch(`/api/documents?${query}`);
    if (res.ok) setDocs((await res.json()).documents ?? []);
  }, [query]);
  useEffect(() => { load(); }, [load]);

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('type', templates ? 'OTHER' : type);
      if (title) fd.append('title', title);
      if (templates) fd.append('isTemplate', 'true');
      else if (targetUserId) fd.append('targetUserId', targetUserId);
      const res = await fetch('/api/documents', { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t.common.error);
      setTitle(''); if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    await load();
  };

  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
  const typeLabel = (ty: string) => (t.documents.types as Record<string, string>)[ty] ?? ty;

  return (
    <Card>
      <CardHeader><CardTitle>{templates ? t.documents.uploadedTitle : t.documents.title}</CardTitle></CardHeader>

      {error && <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>}

      {docs.length === 0 ? (
        <p className="text-sm text-gray-400 mb-4">{t.documents.none}</p>
      ) : (
        <div className="divide-y divide-gray-50 mb-4">
          {docs.map((d) => (
            <div key={d.id} data-testid={`doc-${d.id}`} className="flex items-center gap-3 py-2">
              <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-800 truncate">{d.title}</p>
                <p className="text-xs text-gray-400">{kb(d.size)} · v{d.version}</p>
              </div>
              {!templates && <Badge variant="info">{typeLabel(d.type)}</Badge>}
              <a href={`/api/documents/${d.id}`} target="_blank" rel="noopener noreferrer" aria-label={t.documents.download} className="text-gray-400 hover:text-blue-600"><Download className="h-4 w-4" /></a>
              {canDelete && (
                <button onClick={() => remove(d.id)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
              )}
            </div>
          ))}
        </div>
      )}

      {canUpload && (
        <form onSubmit={upload} className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
          <input ref={fileRef} type="file" required className="text-sm max-w-[200px]" />
          {!templates && (
            <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-2 text-sm">
              {DOCUMENT_TYPES.map((ty) => <option key={ty} value={ty}>{typeLabel(ty)}</option>)}
            </select>
          )}
          <div className="w-40"><Input placeholder={t.documents.titlePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <Button type="submit" size="sm" loading={uploading}><Upload className="h-4 w-4 mr-1" />{t.documents.upload}</Button>
        </form>
      )}
    </Card>
  );
}
