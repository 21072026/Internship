import { RoleShell } from '@/components/RoleShell';
import { gatePage } from '@/lib/pageCapabilityGate';
import { I18nScope } from '@/i18n/scope';

async function NewslettersLayout({ children }: { children: React.ReactNode }) {
  // The archive is an internship module (navLinks tags it `mentorship`).
  await gatePage('/newsletters');
  return <RoleShell>{children}</RoleShell>;
}

// The segment's dictionary namespaces wrap the WHOLE layout, its own chrome
// included (#2987, src/i18n/scope.tsx).
export default function ScopedNewslettersLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope scope="newsletters">
      <NewslettersLayout>{children}</NewslettersLayout>
    </I18nScope>
  );
}
