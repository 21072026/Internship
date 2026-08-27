'use client';

import { useState, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { AvatarManager } from '@/components/AvatarManager';
import { ConsentSettings } from '@/components/ConsentSettings';
import { useT } from '@/i18n/client';
import { locales, LOCALE_COOKIE } from '@/i18n/config';
import { ACCENT_COLORS, ACCENT_SWATCH, DEFAULT_ACCENT, resolveAccent } from '@/lib/accent';
import { durationSince } from '@/lib/relativeTime';
import { canUseBrowserNotifications, browserNotificationsPrefOn, setBrowserNotificationsPref } from '@/lib/browserNotifications';
import { pushSupported, registerPushSubscription, unregisterPushSubscription } from '@/lib/pushNotifications';
import { NOTIFICATION_CATEGORIES } from '@/lib/notificationPrefs';
import { EMAIL_GROUPS, emailGroupPrefKey, resolveEmailGroupPrefs, type EmailGroupId } from '@/lib/emailGroups';
import { meetingNotesAutoOpen, setMeetingNotesAutoOpen } from '@/components/meeting/FloatingNotes';
import { browserTimeZone, formatInTimeZone, resolveTimeZone, timeZoneOptions } from '@/lib/timezone';
import { GoogleCalendarCard } from '@/components/GoogleCalendarCard';

// Universal account settings used by every role (admin/mentor/mentee/company):
// change email, change password, and delete the account.
export function AccountSettings() {
  const t = useT();
  const { data: session, update } = useSession();
  const router = useRouter();
  // Read after mount, not during render: localStorage doesn't exist on the
  // server and reading it while rendering would break hydration.
  const [notesAutoOpen, setNotesAutoOpen] = useState(true);
  useEffect(() => setNotesAutoOpen(meetingNotesAutoOpen()), []);
  // While an admin impersonates someone, `/api/account` refuses every
  // credential change and the account deletion outright (PUT/DELETE both 400).
  // Rendering those cards anyway made the page a trap: an admin who wanted to
  // delete a user's account was asked for a password only the user knows, and
  // even the right one would have been rejected. Admin-side erasure lives on
  // the candidate/user screens instead.
  //
  // The same applies to the two-factor and sessions cards (#1039): both are
  // decisions only the account holder can make for themselves — enrolling an
  // authenticator the owner does not hold, dropping the factor that protects
  // them, or killing every device they are signed in on. The endpoints behind
  // them now 400 during impersonation, so the cards go with them.
  const impersonating = Boolean(session?.user?.impersonatorId);
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
  const [me, setMe] = useState<{ id: string; fullName: string; avatarUrl: string | null; createdAt: string | null } | null>(null);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({});
  // Per-group e-mail preferences (#1444). These are NOT a second copy of
  // `notifPrefs`: they are the resolved *answers* for the twelve e-mail groups,
  // derived from the same JSON blob but flattened through the back-compat rules
  // in resolveEmailGroupPrefs (a legacy `mentorship: false` shows up here as
  // `mentorship_lifecycle: false` even though no `email:` key exists yet). The
  // blob itself stays the single stored truth and is what we PUT back.
  const [groupPrefs, setGroupPrefs] = useState<Record<EmailGroupId, boolean>>(() => resolveEmailGroupPrefs({}));
  // Has GET /api/profile come back yet? Both switch lists below write the WHOLE
  // notificationPrefs blob back (PUT /api/profile replaces that column, it does
  // not merge), and until this is true `notifPrefs` is still the empty initial
  // object. A click in that window would therefore PUT `{ 'email:digests':
  // false }` and silently delete every key the user actually had — a legacy
  // in-app opt-out, another group, all of it. The switches also render
  // optimistically "on" during that window, so they are not merely unsaveable,
  // they are showing a default rather than an answer. Both lists stay disabled
  // until the stored truth has arrived.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // …and if that request never answers usefully, SAY SO. Both lists below are
  // gated on `prefsLoaded`, so a 500 (or a `{}` body) used to leave twenty-three
  // switches dead for the life of the page with nothing on screen explaining
  // why — and the legacy list, which used to stay interactive, silently joined
  // them. Disabled-and-honest still beats enabled-and-destructive; this is the
  // "honest" half.
  const [prefsLoadFailed, setPrefsLoadFailed] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  // Browser (foreground) notifications — per-device, not stored server-side (#675).
  const [browserNotif, setBrowserNotif] = useState(false);
  const [browserNotifSupported, setBrowserNotifSupported] = useState(false);
  const [browserNotifDenied, setBrowserNotifDenied] = useState(false);
  // True once this browser holds a stored Web Push subscription, i.e. it will be
  // notified with the app closed and not only while a tab is open.
  const [pushActive, setPushActive] = useState(false);
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
  // #941: mentor's own "I can take a new mentee" preference. Kept as the raw
  // tri-state from the API (true/false/null = never set) — null is never
  // silently coerced to true/false here; only the mentor flipping the switch
  // produces an explicit value. activeMenteeCount/availability are read-only,
  // server-derived (getMentorAvailability) — never recomputed client-side.
  const [acceptingMentees, setAcceptingMentees] = useState<boolean | null>(null);
  const [activeMenteeCount, setActiveMenteeCount] = useState(0);
  const [availability, setAvailability] = useState<{
    status: 'available' | 'at_capacity' | 'not_accepting';
    source: 'preference' | 'capacity';
    capacityKnown: boolean;
  } | null>(null);
  // Every role sets its own zone here (#1210) — before this only the mentee
  // profile form had a picker, so an admin or mentor whose zone TimezoneSync
  // guessed wrong (VPN, travelling laptop, shared machine) had no way to fix it,
  // and every meeting time we emailed them stayed on the wrong clock.
  const [timezone, setTimezone] = useState('');
  const [savingTz, setSavingTz] = useState(false);
  // Read after mount: `Intl…resolvedOptions()` is a browser answer, and reading
  // it during render would differ from the server's HTML.
  const [detectedTz, setDetectedTz] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setDetectedTz(browserTimeZone());
    setNow(new Date());
  }, []);
  const timezoneChoices = timeZoneOptions();

  useEffect(() => {
    fetch('/api/profile')
      .then((r) => r.json())
      .then(({ user }) => {
        if (!user) {
          setPrefsLoadFailed(true);
          return;
        }
        setEmail(user.email);
        setEmailNotifications(user.emailNotifications !== false);
        setNotifPrefs((user.notificationPrefs && typeof user.notificationPrefs === 'object') ? user.notificationPrefs : {});
        // resolveEmailGroupPrefs deliberately ignores emailNotifications: the
        // master switch is its own visible control, and folding it in here would
        // render every group as "off" for someone who killed e-mail entirely —
        // and then persist that as an explicit opt-out the first time they
        // touched any switch, losing choices they never made.
        setGroupPrefs(resolveEmailGroupPrefs({ notificationPrefs: user.notificationPrefs }));
        // Set only after both of the above: this is what unlocks the switches,
        // and it must never be true while `notifPrefs` is still the placeholder.
        setPrefsLoaded(true);
        // The language selector must reflect the EFFECTIVE locale, not just the
        // DB preference: getLocale() lets the `locale` cookie win, so a cookie of
        // `tr` with a `preferredLanguage` of `en`/null renders a Turkish UI while
        // the selector said "English" (#653). Prefer the cookie, and converge the
        // DB preference to it so the two never diverge again.
        const m = document.cookie.match(new RegExp('(?:^|; )' + LOCALE_COOKIE + '=([^;]*)'));
        const cookieLocale = m ? decodeURIComponent(m[1]) : null;
        const validCookie = cookieLocale && (locales as readonly string[]).includes(cookieLocale) ? cookieLocale : null;
        setLanguage(validCookie ?? user.preferredLanguage ?? 'en');
        if (validCookie && validCookie !== user.preferredLanguage) {
          fetch('/api/profile', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferredLanguage: validCookie }),
          }).catch(() => {});
        }
        setTheme(user.theme ?? 'system');
        setAccent(resolveAccent(user.accentColor));
        setRole(user.role ?? '');
        setTimezone(user.timezone ?? '');
        setSkills(Array.isArray(user.skills) ? user.skills.join(', ') : '');
        setCapacity(user.mentorCapacity != null ? String(user.mentorCapacity) : '');
        setAcceptingMentees(user.acceptingMentees ?? null);
        setActiveMenteeCount(typeof user.activeMenteeCount === 'number' ? user.activeMenteeCount : 0);
        setAvailability(user.availability ?? null);
        setMe({ id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl ?? null, createdAt: user.createdAt ?? null });
      })
      .catch(() => setPrefsLoadFailed(true));
    fetch('/api/account/2fa').then((r) => r.json()).then((d) => setTwoFaEnabled(!!d.enabled)).catch(() => {});
  }, []);

  useEffect(() => {
    const supported = canUseBrowserNotifications();
    setBrowserNotifSupported(supported);
    if (!supported) return;
    setBrowserNotifDenied(Notification.permission === 'denied');
    const on = browserNotificationsPrefOn() && Notification.permission === 'granted';
    setBrowserNotif(on);
    // Re-assert the push subscription for someone who already said yes (#1464):
    // a push endpoint is rotated by the browser, dropped when site data is
    // cleared, and never existed for anyone who opted in before push shipped.
    // Silent, and only ever for a user who has already granted permission.
    if (on && pushSupported()) void registerPushSubscription().then(setPushActive);
  }, []);

  // One switch covers both halves of "notify me" (#1464): the foreground
  // notification a poll fires while a tab is open (#675 Kademe 1) and the Web
  // Push subscription that delivers with the app closed (Kademe 2). Splitting
  // them into two toggles would ask the user to understand the difference between
  // a tab and a service worker, which is our problem, not theirs.
  //
  // `requestPermission()` stays inside this change handler on purpose: iOS
  // silently ignores the prompt unless it is inside a user gesture, so moving it
  // into an effect would break exactly the platform that needs push most (a
  // home-screen PWA is the only place iOS delivers it at all).
  const toggleBrowserNotif = async (next: boolean) => {
    if (!next) {
      setBrowserNotif(false);
      setBrowserNotificationsPref(false);
      if (pushSupported()) void unregisterPushSubscription();
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setBrowserNotif(true);
      setBrowserNotificationsPref(true);
      setBrowserNotifDenied(false);
      // Best effort by design: no VAPID keys on this deployment, or a browser
      // that cannot do push, leaves the foreground notifications working.
      const subscribed = await registerPushSubscription();
      setPushActive(subscribed);
    } else {
      setBrowserNotif(false);
      setBrowserNotificationsPref(false);
      setBrowserNotifDenied(perm === 'denied');
    }
  };

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
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
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
        body: JSON.stringify({
          skills: skillsArr,
          mentorCapacity: capacity ? Number(capacity) : null,
          acceptingMentees,
        }),
      });
      if (!res.ok) throw new Error();
      flash(t.account.updated);
    } catch {
      flash('Failed', true);
    } finally {
      setSavingExpertise(false);
    }
  };

  // Saved immediately on pick, like the language and theme selectors: there is
  // nothing to review before committing, and a zone left unsaved behind a button
  // is exactly the state that produces a wrong meeting time.
  const changeTimezone = async (next: string) => {
    const previous = timezone;
    setTimezone(next);
    setSavingTz(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: next }),
      });
      if (!res.ok) throw new Error();
      flash(t.account.timezoneSaved);
    } catch {
      setTimezone(previous);
      flash('Failed', true);
    } finally {
      setSavingTz(false);
    }
  };

  const togglePref = async (cat: string, next: boolean) => {
    const previousPrefs = notifPrefs;
    const previousGroups = groupPrefs;
    const updated = { ...notifPrefs, [cat]: next };
    setNotifPrefs(updated);
    // Re-resolve the twelve group answers from the new blob, exactly as the load
    // did. A legacy category is still the back-compat default for the e-mail
    // group it maps to, so unticking "Mentorship updates" here also turns the
    // Mentorship group above off — and a group switch that keeps showing the old
    // answer until the next reload is the page contradicting itself.
    setGroupPrefs(resolveEmailGroupPrefs({ notificationPrefs: updated }));
    setSavingPrefs(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationPrefs: updated }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setNotifPrefs(previousPrefs);
      setGroupPrefs(previousGroups);
      flash('Failed', true);
    } finally {
      setSavingPrefs(false);
    }
  };

  // Instant save, same optimistic-with-rollback shape as togglePref and with no
  // success toast, so flipping ten switches in a row does not fire ten toasts.
  //
  // The PUT sends the WHOLE merged blob on purpose: PUT /api/profile replaces the
  // notificationPrefs JSON column outright, it does not merge. Posting only the
  // `email:` keys would silently wipe every legacy in-app opt-out the user has.
  const toggleGroup = async (id: EmailGroupId, next: boolean) => {
    const previousPrefs = notifPrefs;
    const previousGroup = groupPrefs[id];
    const updated = { ...notifPrefs, [emailGroupPrefKey(id)]: next };
    setGroupPrefs((p) => ({ ...p, [id]: next }));
    setNotifPrefs(updated);
    setSavingPrefs(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationPrefs: updated }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setNotifPrefs(previousPrefs);
      setGroupPrefs((p) => ({ ...p, [id]: previousGroup }));
      flash(t.unsubscribe.saveFailed, true);
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
      // The password change revoked every session including this one (#868),
      // so say why and send the user back to sign-in rather than letting the
      // next request fail as a mystery logout.
      flash(t.account.passwordChangedSignOut);
      setTimeout(() => { void signOut({ callbackUrl: '/auth/signin' }); }, 2500);
      return;
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

  // "Member for 3 months" — the magnitude comes from durationSince, the noun
  // and surrounding phrase from the localized membership block.
  const membershipLabel = (() => {
    if (!me?.createdAt) return null;
    const { count, unit } = durationSince(me.createdAt);
    const noun = count === 1 ? t.membership[unit] : t.membership[`${unit}s` as 'days' | 'months' | 'years'];
    return t.membership.inSystemFor.replace('{d}', `${count} ${noun}`);
  })();

  // The switch's ON/OFF position when no explicit preference is stored yet
  // (acceptingMentees === null): reflect the server-derived availability as a
  // starting visual only — it is never written back until the mentor actually
  // touches the switch, which always sets an explicit true/false from then on.
  const visualAcceptingMentees = acceptingMentees === null
    ? availability?.status !== 'at_capacity'
    : acceptingMentees;

  const availabilityBadge = availability && (
    <Badge variant={availability.status === 'available' ? 'success' : availability.status === 'at_capacity' ? 'warning' : 'default'}>
      {availability.status === 'available'
        ? t.account.availabilityAvailable
        : availability.status === 'at_capacity'
          ? t.account.availabilityAtCapacity
          : t.account.availabilityNotAccepting}
    </Badge>
  );

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{t.account.title}</h1>
        <p className="text-gray-500 mt-1">{t.account.subtitle}</p>
        {membershipLabel && (
          <p className="text-xs text-gray-400 mt-1" data-testid="membership-duration">{membershipLabel}</p>
        )}
      </div>

      {msg && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">✓ {msg}</div>}
      {err && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{err}</div>}

      {me && (
        <Card className="mb-6 max-w-4xl">
          <CardHeader><CardTitle>{t.avatar.section}</CardTitle></CardHeader>
          <AvatarManager targetUserId={me.id} initialAvatarUrl={me.avatarUrl} name={me.fullName} />
        </Card>
      )}

      {impersonating && (
        <Card className="mb-6 max-w-4xl border-purple-200 dark:border-purple-800">
          <p className="text-sm text-purple-900 dark:text-purple-100" data-testid="impersonation-account-notice">
            {t.account.impersonationNotice}
          </p>
        </Card>
      )}

      {!impersonating && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
        <Card>
          <CardHeader><CardTitle>{t.account.emailSection}</CardTitle></CardHeader>
          <form method="post" onSubmit={submitEmail} className="space-y-4">
            <Input label={t.account.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Input id="email-current-password" label={t.account.currentPassword} type="password" autoComplete="current-password" hint={t.account.emailPwHint} value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} required />
            <Button type="submit" loading={savingEmail}>{t.account.updateEmail}</Button>
          </form>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.account.passwordSection}</CardTitle></CardHeader>
          <form method="post" onSubmit={submitPassword} className="space-y-4">
            <Input label={t.account.currentPassword} type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            <Input label={t.account.newPassword} type="password" hint={t.account.passwordHint} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            <Input label={t.account.confirmPassword} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            <Button type="submit" loading={savingPw}>{t.account.updatePassword}</Button>
          </form>
        </Card>
      </div>
      )}

      {role === 'MENTOR' && (
        <Card className="mt-6 max-w-4xl">
          <CardHeader><CardTitle>{t.account.expertiseSection}</CardTitle></CardHeader>
          <form onSubmit={saveExpertise} className="space-y-4 max-w-lg">
            <div>
              <Input label={t.account.expertise} hint={t.account.expertiseHint} value={skills} onChange={(e) => setSkills(e.target.value)} />
            </div>
            <Input label={t.account.capacity} type="number" min={0} hint={t.account.capacityHint} value={capacity} onChange={(e) => setCapacity(e.target.value)} />

            {availability && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300" data-testid="mentor-availability-summary">
                <span>
                  {availability.capacityKnown
                    ? t.account.activeMentees.replace('{count}', String(activeMenteeCount)).replace('{capacity}', capacity)
                    : t.account.capacityNotSet}
                </span>
                {availabilityBadge}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.account.acceptingMentees}</p>
                <p className="text-xs text-gray-400 mt-0.5">{t.account.acceptingMenteesHint}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={visualAcceptingMentees}
                aria-label={t.account.acceptingMentees}
                data-testid="accepting-mentees-toggle"
                onClick={() => setAcceptingMentees(!visualAcceptingMentees)}
                className="relative inline-block h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <span className={`absolute inset-0 rounded-full transition-colors ${visualAcceptingMentees ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'}`} />
                <span className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${visualAcceptingMentees ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>

            <Button type="submit" loading={savingExpertise}>{t.profileForm.save}</Button>
          </form>
        </Card>
      )}

      {!impersonating && (
      <Card className="mt-6 max-w-4xl" data-testid="two-factor-card">
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
      )}

      {!impersonating && (
      <Card className="mt-6 max-w-4xl" data-testid="sessions-card">
        <CardHeader><CardTitle>{t.account.sessionsSection}</CardTitle></CardHeader>
        <p className="text-sm text-gray-600 mb-4 max-w-lg">{t.account.sessionsHint}</p>
        <Button variant="outline" loading={signOutBusy} onClick={signOutAll}>{t.account.signOutAll}</Button>
      </Card>
      )}

      <Card className="mt-6 max-w-4xl" data-testid="meeting-notes-card">
        <CardHeader><CardTitle>{t.meetings.notesWindow.title}</CardTitle></CardHeader>
        {/* Per-device, like the composer's enter-to-send: which machine you take
            notes on is a property of the machine, not the account (#1058). */}
        <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={notesAutoOpen}
            data-testid="meeting-notes-auto-open"
            onChange={(e) => {
              setNotesAutoOpen(e.target.checked);
              setMeetingNotesAutoOpen(e.target.checked);
            }}
          />
          {t.account.notesAutoOpen}
        </label>
        <p className="text-xs text-gray-400 mt-1">{t.account.notesAutoOpenHint}</p>
      </Card>

      <GoogleCalendarCard />

      {/* `id` so the "wrong zone?" footer under every emailed meeting time can
          link straight here (/account#timezone) instead of dropping the reader
          at the top of a long settings page. */}
      <Card className="mt-6 max-w-4xl" id="timezone" data-testid="timezone-card">
        <CardHeader><CardTitle>{t.account.timezoneSection}</CardTitle></CardHeader>
        <p className="text-sm text-gray-600 mb-4 max-w-lg">{t.account.timezoneHint}</p>
        <div className="max-w-md">
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="account-timezone">
            {t.account.timezoneLabel}
          </label>
          <select
            id="account-timezone"
            data-testid="timezone-select"
            value={resolveTimeZone(timezone)}
            disabled={savingTz}
            onChange={(e) => changeTimezone(e.target.value)}
            className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {/* A zone the runtime doesn't list (an old alias, or a value seeded
                elsewhere) still has to appear, or picking nothing would silently
                rewrite it on the next save. */}
            {!timezoneChoices.some((o) => o.value === resolveTimeZone(timezone)) && (
              <option value={resolveTimeZone(timezone)}>{resolveTimeZone(timezone)}</option>
            )}
            {timezoneChoices.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {now && (
            <p className="text-xs text-gray-500 mt-2" data-testid="timezone-current">
              {t.account.timezoneCurrent.replace('{time}', formatInTimeZone(now, timezone, undefined, language))}
            </p>
          )}
          {/* The browser knows where the reader actually is; offer it rather than
              overwriting a deliberate choice (someone who works Istanbul hours
              from Berlin means the zone they picked). */}
          {detectedTz && detectedTz !== resolveTimeZone(timezone) && (
            <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="timezone-detected">
              <span className="text-xs text-gray-500">
                {t.account.timezoneDetected.replace('{zone}', detectedTz)}
              </span>
              <Button variant="outline" size="sm" disabled={savingTz} onClick={() => changeTimezone(detectedTz)}>
                {t.account.timezoneUseDetected}
              </Button>
            </div>
          )}
        </div>
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
        {/* The master switch does not silence everything, and saying so here is
            the honest reading: the account_security group ignores every
            preference, because a password reset the account holder cannot
            receive is a lockout rather than a choice. */}
        <p className="text-xs text-gray-400 mt-1">{t.emailGroups.account_security.desc}</p>

        {/* Per-group e-mail opt-out (#1444). Driven by EMAIL_GROUPS so a new
            group cannot ship without a switch here, exactly like the legacy
            list below is driven by NOTIFICATION_CATEGORIES. These switches are
            about E-MAIL only; the legacy list underneath is about the in-app
            notifications, and keeping the two visually separate is the whole
            point of the sub-headings. */}
        <section className="mt-4 pt-4 border-t border-gray-100" data-testid="email-groups-section">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.unsubscribe.sectionTitle}</h4>
          <p className="text-xs text-gray-400 mt-1">{t.unsubscribe.sectionHint}</p>
          {/* The group switches stay interactive while the master switch is off —
              they mean something independent of it, and a user turning e-mail
              back on should find the choices they made in the meantime intact. */}
          {!emailNotifications && (
            <p className="text-xs text-gray-500 mt-2" data-testid="email-groups-master-off">
              {t.unsubscribe.masterOffNote}
            </p>
          )}
          {prefsLoadFailed && (
            <p className="text-xs text-red-600 mt-2" role="status" data-testid="prefs-load-failed-groups">
              {t.account.prefsLoadFailed}
            </p>
          )}
          <div className="mt-3 space-y-2 pl-6">
            {EMAIL_GROUPS.filter((g) => !g.essential).map((g) => (
              <div key={g.id}>
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    data-testid={`email-group-toggle-${g.id}`}
                    checked={groupPrefs[g.id] !== false}
                    disabled={savingPrefs || !prefsLoaded}
                    onChange={(e) => toggleGroup(g.id, e.target.checked)}
                  />
                  {t.emailGroups[g.id].name}
                </label>
                {/* The description is a SIBLING of the <label>, never a child.
                    e2e/notif-prefs.spec.ts finds the legacy switches with
                    locator('label', { hasText: 'Mentorship updates' }), and
                    Playwright's hasText is a case-insensitive SUBSTRING match:
                    any description swallowed into a label becomes a second
                    match and the spec dies on strict mode. */}
                <p className="text-xs text-gray-400 ml-6">{t.emailGroups[g.id].desc}</p>
              </div>
            ))}
          </div>

          {/* Essential groups get a row with no <input> at all rather than a
              disabled checkbox: a switch you cannot move is an invitation to
              try, and there is nothing here to toggle. */}
          <div className="mt-4">
            <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.unsubscribe.essentialHeading}</h5>
            <p className="text-xs text-gray-400 mt-1">{t.unsubscribe.essentialHint}</p>
            <div className="mt-2 space-y-1.5 pl-6">
              {EMAIL_GROUPS.filter((g) => g.essential).map((g) => (
                <div
                  key={g.id}
                  className="flex flex-wrap items-center gap-2 text-sm text-gray-600"
                  data-testid={`email-group-essential-${g.id}`}
                >
                  <span>{t.emailGroups[g.id].name}</span>
                  <Badge variant="default">{t.unsubscribe.alwaysSent}</Badge>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="mt-4 pt-4 border-t border-gray-100 space-y-1.5">
          {/* Driven by NOTIFICATION_CATEGORIES (#668) so a new category can't
              ship without an opt-out toggle here. Category switches gate BOTH
              e-mail and in-app notifications (#886), so they stay interactive
              even when the e-mail master switch above is off. The labels are
              asserted verbatim by e2e/notif-prefs.spec.ts — do not reword them,
              and do not render this list twice. */}
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.unsubscribe.legacyHeading}</h4>
          {/* ONE sentence about what these eleven switches do, because they do
              two things: they gate the in-app notifications, and they are still
              the back-compat default for the e-mail group each maps to — which
              is what the group switch above overrides. This used to be two
              paragraphs that contradicted each other ("in-app only", then "e-mail
              and in-app alike"), and the reassuring one was the false one: a user
              who unticked a category expecting their inbox untouched lost mail. */}
          <p className="text-xs text-gray-400">{t.unsubscribe.legacyHint}</p>
          {prefsLoadFailed && (
            <p className="text-xs text-red-600" role="status" data-testid="prefs-load-failed-legacy">
              {t.account.prefsLoadFailed}
            </p>
          )}
          {/* `prefsLoaded` guards this list for the same reason it guards the
              group switches above: it writes the identical blob, and a click
              before GET /api/profile answers would PUT one key over the top of
              everything the user actually had. */}
          <div className="pl-6 space-y-1.5">
            {NOTIFICATION_CATEGORIES.map((cat) => (
              <label key={cat} className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={notifPrefs[cat] !== false}
                  disabled={savingPrefs || !prefsLoaded}
                  onChange={(e) => togglePref(cat, e.target.checked)}
                />
                {(t.account.notifCategories as Record<string, string>)[cat]}
              </label>
            ))}
          </div>
        </div>

        {browserNotifSupported && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <label className="flex items-center gap-3 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={browserNotif}
                disabled={browserNotifDenied}
                onChange={(e) => toggleBrowserNotif(e.target.checked)}
                data-testid="browser-notif-toggle"
              />
              {t.account.browserNotifications}
            </label>
            <p className="text-xs text-gray-400 mt-1" data-testid="browser-notif-hint">
              {browserNotifDenied
                ? t.account.browserNotificationsDenied
                : pushActive
                  ? t.account.pushNotificationsActive
                  : t.account.browserNotificationsHint}
            </p>
          </div>
        )}

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

      {!impersonating && (
      <Card className="mt-6 max-w-4xl border-red-200" data-testid="delete-account-card">
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
      )}
    </div>
  );
}
