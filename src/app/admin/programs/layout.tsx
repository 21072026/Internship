import { I18nScope } from '@/i18n/scope';
import { gatePage } from '@/lib/pageCapabilityGate';

// Closed at its URL for a vertical without this module (src/lib/pageCapabilityGate.ts).
// Ships this section's dictionary namespaces to the browser (#3599, src/i18n/scope.tsx).
// A programme is the cohort row (#1622 renames it), so it shares the cohorts gate.
export default async function Layout({ children }: { children: React.ReactNode }) {
  await gatePage('/admin/cohorts');
  return <I18nScope scope="admin/programs">{children}</I18nScope>;
}
