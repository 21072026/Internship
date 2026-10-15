import { useState, useMemo } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { signInWithPassword } from '../lib/authClient';
import { strings } from '../lib/i18n';
import { useSession } from '../lib/session';
import { useAppTheme, type Palette } from '../lib/theme';

// Native sign-in (#2775). It drives the server's own NextAuth flow — the same
// rate limits, lockouts, 2FA, recovery codes and world check as the web form
// (src/lib/auth.ts) — so there is nothing here to keep in sync but the wording.
export default function SignInScreen() {
  const { c } = useAppTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { product, origin, signedIn, clearProduct, canSwitchProduct } = useSession();
  const t = strings();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!product || !origin) return null;

  const submit = async () => {
    setBusy(true);
    setError('');
    const result = await signInWithPassword(origin, {
      email: email.trim(),
      password,
      totp: needsCode ? totp.trim() : undefined,
      remember,
    });
    setBusy(false);
    if (result.ok) {
      signedIn(result.user);
      return;
    }
    if (result.error === 'TWO_FACTOR_REQUIRED' || result.error === 'BAD_CODE') setNeedsCode(true);
    setError(t.errors[result.error].replace('{product}', product.name));
  };

  return (
    <SafeAreaView style={styles.root}>
      {/* keyboard-controller's: React Native's own does nothing on edge-to-edge Android. */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.brand, { color: product.color }]} accessibilityRole="header">
            {product.name}
          </Text>

          <TextInput
            style={styles.input}
            placeholder={t.email}
            placeholderTextColor={c.faint}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            value={email}
            onChangeText={setEmail}
            editable={!busy}
          />
          <TextInput
            style={styles.input}
            placeholder={t.password}
            placeholderTextColor={c.faint}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            value={password}
            onChangeText={setPassword}
            editable={!busy}
          />
          {needsCode && (
            <TextInput
              style={styles.input}
              placeholder={t.totp}
              placeholderTextColor={c.faint}
              autoCapitalize="none"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              value={totp}
              onChangeText={setTotp}
              editable={!busy}
              autoFocus
            />
          )}

          <View style={styles.row}>
            <Switch value={remember} onValueChange={setRemember} />
            <Text style={styles.rowText}>{t.remember}</Text>
          </View>

          {!!error && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}

          <Pressable
            accessibilityRole="button"
            disabled={busy || !email || !password}
            onPress={submit}
            style={[styles.button, { backgroundColor: product.color, opacity: busy || !email || !password ? 0.6 : 1 }]}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{t.signIn}</Text>}
          </Pressable>

          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(`${origin}/auth/forgot`)}>
            <Text style={styles.link}>{t.forgot}</Text>
          </Pressable>
          {canSwitchProduct && (
            <Pressable accessibilityRole="button" onPress={() => void clearProduct()}>
              <Text style={styles.link}>{t.otherProduct}</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  body: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 14 },
  brand: { fontSize: 28, fontWeight: '800', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: c.inputBorder, borderRadius: 10, padding: 14, fontSize: 16, color: c.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowText: { flex: 1, color: c.text },
  error: { color: c.danger },
  button: { borderRadius: 10, padding: 15, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  link: { color: '#1D4ED8', textAlign: 'center', padding: 6 },
});
