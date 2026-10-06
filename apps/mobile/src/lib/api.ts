import { deviceLocale } from './i18n';

// JSON calls to the signed-in product's /api/* (#2775). Same cookie jar as the
// sign-in, so these are the web app's own endpoints, behind its own auth — the
// app adds no API surface of its own.

export class SessionLostError extends Error {
  constructor() {
    super('session lost');
  }
}

async function call<T>(origin: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      // The server renders text in the account's chosen language first and
      // falls back to this (src/i18n/server.ts getLocale).
      'Accept-Language': deviceLocale(),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new SessionLostError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function apiGet<T>(origin: string, path: string): Promise<T> {
  return call<T>(origin, path);
}

export function apiPost<T>(origin: string, path: string, body: unknown): Promise<T> {
  return call<T>(origin, path, { method: 'POST', body: JSON.stringify(body) });
}
