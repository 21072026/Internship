'use client';

import { useState, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { AvatarManager } from '@/components/AvatarManager';
import { useT } from '@/i18n/client';

// Universal account settings used by every role (admin/mentor/mentee/company):
// change email, change password, and delete the account.
export function AccountSettings() {
  const t = useT();
  const { update } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingPw, setSavingPw] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [me, setMe] = useState<{ id: string; fullName: string; avatarUrl: string | null } | null>(null);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((r) => r.json())
      .then(({ user }) => {
        if (!user) return;
        setEmail(user.email);
        setEmailNotifications(user.emailNotifications !== false);
        setMe({ id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl ?? null });
      });
  }, []);

  const toggleEmailNotifications = async (next: boolean) => {
    setEmailNotifications(next);
    setSavingPrefs(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailNotifications: next }),
      });
      if (!res.ok) throw new Error();
      flash(t.account.updated);
    } catch {
      setEmailNotifications(!next);
      flash('Failed', true);
    } finally {
      setSavingPrefs(false);
    }
  };

  const flash = (m: string, isErr = false) => {
    setMsg(isErr ? '' : m);
    setErr(isErr ? m : '');
    setTimeout(() => { setMsg(''); setErr(''); }, 4000);
  };

  const call = async (body: object) => {
    const res = await fetch('/api/account', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || (data.details && 'Validation failed') || 'Failed');
    return data;
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingEmail(true);
    try {
      await call({ email, currentPassword: emailPassword });
      setEmailPassword('');
      await update();
      router.refresh();
      flash(t.account.updated);
    } catch (e2) {
      flash(e2 instanceof Error ? e2.message : 'Failed', true);
    } finally {
      setSavingEmail(false);
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) return flash(t.account.passwordMismatch, true);
    setSavingPw(true);
    try {
      await call({ currentPassword, newPassword });
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      flash(t.account.updated);
    } catch (e2) {
      flash(e2 instanceof Error ? e2.message : 'Failed', true);
    } finally {
      setSavingPw(false);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: deletePassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      await signOut({ callbackUrl: '/' });
    } catch (e2) {
      flash(e2 instanceof Error ? e2.message : 'Failed', true);
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{t.account.title}</h1>
        <p className="text-gray-500 mt-1">{t.account.subtitle}</p>
      </div>

      {msg && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">✓ {msg}</div>}
      {err && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{err}</div>}

      {me && (
        <Card className="mb-6 max-w-4xl">
          <CardHeader><CardTitle>{t.avatar.section}</CardTitle></CardHeader>
          <AvatarManager targetUserId={me.id} initialAvatarUrl={me.avatarUrl} name={me.fullName} />
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
        <Card>
          <CardHeader><CardTitle>{t.account.emailSection}</CardTitle></CardHeader>
          <form onSubmit={submitEmail} className="space-y-4">
            <Input label={t.account.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Input id="email-current-password" label={t.account.currentPassword} type="password" autoComplete="current-password" hint={t.account.emailPwHint} value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} required />
            <Button type="submit" loading={savingEmail}>{t.account.updateEmail}</Button>
          </form>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.account.passwordSection}</CardTitle></CardHeader>
          <form onSubmit={submitPassword} className="space-y-4">
            <Input label={t.account.currentPassword} type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            <Input label={t.account.newPassword} type="password" hint={t.account.passwordHint} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            <Input label={t.account.confirmPassword} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            <Button type="submit" loading={savingPw}>{t.account.updatePassword}</Button>
          </form>
        </Card>
      </div>

      <Card className="mt-6 max-w-4xl">
        <CardHeader><CardTitle>{t.account.notificationsSection}</CardTitle></CardHeader>
        <label className="flex items-center gap-3 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={emailNotifications}
            disabled={savingPrefs}
            onChange={(e) => toggleEmailNotifications(e.target.checked)}
          />
          {t.account.emailNotifications}
        </label>
        <p className="text-xs text-gray-400 mt-1">{t.account.emailNotificationsHint}</p>
      </Card>

      <Card className="mt-6 max-w-4xl">
        <CardHeader><CardTitle>{t.account.dataSection}</CardTitle></CardHeader>
        <p className="text-sm text-gray-600 mb-4">{t.account.dataHint}</p>
        <a
          href="/api/account/export"
          className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
        >
          {t.account.exportData}
        </a>
      </Card>

      <Card className="mt-6 max-w-4xl border-red-200">
        <CardHeader><CardTitle>{t.account.deleteSection}</CardTitle></CardHeader>
        <p className="text-sm text-gray-600 mb-4">{t.account.deleteWarning}</p>
        {confirmDelete ? (
          <div className="space-y-3 max-w-sm">
            <p className="text-sm text-red-700">{t.account.deleteConfirm}</p>
            <Input id="delete-current-password" label={t.account.currentPassword} type="password" autoComplete="current-password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} required />
            <div className="flex items-center gap-2">
              <Button variant="danger" loading={deleting} disabled={!deletePassword} onClick={deleteAccount}>{t.account.deleteYes}</Button>
              <Button variant="outline" onClick={() => { setConfirmDelete(false); setDeletePassword(''); }}>{t.account.deleteCancel}</Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>{t.account.deleteButton}</Button>
        )}
      </Card>
    </div>
  );
}
