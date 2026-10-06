import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState, useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { apiGet, SessionLostError } from '../../lib/api';
import { deviceLocale, strings } from '../../lib/i18n';
import { previewLine, type Inbox, type InboxThread } from '../../lib/messages';
import { useSession } from '../../lib/session';
import { useAppTheme, type Palette } from '../../lib/theme';
import { useUnread } from '../../lib/unread';

// Native inbox (#2775): GET /api/conversations — the same read as the web's
// /messages page (src/lib/inbox.ts), so the rows, names and unread counts match.
export default function MessagesTab() {
  const { c } = useAppTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { origin, product, user, signOut } = useSession();
  const { refresh: refreshBadges } = useUnread();
  const t = strings();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!origin) return;
    try {
      setInbox(await apiGet<Inbox>(origin, '/api/conversations'));
      setFailed(false);
      refreshBadges();
    } catch (e) {
      if (e instanceof SessionLostError) void signOut();
      else setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, [origin, signOut, refreshBadges]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!inbox && !failed) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const tint = product?.color ?? '#1D4ED8';
  const fmt = new Intl.DateTimeFormat(deviceLocale(), { dateStyle: 'short', timeStyle: 'short' });
  const me = user?.id ?? '';

  const openThread = (th: InboxThread) =>
    router.push({ pathname: '/thread/[id]', params: { id: th.conversationId, name: th.name } });

  return (
    <FlatList
      data={inbox?.threads ?? []}
      keyExtractor={(th) => th.conversationId}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
        />
      }
      ListHeaderComponent={
        // The support line to the admins (#593), pinned like on the web; its
        // thread stays a web page for now.
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/web', params: { path: '/messages/support', title: t.support } })}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={[styles.avatar, { backgroundColor: '#fef3c7' }]}>
            <Ionicons name="help-buoy" size={18} color="#d97706" />
          </View>
          <Text style={[styles.name, { flex: 1 }]}>{t.support}</Text>
          {(inbox?.supportUnread ?? 0) > 0 && <Badge count={inbox!.supportUnread} />}
        </Pressable>
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.muted}>{failed ? t.offline : t.noThreads}</Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => openThread(item)}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={[styles.avatar, { backgroundColor: `${tint}22` }]}>
            <Ionicons name={item.type === 'GROUP' ? 'people' : 'person'} size={18} color={tint} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={styles.line}>
              <Text style={[styles.name, item.unread > 0 && styles.bold]} numberOfLines={1}>
                {item.name}
              </Text>
              {item.last && <Text style={styles.time}>{fmt.format(new Date(item.last.createdAt))}</Text>}
            </View>
            <Text style={[styles.preview, item.unread > 0 && styles.previewUnread]} numberOfLines={1}>
              {previewLine(item, me, t.you, t.emptyThread)}
            </Text>
          </View>
          {item.unread > 0 && <Badge count={item.unread} />}
        </Pressable>
      )}
    />
  );
}

function Badge({ count }: { count: number }) {
  return (
    <View style={badgeStyles.badge}>
      <Text style={badgeStyles.badgeText}>{count > 9 ? '9+' : count}</Text>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  muted: { color: c.muted, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  name: { fontSize: 15, color: c.text, fontWeight: '500', flexShrink: 1 },
  bold: { fontWeight: '700' },
  time: { fontSize: 12, color: c.faint },
  preview: { fontSize: 13, color: c.faint, marginTop: 2 },
  previewUnread: { color: c.text },
});

// Fixed colours on purpose: the unread pill reads the same in light and dark.
const badgeStyles = StyleSheet.create({
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
