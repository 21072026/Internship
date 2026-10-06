import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { strings } from '../../lib/i18n';
import { useSession } from '../../lib/session';

export default function TabsLayout() {
  const { product } = useSession();
  const t = strings();
  const tint = product?.color ?? '#1D4ED8';

  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: tint }}>
      <Tabs.Screen
        name="index"
        options={{ title: t.tabs.home, tabBarIcon: ({ color, size }) => <Ionicons name="home" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: t.tabs.messages,
          tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="todos"
        options={{
          title: t.tabs.todos,
          tabBarIcon: ({ color, size }) => <Ionicons name="checkbox" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: t.tabs.more, tabBarIcon: ({ color, size }) => <Ionicons name="menu" color={color} size={size} /> }}
      />
    </Tabs>
  );
}
