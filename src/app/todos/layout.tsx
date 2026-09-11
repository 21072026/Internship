import { RoleShell } from '@/components/RoleShell';

export default async function TodosLayout({ children }: { children: React.ReactNode }) {
  return <RoleShell>{children}</RoleShell>;
}
