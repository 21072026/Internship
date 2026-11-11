import { I18nScope } from '@/i18n/scope';

// Ships this section's dictionary namespaces to the browser (#3599): the admin
// layout carries only its chrome, see src/i18n/scope.tsx and
// scripts/i18n-scopes.mjs.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <I18nScope scope="admin/safeguarding">{children}</I18nScope>;
}
