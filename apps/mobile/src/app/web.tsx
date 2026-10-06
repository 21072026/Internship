import { Stack, useLocalSearchParams } from 'expo-router';
import { WebScreen } from '../components/WebScreen';
import { useWebHeader } from '../lib/useWebHeader';

// A pushed web page of the signed-in product: /web?path=/notifications.
// Only a path is accepted, never a URL — the origin is always the product's.
// The header takes the page's own title and colours once it reports them.
export default function WebRoute() {
  const { path, title } = useLocalSearchParams<{ path?: string; title?: string }>();
  const safePath = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : '/';
  const fallback = typeof title === 'string' ? title : '';
  const onMeta = useWebHeader(fallback);
  return (
    <>
      <Stack.Screen options={{ title: fallback }} />
      <WebScreen path={safePath} onMeta={onMeta} replaceable />
    </>
  );
}
