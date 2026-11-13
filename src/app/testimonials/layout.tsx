import { requireVerticalCapability } from '@/lib/verticalPage';
import { I18nScope } from '@/i18n/scope';

// The testimonial approval page is the mentorship programme's (a mentee
// approving a quote about their mentoring), and its API already refuses a
// vertical without `mentorship` — so the page does too, instead of rendering
// an empty shell whose only action is refused (#2348). Same gate as /apply,
// /code-of-conduct and /roi-calculator.
async function TestimonialsLayout({ children }: { children: React.ReactNode }) {
  await requireVerticalCapability('mentorship');
  return <>{children}</>;
}

// Ships this directory's dictionary namespaces to the browser (#2987): the root
// layout carries only the shell, see src/i18n/scope.tsx and
// scripts/i18n-scopes.mjs. The scope wraps the WHOLE layout.
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope scope="testimonials">
      <TestimonialsLayout>{children}</TestimonialsLayout>
    </I18nScope>
  );
}
