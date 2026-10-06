import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '../lib/session';

function RootStack() {
  const { status } = useSession();

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  // Exactly one group is reachable at a time; when the status changes, Expo
  // Router moves to the first screen of the group that became available.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'no-product'}>
        <Stack.Screen name="product" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'signed-out'}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'signed-in'}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="web" options={{ headerShown: true, title: '' }} />
        <Stack.Screen name="thread/[id]" options={{ headerShown: true, title: '' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <RootStack />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
