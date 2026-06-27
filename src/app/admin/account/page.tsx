'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

export default function AccountPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((r) => r.json())
      .then(({ user }) => user && setEmail(user.email));
  }, []);

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
    if (!res.ok) throw new Error(data.error || 'Failed');
    return data;
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingEmail(true);
    try {
      await call({ email });
      flash(`${t.account.updated}. ${t.account.reloginNote}`);
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

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{t.account.title}</h1>
        <p className="text-gray-500 mt-1">{t.account.subtitle}</p>
      </div>

      {msg && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">✓ {msg}</div>}
      {err && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{err}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
        <Card>
          <CardHeader><CardTitle>{t.account.emailSection}</CardTitle></CardHeader>
          <form onSubmit={submitEmail} className="space-y-4">
            <Input label={t.account.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Button type="submit" loading={savingEmail}>{t.account.updateEmail}</Button>
          </form>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.account.passwordSection}</CardTitle></CardHeader>
          <form onSubmit={submitPassword} className="space-y-4">
            <Input label={t.account.currentPassword} type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            <Input label={t.account.newPassword} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            <Input label={t.account.confirmPassword} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            <Button type="submit" loading={savingPw}>{t.account.updatePassword}</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
