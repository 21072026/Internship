'use client';

import { createContext, useContext } from 'react';
import type { Locale } from './config';
import type { ClientDictionary } from './dictionaries';

const LocaleContext = createContext<{ locale: Locale; t: ClientDictionary } | null>(null);

export function LocaleProvider({
  locale,
  dict,
  children,
}: {
  locale: Locale;
  dict: ClientDictionary;
  children: React.ReactNode;
}) {
  return <LocaleContext.Provider value={{ locale, t: dict }}>{children}</LocaleContext.Provider>;
}

function useLocaleContext() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useT/useLocale must be used within LocaleProvider');
  return ctx;
}

// Client-side translation hook — returns the active dictionary (client subset;
// server-only namespaces like `landing` are not shipped to the browser).
export function useT(): ClientDictionary {
  return useLocaleContext().t;
}

export function useLocale(): Locale {
  return useLocaleContext().locale;
}
