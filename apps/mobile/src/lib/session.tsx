import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getSession, resumeSession, signOut as signOutRemote } from './authClient';
import type { SessionUser } from './authProtocol';
import { originFor, productById, type AppEnv, type Product } from './products';

// App-wide state (#2775): the chosen product and the signed-in user. The
// session itself lives in the OS cookie jar; this only remembers WHICH product
// it belongs to, so the next launch asks the right host.

const PRODUCT_KEY = 'interncrm.product';

const APP_ENV: AppEnv = Constants.expoConfig?.extra?.appEnv === 'preview' ? 'preview' : 'production';

type Status = 'loading' | 'no-product' | 'signed-out' | 'signed-in';

interface SessionState {
  status: Status;
  product: Product | null;
  origin: string | null;
  user: SessionUser | null;
  chooseProduct: (id: Product['id']) => Promise<void>;
  clearProduct: () => Promise<void>;
  signedIn: (user: SessionUser) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [product, setProduct] = useState<Product | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const origin = product ? originFor(product, APP_ENV) : null;

  // Launch: the stored product, then a live session, then a remembered device.
  useEffect(() => {
    (async () => {
      const stored = productById(await AsyncStorage.getItem(PRODUCT_KEY).catch(() => null));
      if (!stored) {
        setStatus('no-product');
        return;
      }
      setProduct(stored);
      const o = originFor(stored, APP_ENV);
      const current = (await getSession(o)) ?? (await resumeSession(o));
      setUser(current);
      setStatus(current ? 'signed-in' : 'signed-out');
    })();
  }, []);

  // Picking a product reuses whatever that product's host already has: the
  // cookie jar holds each host's session separately, so switching away and back
  // must not cost a sign-in — a live session, else the remembered device.
  const chooseProduct = useCallback(async (id: Product['id']) => {
    const p = productById(id);
    if (!p) return;
    await AsyncStorage.setItem(PRODUCT_KEY, p.id).catch(() => {});
    setStatus('loading');
    setProduct(p);
    const o = originFor(p, APP_ENV);
    const current = (await getSession(o)) ?? (await resumeSession(o));
    setUser(current);
    setStatus(current ? 'signed-in' : 'signed-out');
  }, []);

  // Back to the product picker. Deliberately NOT a sign-out: the session of the
  // product being left stays in the jar for when the person switches back.
  const clearProduct = useCallback(async () => {
    await AsyncStorage.removeItem(PRODUCT_KEY).catch(() => {});
    setProduct(null);
    setUser(null);
    setStatus('no-product');
  }, []);

  const signedIn = useCallback((u: SessionUser) => {
    setUser(u);
    setStatus('signed-in');
  }, []);

  const signOut = useCallback(async () => {
    if (origin) await signOutRemote(origin);
    setUser(null);
    setStatus('signed-out');
  }, [origin]);

  const value = useMemo(
    () => ({ status, product, origin, user, chooseProduct, clearProduct, signedIn, signOut }),
    [status, product, origin, user, chooseProduct, clearProduct, signedIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
