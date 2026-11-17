import { I18nScope } from '@/i18n/scope';
import { requirePermission } from '@/lib/authz';
import { adminTierFor } from '@/lib/authzRule';
import { notFound } from 'next/navigation';
export default async function Layout({ children }: { children: React.ReactNode }) {
  const gate = await requirePermission('org.settings.read');
  if ('error' in gate || adminTierFor(gate.session.user.role, gate.session.user.adminLevel) !== 'ORG_ADMIN') notFound();
  return <I18nScope scope="admin/subscribers">{children}</I18nScope>;
}
