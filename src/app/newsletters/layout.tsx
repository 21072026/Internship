import { RoleShell } from '@/components/RoleShell';
import { gatePage } from '@/lib/pageCapabilityGate';

export default async function NewslettersLayout({ children }: { children: React.ReactNode }) {
  // The archive is an internship module (navLinks tags it `mentorship`).
  await gatePage('/newsletters');
  return <RoleShell>{children}</RoleShell>;
}
