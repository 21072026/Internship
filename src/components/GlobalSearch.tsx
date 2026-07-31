'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { useT } from '@/i18n/client';

interface UserHit { id: string; fullName: string; email: string; role: string; relationId?: string | null }
interface CompanyHit { id: string; name: string }

export function GlobalSearch() {
  const t = useT();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserHit[]>([]);
  const [companies, setCompanies] = useState<CompanyHit[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setUsers([]); setCompanies([]);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const d = await res.json();
        setUsers(d.users ?? []);
        setCompanies(d.companies ?? []);
        setOpen(true);
      } catch {
        /* ignore */
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQ('');
    router.push(href);
  };

  const userHref = (u: UserHit) =>
    u.relationId ? `/mentor/mentees/${u.relationId}` : u.role === 'MENTEE' ? `/admin/candidates/${u.id}` : `/admin/users`;

  return (
    <div className="relative w-56" ref={ref}>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white">
        <Search className="h-4 w-4 text-gray-400" />
        <input
          data-testid="global-search-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => q.trim().length >= 2 && setOpen(true)}
          placeholder={t.search.placeholder}
          className="flex-1 text-sm outline-none bg-transparent"
        />
      </div>
      {open && (users.length > 0 || companies.length > 0) && (
        <div className="absolute right-0 mt-2 w-72 max-h-96 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg z-50">
          {users.map((u) => (
            <button key={u.id} onClick={() => go(userHref(u))} className="block w-full text-left px-4 py-2.5 hover:bg-gray-50 text-sm">
              <span className="font-medium text-gray-900">{u.fullName}</span>
              <span className="text-xs text-gray-400 ml-2">{u.role}</span>
              <span className="block text-xs text-gray-500 truncate">{u.email}</span>
            </button>
          ))}
          {companies.map((c) => (
            <button key={c.id} onClick={() => go('/admin/companies')} className="block w-full text-left px-4 py-2.5 hover:bg-gray-50 text-sm">
              <span className="font-medium text-gray-900">{c.name}</span>
              <span className="text-xs text-gray-400 ml-2">{t.search.company}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
