import { Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '../lib/session';
import { navigationTheme, useAppTheme } from '../lib/theme';

function RootStack() {
  const { status, product } = useSession();
  const { dark, c } = useAppTheme();

  return (
    // Headers, tab bar and screen backgrounds follow the phone's light/dark
    // setting and carry the product's colour as the accent.
    <ThemeProvider value={navigationTheme(dark, product?.color ?? '#1D4ED8')}>
      <StatusBar style="auto" />
      {status === 'loading' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
          <ActivityIndicator />
        </View>
      ) : (
        // Exactly one group is reachable at a time; when the status changes,
        // Expo Router moves to the first screen of the group that became available.
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
      )}
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      {/* Reports the keyboard's real height to the screens that follow it (thread/[id]). */}
      <KeyboardProvider>
        <SessionProvider>
          <RootStack />
        </SessionProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
