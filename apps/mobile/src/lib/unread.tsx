import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import { apiGet } from './api';
import { useSession } from './session';

// The unread counts behind the Messages and Notifications tab badges (#2775).
// One request: GET /api/messages/unread answers with both, counted by the same
// src/lib/unreadCounts.ts the web header and its live stream use. Read when the
// app comes to the foreground and once a minute while it is open; screens call
// refresh() after they mark something read. Native push (a later slice) will
// make the minute poll unnecessary. A push that arrives while the app is open
// refreshes them at once (#2775).

const POLL_MS = 60_000;

interface UnreadState {
  messages: number;
  notifications: number;
  refresh: () => void;
}

const Ctx = createContext<UnreadState>({ messages: 0, notifications: 0, refresh: () => {} });

export function UnreadProvider({ children }: { children: ReactNode }) {
  const { origin } = useSession();
  const [counts, setCounts] = useState({ messages: 0, notifications: 0 });

  const refresh = useCallback(() => {
    if (!origin) return;
    apiGet<{ messages: number; notifications: number }>(origin, '/api/messages/unread')
      .then((c) => setCounts({ messages: c.messages, notifications: c.notifications }))
      .catch(() => {});
  }, [origin]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    const pushed = Notifications.addNotificationReceivedListener(() => refresh());
    return () => {
      clearInterval(timer);
      sub.remove();
      pushed.remove();
    };
  }, [refresh]);

  const value = useMemo(() => ({ ...counts, refresh }), [counts, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUnread(): UnreadState {
  return useContext(Ctx);
}
