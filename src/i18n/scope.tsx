import { DictionaryScope } from './client';
import { toClientDictionary, type ClientDictionary } from './dictionaries';
import { SCOPE_NAMESPACES, SHELL_NAMESPACES, type I18nScopeId } from './scopes.generated';
import { getLocale, requestDictionary } from './server';

/**
 * The browser gets the dictionary in parts (#2987): the root layout ships the
 * namespaces every page needs (`shellDictionary()`), and each top-level
 * directory of src/app mounts `<I18nScope scope="…">` in its layout to add the
 * ones its own pages and components use. Which namespaces those are is computed
 * by scripts/i18n-scopes.mjs into scopes.generated.ts; `npm run
 * check:i18n-scopes` fails when a scope is not mounted or the manifest is stale.
 *
 * Server components are unaffected: getServerDictionary() still returns the
 * whole dictionary. Only what crosses into the browser is trimmed.
 */
function pick(dict: ClientDictionary, names: readonly string[]): Partial<ClientDictionary> {
  const all = dict as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const n of names) if (n in all) out[n] = all[n];
  return out as Partial<ClientDictionary>;
}

/** The root layout's part: SHELL_NAMESPACES of the request's dictionary. */
export function shellDictionary(dict: Parameters<typeof toClientDictionary>[0]): Partial<ClientDictionary> {
  return pick(toClientDictionary(dict), SHELL_NAMESPACES);
}

export async function I18nScope({ scope, children }: { scope: I18nScopeId; children: React.ReactNode }) {
  const names = SCOPE_NAMESPACES[scope];
  if (names.length === 0) return <>{children}</>;
  const locale = await getLocale();
  const dict = pick(toClientDictionary((await requestDictionary(locale)).t), names);
  return <DictionaryScope dict={dict}>{children}</DictionaryScope>;
}
