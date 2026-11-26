import { I18nScope } from '@/i18n/scope';

// Ships this section's dictionary namespaces to the browser (#3599, src/i18n/scope.tsx).
// Every vertical: the mail log is not a module of one product (#3955).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <I18nScope scope="admin/mail-log">{children}</I18nScope>;
}
