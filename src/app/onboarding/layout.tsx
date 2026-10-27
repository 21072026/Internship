import { NO_INDEX } from '@/lib/pageMetadata';
import { I18nScope } from '@/i18n/scope';

// Signed-in (or signing-in) area: never in a search result (#1376). A
// pass-through layout only to carry the metadata; it renders nothing itself.
export const metadata = NO_INDEX;

function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

// The segment's dictionary namespaces wrap the WHOLE layout, its own chrome
// included (#2987, src/i18n/scope.tsx).
export default function ScopedLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope scope="onboarding">
      <Layout>{children}</Layout>
    </I18nScope>
  );
}
