'use client';

import { useState, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { AvatarManager } from '@/components/AvatarManager';
import { ConsentSettings } from '@/components/ConsentSettings';
import { useT } from '@/i18n/client';
import { locales, LOCALE_COOKIE } from '@/i18n/config';
import { ACCENT_COLORS, ACCENT_SWATCH, DEFAULT_ACCENT, resolveAccent } from '@/lib/accent';

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
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({});
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [twoFaEnabled, setTwoFaEnabled] = useState(false);
  const [twoFaSetup, setTwoFaSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [twoFaCode, setTwoFaCode] = useState('');
  const [twoFaBusy, setTwoFaBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [language, setLanguage] = useState('en');
  const [theme, setTheme] = useState('system');
  const [accent, setAccent] = useState<string>(DEFAULT_ACCENT);
  const [role, setRole] = useState('');
  const [skills, setSkills] = useState('');
  const [capacity, setCapacity] = useState('');
  const [savingExpertise, setSavingExpertise] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((r) => r.json())
      .then(({ user }) => {
        if (!user) return;
        setEmail(user.email);
        setEmailNotifications(user.emailNotifications !== false);
        setNotifPrefs((user.notificationPrefs && typeof user.notificationPrefs === 'object') ? user.notificationPrefs : {});
        setLanguage(user.preferredLanguage ?? 'en');
        setTheme(user.theme ?? 'system');
        setAccent(resolveAccent(user.accentColor));
        setRole(user.role ?? '');
        setSkills(Array.isArray(user.skills) ? user.skills.join(', ') : '');
        setCapacity(user.mentorCapacity != null ? String(user.mentorCapacity) : '');
        setMe({ id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl ?? null });
      });
    fetch('/api/account/2fa').then((r) => r.json()).then((d) => setTwoFaEnabled(!!d.enabled)).catch(() => {});
  }, []);

  const twoFa = async (action: 'setup' | 'enable' | 'disable') => {
    setTwoFaBusy(true);
    try {
      const res = await fetch('/api/account/2fa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, code: twoFaCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (action === 'setup') setTwoFaSetup({ secret: data.secret, otpauth: data.otpauth });
      else if (action === 'enable') { setTwoFaEnabled(true); setTwoFaSetup(null); setTwoFaCode(''); flash(t.account.updated); }
      else { setTwoFaEnabled(false); setTwoFaSetup(null); setTwoFaCode(''); flash(t.account.updated); }
    } catch (e2) {
      flash(e2 instanceof Error ? e2.message : 'Failed', true);
    } finally {
      setTwoFaBusy(false);
    }
  };

  const changeTheme = async (next: string) => {
    setTheme(next);
    const root = document.documentElement;
    if (next === 'system') {
      try { localStorage.removeItem('theme'); } catch { /* ignore */ }
      document.cookie = 'theme=; path=/; max-age=0';
      const osDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', !!osDark);
    } else {
      try { localStorage.setItem('theme', next); } catch { /* ignore */ }
      document.cookie = `theme=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
      root.classList.toggle('dark', next === 'dark');
    }
    try {
      await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: next }) });
    } catch { /* ignore */ }
  };

  const changeAccent = async (next: string) => {
    setAccent(next);
    // Apply instantly (no reload) by flipping the attribute the CSS keys off,
    // and persist to a cookie so SSR paints the same accent on the next load.
    document.documentElement.setAttribute('data-accent', next);
    document.cookie = `accent=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    try {
      await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accentColor: next }),
      });
      flash(t.account.updated);
    } catch {
      // cookie + attribute already applied locally
    }
  };

  const changeLanguage = async (next: string) => {
    setLanguage(next);
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}`;
    try {
      await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredLanguage: next }),
      });
    } catch {
      // cookie already applied
    }
    window.location.reload();
  };

  const saveExpertise = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingExpertise(true);
    try {
      const skillsArr = skills.split(',').map((x) => x.trim()).filter(Boolean);
      const res = await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: skillsArr, mentorCapacity: capacity ? Number(capacity) : null }),
      });
      if (!res.ok) throw new Error();
      flash(t.account.updated);
    } catch {
      flash('Failed', true);
    } finally {
      setSavingExpertise(false);
    }
  };

  const togglePref = async (cat: string, next: boolean) => {
    const updated = { ...notifPrefs, [cat]: next };
    setNotifPrefs(updated);
    setSavingPrefs(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationPrefs: updated }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setNotifPrefs(notifPrefs);
      flash('Failed', true);
    } finally {
      setSavingPrefs(false);
    }
  };

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

  const signOutAll = async () => {
    setSignOutBusy(true);
    try {
      const res = await fetch('/api/account/sign-out-all', { method: 'POST' });
      if (!res.ok) throw new Error();
      // The current cookie is now invalid too — clear it and go to sign-in.
      await signOut({ callbackUrl: '/auth/signin' });
    } catch {
      flash('Failed', true);
      setSignOutBusy(false);
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

      {role === 'MENTOR' && (
        <Card className="mt-6 max-w-4xl">
          <CardHeader><CardTitle>{t.account.expertiseSection}</CardTitle></CardHeader>
          <form onSubmit={saveExpertise} className="space-y-4 max-w-lg">
            <div>
              <Input label={t.account.expertise} hint={t.account.expertiseHint} value={skills} onChange={(e) => setSkills(e.target.value)} />
            </div>
            <Input label={t.account.capacity} type="number" min={0} hint={t.account.capacityHint} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            <Button type="submit" loading={savingExpertise}>{t.profileForm.save}</Button>
          </form>
        </Card>
      )}

      <Card className="mt-6 max-w-4xl">
        <CardHeader><CardTitle>{t.account.twoFactorSection}</CardTitle></CardHeader>
        {twoFaEnabled ? (
          <div className="space-y-3 max-w-sm">
            <p className="text-sm text-green-700">✓ {t.account.twoFactorOn}</p>
            <Input label={t.account.twoFactorCode} inputMode="numeric" placeholder="123456" value={twoFaCode} onChange={(e) => setTwoFaCode(e.target.value)} />
            <Button variant="outline" loading={twoFaBusy} disabled={!twoFaCode} onClick={() => twoFa('disable')}>{t.account.twoFactorDisable}</Button>
          </div>
        ) : twoFaSetup ? (
          <div className="space-y-3 max-w-md">
            <p className="text-sm text-gray-600">{t.account.twoFactorScan}</p>
            <p className="text-xs text-gray-500">{t.account.twoFactorSecret}:</p>
            <code className="block bg-gray-50 border border-gray-200 rounded px-3 py-2 text-sm break-all">{twoFaSetup.secret}</code>
            <a href={twoFaSetup.otpauth} className="text-xs text-blue-600 hover:underline break-all">{twoFaSetup.otpauth}</a>
            <Input label={t.account.twoFactorCode} inputMode="numeric" placeholder="123456" value={twoFaCode} onChange={(e) => setTwoFaCode(e.target.value)} />
            <Button loading={twoFaBusy} disabled={!twoFaCode} onClick={() => twoFa('enable')}>{t.account.twoFactorConfirm}</Button>
          </div>
        ) : (
          <div className="space-y-2 max-w-sm">
            <p className="text-sm text-gray-600">{t.account.twoFactorHint}</p>
            <Button variant="outline" loading={twoFaBusy} onClick={() => twoFa('setup')}>{t.account.twoFactorEnable}</Button>
          </div>
        )}
      </Card>

      <Card className="mt-6 max-w-4xl">
        <CardHeader><CardTitle>{t.account.sessionsSection}</CardTitle></CardHeader>
        <p className="text-sm text-gray-600 mb-4 max-w-lg">{t.account.sessionsHint}</p>
        <Button variant="outline" loading={signOutBusy} onClick={signOutAll}>{t.account.signOutAll}</Button>
      </Card>

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

        <div className={`mt-3 space-y-1.5 pl-6 ${emailNotifications ? '' : 'opacity-40 pointer-events-none'}`}>
          {(['messages', 'announcements', 'deadlines', 'digest'] as const).map((cat) => (
            <label key={cat} className="flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={notifPrefs[cat] !== false}
                disabled={savingPrefs || !emailNotifications}
                onChange={(e) => togglePref(cat, e.target.checked)}
              />
              {(t.account.notifCategories as Record<string, string>)[cat]}
            </label>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.account.language}</label>
            <select
              value={language}
              onChange={(e) => changeLanguage(e.target.value)}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {locales.map((l) => (
                <option key={l} value={l}>{(t.account.languages as Record<string, string>)[l] ?? l.toUpperCase()}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.account.themeLabel}</label>
            <select
              value={theme}
              onChange={(e) => changeTheme(e.target.value)}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="system">{t.theme.system}</option>
              <option value="light">{t.theme.light}</option>
              <option value="dark">{t.theme.dark}</option>
            </select>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100 max-w-md">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.account.accentLabel}</label>
          <p className="text-xs text-gray-400 mb-2">{t.account.accentHint}</p>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t.account.accentLabel}>
            {ACCENT_COLORS.map((c) => {
              const selected = accent === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={(t.account.accentColors as Record<string, string>)[c] ?? c}
                  title={(t.account.accentColors as Record<string, string>)[c] ?? c}
                  onClick={() => changeAccent(c)}
                  className={`h-8 w-8 rounded-full ring-offset-2 ring-offset-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 ${selected ? 'ring-2 ring-gray-500' : 'ring-1 ring-gray-200 hover:ring-gray-300'}`}
                  style={{ backgroundColor: ACCENT_SWATCH[c] }}
                >
                  {selected && <span className="flex items-center justify-center text-white text-sm leading-none">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      <ConsentSettings />

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
