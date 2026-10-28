import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveQueueScope } from '@/lib/mailQueueAdmin';
import { getServerDictionary } from '@/i18n/server';
import { OperationsConsole } from '@/components/admin/OperationsConsole';

// /admin/operations (#1607) — the deployment's scheduled jobs, their last runs,
// the failed-run counts and an integrations roll-up. src/app/admin/layout.tsx
// already turned away a missing session and a non-ADMIN role; this page takes
// the mail queue's operator rule on top (a super admin, or the default
// organization's ADMIN). A tenant admin gets a short explanation. The API
// refuses them itself — page gating is not API gating.
export default async function OperationsPage() {
  if (!(await resolveQueueScope(await getServerSession(authOptions)))) {
    const { t } = await getServerDictionary();
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-3">{t.operations.title}</h1>
        <p data-testid="operations-operator-only" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t.operations.operatorOnly}
        </p>
      </div>
    );
  }
  return <OperationsConsole />;
}
