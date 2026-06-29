'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { roleHome } from '@/lib/roleHome';
import { useT } from '@/i18n/client';

interface AdminUser {
  id: string;
  fullName: string;
  email: string;
  role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY';
  isActive: boolean;
  emailVerified: boolean;
}

const ROLE_VARIANT: Record<string, 'info' | 'success' | 'warning' | 'purple'> = {
  ADMIN: 'warning',
  MENTOR: 'success',
  MENTEE: 'info',
  COMPANY: 'purple',
};

type RoleLabel = 'admin' | 'mentor' | 'mentee' | 'company';

export default function AdminUsersPage() {
  const t = useT();
  const router = useRouter();
  const { data: session } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'ALL' | 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY'>('ALL');
  const [busyId, setBusyId] = useState<string | null>(null);

  const loginAs = async (u: AdminUser) => {
    setBusyId(u.id);
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: u.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const signed = await signIn('impersonate', { grant: data.grant, redirect: false });
      if (signed?.ok) {
        router.push(roleHome(u.role));
        router.refresh();
        return;
      }
    } catch {
      // fall through to reset busy state
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

  const shown = users.filter((u) => filter === 'ALL' || u.role === filter);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.usersAdmin.title}</h1>
        <p className="text-gray-500 mt-1">{t.usersAdmin.subtitle}</p>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {(['ALL', 'ADMIN', 'MENTOR', 'MENTEE', 'COMPANY'] as const).map((r) => (
          <button
            key={r}
            onClick={() => setFilter(r)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === r ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {r === 'ALL' ? t.usersAdmin.all : t.usersAdmin[r.toLowerCase() as RoleLabel]}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.usersAdmin.title} ({shown.length})</CardTitle>
        </CardHeader>
        {loading ? (
          <p className="text-center py-12 text-gray-400">{t.common.loading}</p>
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
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={ROLE_VARIANT[u.role]}>{t.usersAdmin[u.role.toLowerCase() as RoleLabel]}</Badge>
                  <Badge variant={u.isActive ? 'success' : 'warning'}>
                    {u.isActive ? t.usersAdmin.active : t.usersAdmin.inactive}
                  </Badge>
                  {u.id !== session?.user?.id && (
                    <Button variant="ghost" size="sm" disabled={busyId === u.id} onClick={() => loginAs(u)}>
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
      </Card>
    </div>
  );
}
