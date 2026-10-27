import { requireVerticalCapability } from '@/lib/verticalPage';
import { I18nScope } from '@/i18n/scope';

// `/apply/[mentorId]` is a client component, so the vertical gate lives here:
// applying to a mentor is the `mentorship` module's front door and has no
// meaning for a vertical without it (#2544).
async function ApplyLayout({ children }: { children: React.ReactNode }) {
  await requireVerticalCapability('mentorship');
  return <>{children}</>;
}

// The segment's dictionary namespaces wrap the WHOLE layout, its own chrome
// included (#2987, src/i18n/scope.tsx).
export default function ScopedApplyLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope scope="apply">
      <ApplyLayout>{children}</ApplyLayout>
    </I18nScope>
  );
}
