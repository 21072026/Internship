import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiGet, apiPost, SessionLostError } from '../../lib/api';
import { deviceLocale, strings } from '../../lib/i18n';
import {
  MAX_BODY,
  sendableBody,
  senderName,
  THREAD_POLL_MS,
  threadChanged,
  threadTitle,
  type Thread,
  type ThreadMessage,
} from '../../lib/messages';
import { useSession } from '../../lib/session';
import { useAppTheme, type Palette } from '../../lib/theme';
import { useUnread } from '../../lib/unread';

// Native thread (#2775). Reads GET /api/messages?conversationId= — which is
// also what marks the thread read, exactly as opening it on the web does — and
// sends with a JSON POST to /api/messages. While the screen is open and the app
// is in the foreground it asks again every few seconds; native push replaces
// that in a later slice.
export default function ThreadScreen() {
  const { c } = useAppTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { origin, user, product, signOut } = useSession();
  const { refresh: refreshBadges } = useUnread();
  const insets = useSafeAreaInsets();
  const t = strings();
  const [thread, setThread] = useState<Thread | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const messagesRef = useRef<ThreadMessage[]>([]);

  // The keyboard pushes the composer up (#2775). The app draws edge to edge, so
  // Android no longer shrinks the window for the keyboard and React Native's own
  // KeyboardAvoidingView does nothing there; this spacer follows the keyboard's
  // real height, frame by frame, on both platforms. The composer already pads
  // itself for the home indicator, which the keyboard covers.
  const keyboard = useReanimatedKeyboardAnimation();
  const keyboardSpacer = useAnimatedStyle(() => ({
    height: Math.max(0, -keyboard.height.value - insets.bottom),
  }));

  const load = useCallback(async () => {
    if (!origin || !id) return;
    try {
      const next = await apiGet<Thread>(origin, `/api/messages?conversationId=${encodeURIComponent(id)}`);
      if (!messagesRef.current.length || threadChanged(messagesRef.current, next.messages)) {
        messagesRef.current = next.messages;
        setThread(next);
        refreshBadges();
      }
      setFailed(false);
    } catch (e) {
      if (e instanceof SessionLostError) void signOut();
      else setFailed(true);
    }
  }, [origin, id, signOut, refreshBadges]);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, THREAD_POLL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void load();
        if (!timer) timer = setInterval(load, THREAD_POLL_MS);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    return () => {
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [load]);

  const send = async () => {
    const body = sendableBody(draft);
    if (!origin || !id || !body || sending) return;
    setSending(true);
    setSendError(false);
    try {
      await apiPost(origin, '/api/messages', { conversationId: id, body });
      setDraft('');
      await load();
    } catch (e) {
      if (e instanceof SessionLostError) void signOut();
      else setSendError(true);
    } finally {
      setSending(false);
    }
  };

  const tint = product?.color ?? '#1D4ED8';
  const fmt = new Intl.DateTimeFormat(deviceLocale(), { dateStyle: 'short', timeStyle: 'short' });
  const me = user?.id ?? '';

  // Opened from the inbox, the row hands its name over; opened from a link in a
  // web page or a notification, the thread names itself once it has loaded.
  const title = typeof name === 'string' && name ? name : thread ? threadTitle(thread, me) : '';
  const header = <Stack.Screen options={{ headerShown: true, title }} />;

  if (!thread) {
    return (
      <View style={styles.center}>
        {header}
        {failed ? <Text style={styles.muted}>{t.offline}</Text> : <ActivityIndicator />}
      </View>
    );
  }

  // Newest at the bottom: an inverted list keeps the latest message in view.
  const items = [...thread.messages].reverse();

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {header}
      <FlatList
        inverted
        data={items}
        keyExtractor={(m) => m.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={
          <View style={[styles.center, { transform: [{ scaleY: -1 }] }]}>
            <Text style={styles.muted}>{t.emptyThread}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const mine = item.senderId === me;
          const sender = mine ? null : senderName(thread, item.senderId);
          return (
            <View style={[styles.bubble, mine ? [styles.mine, { backgroundColor: tint }] : styles.theirs]}>
              {!!sender && <Text style={styles.sender}>{sender}</Text>}
              {item.deleted ? (
                <Text style={[styles.deleted, mine && styles.mineText]}>{t.deletedMessage}</Text>
              ) : (
                <>
                  {!!item.body && <Text style={[styles.body, mine && styles.mineText]}>{item.body}</Text>}
                  {item.attachments.map((a) => (
                    <Pressable
                      key={a.id}
                      accessibilityRole="link"
                      onPress={() =>
                        router.push({
                          pathname: '/web',
                          params: { path: `/api/messages/attachments/${a.id}`, title: a.filename },
                        })
                      }
                      style={styles.attachment}
                    >
                      <Ionicons name="attach" size={16} color={mine ? '#fff' : '#374151'} />
                      <Text style={[styles.attachmentText, mine && styles.mineText]} numberOfLines={1}>
                        {a.filename}
                      </Text>
                    </Pressable>
                  ))}
                </>
              )}
              <Text style={[styles.time, mine && styles.mineTime]}>
                {fmt.format(new Date(item.createdAt))}
                {item.editedAt && !item.deleted ? ` · ${t.edited}` : ''}
              </Text>
            </View>
          );
        }}
      />

      {thread.canPost === false ? (
        <Text style={[styles.readOnly, { paddingBottom: insets.bottom + 12 }]}>{t.readOnlyThread}</Text>
      ) : (
        <View style={[styles.composer, { paddingBottom: insets.bottom + 8 }]}>
          {sendError && <Text style={styles.error}>{t.sendFailed}</Text>}
          <View style={styles.composerRow}>
            <TextInput
              style={styles.input}
              placeholder={t.typeMessage}
              placeholderTextColor={c.faint}
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={MAX_BODY}
              editable={!sending}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.send}
              onPress={send}
              disabled={sending || !sendableBody(draft)}
              style={[styles.sendButton, { backgroundColor: tint, opacity: sending || !sendableBody(draft) ? 0.5 : 1 }]}
            >
              {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={18} color="#fff" />}
            </Pressable>
          </View>
        </View>
      )}
      <Animated.View style={keyboardSpacer} />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  muted: { color: c.muted, textAlign: 'center' },
  bubble: { maxWidth: '82%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: c.subtle, borderBottomLeftRadius: 4 },
  sender: { fontSize: 12, fontWeight: '700', color: c.muted },
  body: { fontSize: 15, color: c.text },
  mineText: { color: '#fff' },
  deleted: { fontSize: 14, fontStyle: 'italic', color: c.muted },
  attachment: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  attachmentText: { fontSize: 14, color: c.text, textDecorationLine: 'underline', flexShrink: 1 },
  time: { fontSize: 11, color: c.faint, alignSelf: 'flex-end' },
  mineTime: { color: 'rgba(255,255,255,0.8)' },
  readOnly: { textAlign: 'center', color: c.muted, paddingTop: 12, paddingHorizontal: 16 },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    paddingHorizontal: 10,
    paddingTop: 8,
    backgroundColor: c.bg,
    gap: 4,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
    color: c.text,
  },
  sendButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  error: { color: c.danger, fontSize: 13 },
});
