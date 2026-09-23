import { PublicShell } from '@/components/landing/PublicShell';
import { ApplyMentorForm } from '@/components/forms/ApplyMentorForm';
import { internshipProductPage } from '@/lib/verticalPage';

// Public mentor application. The form is a client component (#1197); the page
// stays on the server so it wears the same chrome as every other public page —
// it used to render a bare card with no header, no footer and a stray language
// switcher under the submit button.
export default async function ApplyAsMentorPage() {
  await internshipProductPage();
  return (
    <PublicShell>
      <ApplyMentorForm />
    </PublicShell>
  );
}
