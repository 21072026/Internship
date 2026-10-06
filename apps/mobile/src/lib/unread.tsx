import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { apiGet } from './api';
import type { NotificationPage } from './notifications';
import { useSession } from './session';

// The unread count behind the Notifications tab badge (#2775). Read when the
// app comes to the foreground and once a minute while it is open; the tab
// refreshes it after marking rows read. Native push (a later slice) will make
// the minute poll unnecessary.

const POLL_MS = 60_000;

interface UnreadState {
  count: number;
  refresh: () => void;
}

const Ctx = createContext<UnreadState>({ count: 0, refresh: () => {} });

export function UnreadProvider({ children }: { children: ReactNode }) {
  const { origin } = useSession();
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    if (!origin) return;
    // One row is enough: the count comes back on every page.
    apiGet<NotificationPage>(origin, '/api/notifications?read=unread&pageSize=1')
      .then((p) => setCount(p.unread))
      .catch(() => {});
  }, [origin]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [refresh]);

  const value = useMemo(() => ({ count, refresh }), [count, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUnread(): UnreadState {
  return useContext(Ctx);
}
