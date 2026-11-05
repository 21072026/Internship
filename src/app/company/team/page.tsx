'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { SEAT_ROLES, companyCan, type SeatRole } from '@/lib/companySeats';
import type { PendingInvite, TeamMember } from '@/lib/companyTeam';

interface Team {
  members: TeamMember[];
  invites: PendingInvite[];
  mySeat: SeatRole;
  me: string;
}

// /company/team (#1870, docs/company-team-seats.md) — who has a seat at the
// company and in which role. Everyone with a seat sees the list; only an OWNER
// sees the controls, and the server refuses the writes for anyone else
// (requireCompanySeat 'team.manage') — hiding them here is convenience only.
export default function CompanyTeamPage() {
  const t = useT();
  const locale = useLocale();
  const p = t.companyTeam;
  const [team, setTeam] = useState<Team | null>(null);
  const [email, setEmail] = useState('');
  const [seatRole, setSeatRole] = useState<SeatRole>('RECRUITER');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    fetch('/api/company/team')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTeam(d))
      .catch(() => setTeam(null));
  }, []);
  useEffect(() => load(), [load]);

  const errorText = async (res: Response) => {
    const body = await res.json().catch(() => null);
    const code = body?.code as keyof typeof p.errors | undefined;
    if (code === 'seat_limit_reached') return p.errors.seat_limit_reached.replace('{limit}', String(body.limit));
    return (code && p.errors[code]) || p.errors.generic;
  };

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/company/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, seatRole, locale }),
      });
      if (res.ok) {
        setEmail('');
        setMessage({ ok: true, text: p.invited });
        load();
      } else {
        setMessage({ ok: false, text: await errorText(res) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function change(userId: string, next: SeatRole) {
    setMessage(null);
    const res = await fetch(`/api/company/team/${userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seatRole: next }) });
    if (!res.ok) setMessage({ ok: false, text: await errorText(res) });
    load();
  }

  async function remove(userId: string) {
    if (!window.confirm(p.removeConfirm)) return;
    setMessage(null);
    const res = await fetch(`/api/company/team/${userId}`, { method: 'DELETE' });
    if (!res.ok) setMessage({ ok: false, text: await errorText(res) });
    load();
  }

  if (!team) return <p className="py-10 text-center text-gray-500">{t.common.loading}</p>;
  const canManage = companyCan(team.mySeat, 'team.manage');

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{p.title}</h1>
        <p className="mt-1 text-gray-500">{p.subtitle}</p>
      </div>

      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm text-green-700' : 'text-sm text-red-600'} data-testid="company-team-message">
          {message.text}
        </p>
      )}

      <Card>
        <CardHeader><CardTitle>{p.members}</CardTitle></CardHeader>
        <ul className="divide-y divide-gray-100" data-testid="company-team-members">
          {team.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-3" data-testid={`company-team-member-${m.userId}`}>
              <div className="min-w-0">
                <p className="font-medium text-gray-900">{m.fullName ?? m.email}</p>
                <p className="text-xs text-gray-500">{m.email}</p>
              </div>
              <div className="flex items-center gap-2">
                {canManage && m.userId !== team.me ? (
                  <>
                    <select
                      aria-label={p.seatRole}
                      value={m.seatRole}
                      onChange={(e) => void change(m.userId, e.target.value as SeatRole)}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                    >
                      {SEAT_ROLES.map((r) => <option key={r} value={r}>{p.roles[r]}</option>)}
                    </select>
                    <button type="button" onClick={() => void remove(m.userId)} className="rounded border border-gray-300 px-2 py-1 text-xs text-red-700 hover:bg-gray-100">
                      {p.remove}
                    </button>
                  </>
                ) : (
                  <Badge variant={m.seatRole === 'OWNER' ? 'info' : 'default'}>{p.roles[m.seatRole]}</Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {team.invites.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{p.pending}</CardTitle></CardHeader>
          <ul className="divide-y divide-gray-100">
            {team.invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2 text-sm">
                <span>{i.email}</span>
                <span className="text-gray-500">{p.roles[i.seatRole]} · {p.expires.replace('{date}', formatDate(i.expiresAt, locale))}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader><CardTitle>{p.invite}</CardTitle></CardHeader>
          <form onSubmit={invite} className="flex flex-wrap items-end gap-3" data-testid="company-team-invite">
            <div className="min-w-[16rem] flex-1">
              <Input id="team-email" type="email" label={p.email} required maxLength={191} value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              {p.seatRole}
              <select value={seatRole} onChange={(e) => setSeatRole(e.target.value as SeatRole)} className="rounded-md border border-gray-300 px-2 py-2 text-sm">
                {SEAT_ROLES.map((r) => <option key={r} value={r}>{p.roles[r]}</option>)}
              </select>
            </label>
            <Button type="submit" disabled={busy}>{p.send}</Button>
          </form>
          <p className="mt-3 text-xs text-gray-500">{p.rolesHelp}</p>
        </Card>
      )}
    </div>
  );
}
