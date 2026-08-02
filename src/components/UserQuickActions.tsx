'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, useSession } from 'next-auth/react';
import { MessageSquare, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { roleHome } from '@/lib/roleHome';

// Shortcuts on a person's profile (#51): message them, and — for an admin — view
// the app as them. Both actions existed somewhere else (the messages inbox, the
// user list), which meant leaving the profile you were reading to go find them.
export function UserQuickActions({
  userId,
  role,
  className = '',
}: {
  userId: string;
  role?: string | null;
  className?: string;
}) {
  const t = useT();
  const router = useRouter();
  const { data: session } = useSession();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const isAdmin = session?.user?.role === 'ADMIN';
  const isSelf = session?.user?.id === userId;

  const message = async () => {
    setBusy('message');
    setError('');
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.conversation?.id) throw new Error(data.error || t.common.error);
      router.push(`/messages/c/${data.conversation.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy('');
    }
  };

  // Same flow as the user list: a grant from /api/admin/impersonate is exchanged
  // for a session through the 'impersonate' provider.
  const loginAs = async () => {
    const reason = window.prompt(t.usersAdmin.impersonateReason) ?? undefined;
    setBusy('impersonate');
    setError('');
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: userId, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t.usersAdmin.impersonateFailed);
      const signed = await signIn('impersonate', { grant: data.grant, redirect: false });
      if (!signed?.ok) throw new Error(t.usersAdmin.impersonateFailed);
      router.push(roleHome(role));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.usersAdmin.impersonateFailed);
      setBusy('');
    }
  };

  if (isSelf) return null;

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} data-testid="user-quick-actions">
      <Button type="button" size="sm" variant="outline" loading={busy === 'message'} onClick={message} data-testid="quick-message">
        <MessageSquare className="mr-1 h-4 w-4" /> {t.messages.sendMessage}
      </Button>
      {isAdmin && (
        <Button type="button" size="sm" variant="outline" loading={busy === 'impersonate'} onClick={loginAs} data-testid="quick-login-as">
          <LogIn className="mr-1 h-4 w-4" /> {t.usersAdmin.loginAs}
        </Button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
