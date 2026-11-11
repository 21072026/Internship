import { I18nScope } from '@/i18n/scope';
import { gatePage } from '@/lib/pageCapabilityGate';

// Closed at its URL for a vertical without this module (src/lib/pageCapabilityGate.ts).
// Ships this section's dictionary namespaces to the browser (#3599, src/i18n/scope.tsx).
export default async function Layout({ children }: { children: React.ReactNode }) {
  await gatePage('/admin/company-inquiries');
  return <I18nScope scope="admin/company-inquiries">{children}</I18nScope>;
}
