import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/pageMetadata';
import { PublicShell } from '@/components/landing/PublicShell';
import { ApplyMentorForm } from '@/components/forms/ApplyMentorForm';
import { requireVerticalCapability } from '@/lib/verticalPage';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata((t) => ({ title: t.seo.applyAsMentorTitle, description: t.seo.applyAsMentorDescription }), '/apply-as-mentor/opengraph-image');
}


// Public mentor application. The form is a client component (#1197); the page
// stays on the server so it wears the same chrome as every other public page —
// it used to render a bare card with no header, no footer and a stray language
// switcher under the submit button.
export default async function ApplyAsMentorPage() {
  // Becoming a mentor is the `mentorship` module's front door (#2544).
  await requireVerticalCapability('mentorship');
  return (
    <PublicShell>
      <ApplyMentorForm />
    </PublicShell>
  );
}
