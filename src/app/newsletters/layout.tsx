import { RoleShell } from '@/components/RoleShell';

export default async function NewslettersLayout({ children }: { children: React.ReactNode }) {
  return <RoleShell>{children}</RoleShell>;
}
