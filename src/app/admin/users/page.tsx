'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge, RoleBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { roleHome } from '@/lib/roleHome';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT } from '@/i18n/client';

interface AdminUser {
  id: string;
  fullName: string;
  email: string;
  role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY' | 'SOURCE';
  isActive: boolean;
  emailVerified: boolean;
}

type RoleLabel = 'admin' | 'mentor' | 'mentee' | 'company' | 'source';

export default function AdminUsersPage() {
  const t = useT();
  const router = useRouter();
  const { data: session } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'ALL' | 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY' | 'SOURCE'>('ALL');
  // Archived = deactivated (isActive=false). Default view hides them so the list
  // stays uncluttered; the "Archived" tab reveals them for reactivation (#570).
  const [statusView, setStatusView] = useState<'ACTIVE' | 'ARCHIVED'>('ACTIVE');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [impersonateError, setImpersonateError] = useState<{ userId: string; message: string } | null>(null);
  const PAGE_SIZE = 20;

  const loginAs = async (u: AdminUser) => {
    if (busyId) return; // guard against a double-click firing two grants at once
    const reason = window.prompt(t.usersAdmin.impersonateReason) ?? undefined;
    setBusyId(u.id);
    setImpersonateError(null);
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: u.id, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t.usersAdmin.impersonateFailed);
      const signed = await signIn('impersonate', { grant: data.grant, redirect: false });
      if (signed?.ok) {
        router.push(roleHome(u.role));
        router.refresh();
        return;
      }
      throw new Error(t.usersAdmin.impersonateFailed);
    } catch (err) {
      setImpersonateError({ userId: u.id, message: err instanceof Error ? err.message : t.usersAdmin.impersonateFailed });
    }
    setBusyId(null);
  };

  const load = useCallback(async () => {
    const res = await fetch('/api/users');
    const { users } = await res.json();
    setUsers(users ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleActive = async (u: AdminUser) => {
    setBusyId(u.id);
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !u.isActive }),
      });
      if (res.ok) {
        setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, isActive: !x.isActive } : x)));
      }
    } finally {
      setBusyId(null);
    }
  };

  const q = search.trim().toLowerCase();
  const archivedCount = users.filter((u) => !u.isActive).length;
  const filtered = users.filter(
    (u) =>
      (statusView === 'ACTIVE' ? u.isActive : !u.isActive) &&
      (filter === 'ALL' || u.role === filter) &&
      (!q || u.fullName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const shown = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.usersAdmin.title}</h1>
        <p className="text-gray-500 mt-1">{t.usersAdmin.subtitle}</p>
      </div>

      <div className="inline-flex items-center gap-1 mb-4 p-1 rounded-lg bg-gray-100 dark:bg-gray-800">
        {(['ACTIVE', 'ARCHIVED'] as const).map((s) => (
          <button
            key={s}
            data-testid={`status-view-${s.toLowerCase()}`}
            onClick={() => { setStatusView(s); setPage(1); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusView === s ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {s === 'ACTIVE' ? t.usersAdmin.viewActive : `${t.usersAdmin.viewArchived}${archivedCount ? ` (${archivedCount})` : ''}`}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(['ALL', 'ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE'] as const).map((r) => (
          <button
            key={r}
            onClick={() => { setFilter(r); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === r ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {r === 'ALL' ? t.usersAdmin.all : t.usersAdmin[r.toLowerCase() as RoleLabel]}
          </button>
        ))}
        <input
          type="search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder={t.usersAdmin.searchPlaceholder}
          className="ml-auto w-full sm:w-64 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.usersAdmin.title} ({filtered.length})</CardTitle>
        </CardHeader>
        {loading ? (
          <SkeletonRows rows={6} />
        ) : shown.length === 0 ? (
          <p className="text-center py-12 text-gray-400">{t.usersAdmin.none}</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {shown.map((u) => (
              <div key={u.id} data-testid={`user-row-${u.id}`} className="flex flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="min-w-0 w-full sm:w-auto">
                  {u.role === 'MENTEE' ? (
                    <Link href={`/admin/candidates/${u.id}`} className="text-sm font-medium text-gray-900 hover:text-blue-600 truncate block">
                      {u.fullName}
                    </Link>
                  ) : (
                    <p className="text-sm font-medium text-gray-900 truncate">{u.fullName}</p>
                  )}
                  <p className="text-xs text-gray-500 truncate">{u.email}</p>
                  {impersonateError?.userId === u.id && (
                    <p className="text-xs text-red-600 mt-1">{impersonateError.message}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <RoleBadge role={u.role} />
                  <Badge variant={u.isActive ? 'success' : 'warning'}>
                    {u.isActive ? t.usersAdmin.active : t.usersAdmin.inactive}
                  </Badge>
                  {u.id !== session?.user?.id && (
                    <Button variant="ghost" size="sm" loading={busyId === u.id} disabled={!!busyId} onClick={() => loginAs(u)}>
                      {t.usersAdmin.loginAs}
                    </Button>
                  )}
                  <Button
                    variant={u.isActive ? 'outline' : 'primary'}
                    size="sm"
                    loading={busyId === u.id}
                    onClick={() => toggleActive(u)}
                  >
                    {u.isActive ? t.usersAdmin.deactivate : t.usersAdmin.activate}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pt-4 mt-2 border-t border-gray-50">
            <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}>{t.common.prev}</Button>
            <span className="text-sm text-gray-500">{currentPage} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage((p) => p + 1)}>{t.common.next}</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
