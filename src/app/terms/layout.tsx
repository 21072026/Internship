import { I18nScope } from '@/i18n/scope';

// Ships this directory's dictionary namespaces to the browser (#2987): the root
// layout carries only the shell, see src/i18n/scope.tsx and
// scripts/i18n-scopes.mjs.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <I18nScope scope="terms">{children}</I18nScope>;
}
