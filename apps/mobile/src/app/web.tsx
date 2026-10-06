import { Stack, useLocalSearchParams } from 'expo-router';
import { WebScreen } from '../components/WebScreen';

// A pushed web page of the signed-in product: /web?path=/notifications.
// Only a path is accepted, never a URL — the origin is always the product's.
export default function WebRoute() {
  const { path, title } = useLocalSearchParams<{ path?: string; title?: string }>();
  const safePath = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : '/';
  return (
    <>
      <Stack.Screen options={{ title: typeof title === 'string' ? title : '' }} />
      <WebScreen path={safePath} />
    </>
  );
}
