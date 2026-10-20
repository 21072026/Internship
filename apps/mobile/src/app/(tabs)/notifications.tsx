import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState, useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { apiGet, apiPost, SessionLostError } from '../../lib/api';
import { deviceLocale, strings } from '../../lib/i18n';
import {
  hasMore,
  mergePage,
  notificationsPath,
  notificationTarget,
  type NotificationItem,
  type NotificationPage,
} from '../../lib/notifications';
import { nativeRouteFor } from '../../lib/nativeRoutes';
import { openNative } from '../../lib/openNative';
import { useSession } from '../../lib/session';
import { useAppTheme, type Palette } from '../../lib/theme';
import { useUnread } from '../../lib/unread';

// Native notification list (#2775). The text is rendered by the server in the
// reader's locale (`display`); a tap marks the row read and opens its page —
// natively when there is a native screen for it (lib/nativeRoutes.ts).
export default function NotificationsTab() {
  const { c } = useAppTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { origin, product, signOut } = useSession();
  const { refresh: refreshBadge } = useUnread();
  const t = strings();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (nextPage: number, replace: boolean) => {
      if (!origin) return;
      try {
        const data = await apiGet<NotificationPage>(origin, notificationsPath(nextPage));
        setItems((cur) => mergePage(cur, data.items, replace));
        setPage(data.page);
        setMore(hasMore(data));
        setFailed(false);
      } catch (e) {
        if (e instanceof SessionLostError) void signOut();
        else setFailed(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [origin, signOut],
  );

  // Fresh on every visit to the tab: a notification is about "now".
  useFocusEffect(
    useCallback(() => {
      void load(1, true);
    }, [load]),
  );

  const open = async (n: NotificationItem) => {
    if (!origin) return;
    if (!n.read) {
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      apiPost(origin, '/api/notifications', { id: n.id }).then(refreshBadge, () => {});
    }
    const target = notificationTarget(n.link);
    if (!target) return;
    // A message notification opens the native thread, not the web page.
    const route = nativeRouteFor(target);
    if (route) openNative(route);
    else router.push({ pathname: '/web', params: { path: target, title: t.notifications } });
  };

  const markAll = async () => {
    if (!origin) return;
    setItems((cur) => cur.map((x) => ({ ...x, read: true })));
    await apiPost(origin, '/api/notifications', {}).catch(() => {});
    refreshBadge();
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const tint = product?.color ?? '#1D4ED8';
  const fmt = new Intl.DateTimeFormat(deviceLocale(), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <FlatList
      data={items}
      keyExtractor={(n) => n.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load(1, true);
          }}
        />
      }
      onEndReached={() => {
        if (more) void load(page + 1, false);
      }}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        items.some((n) => !n.read) ? (
          <Pressable accessibilityRole="button" onPress={markAll} style={styles.markAll}>
            <Text style={[styles.markAllText, { color: tint }]}>{t.markAllRead}</Text>
          </Pressable>
        ) : undefined
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.muted}>{failed ? t.offline : t.noNotifications}</Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => void open(item)}
          style={({ pressed }) => [styles.row, !item.read && styles.unread, { opacity: pressed ? 0.6 : 1 }]}
        >
          {!item.read && <View style={[styles.dot, { backgroundColor: tint }]} />}
          <View style={{ flex: 1 }}>
            <Text style={[styles.text, !item.read && styles.bold]}>{item.display}</Text>
            <Text style={styles.time}>{fmt.format(new Date(item.createdAt))}</Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  muted: { color: c.muted, textAlign: 'center' },
  markAll: { alignSelf: 'flex-end', paddingHorizontal: 16, paddingVertical: 10 },
  markAllText: { fontWeight: '600' },
  row: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  unread: { backgroundColor: c.highlight },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  text: { color: c.text, fontSize: 15 },
  bold: { fontWeight: '600' },
  time: { color: c.muted, fontSize: 12, marginTop: 4 },
});
