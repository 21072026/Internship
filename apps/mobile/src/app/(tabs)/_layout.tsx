import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { strings } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { UnreadProvider, useUnread } from '../../lib/unread';

// React Native 0.88 types the colour a tab bar hands its icon as ColorValue,
// which admits null and numbers; Ionicons takes string | OpaqueColorValue. The
// tab bar only ever passes its theme's colours or our tint — strings.
const tabIcon =
  (name: keyof typeof Ionicons.glyphMap) =>
  ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color as string} size={size} />;

function TabsInner() {
  const { messages, notifications } = useUnread();
  const badge = (n: number) => (n > 0 ? (n > 99 ? '99+' : n) : undefined);
  const { product } = useSession();
  const t = strings();
  const tint = product?.color ?? '#1D4ED8';

  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: tint }}>
      <Tabs.Screen
        name="index"
        options={{ title: t.tabs.home, tabBarIcon: tabIcon('home') }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: t.tabs.messages,
          tabBarBadge: badge(messages),
          tabBarIcon: tabIcon('chatbubbles'),
        }}
      />
      <Tabs.Screen
        name="todos"
        options={{
          title: t.tabs.todos,
          tabBarIcon: tabIcon('checkbox'),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t.notifications,
          tabBarBadge: badge(notifications),
          tabBarIcon: tabIcon('notifications'),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: t.tabs.more, tabBarIcon: tabIcon('menu') }}
      />
    </Tabs>
  );
}

export default function TabsLayout() {
  return (
    <UnreadProvider>
      <TabsInner />
    </UnreadProvider>
  );
}
