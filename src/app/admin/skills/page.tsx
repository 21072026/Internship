import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { SkillManager } from '@/components/admin/SkillManager';

export const dynamic = 'force-dynamic';

// Skill vocabulary curation (#1817) and the backfill's review queue (#1819).
// Admin-only here AND in every route it calls — hiding the page is not the check.
export default async function AdminSkillsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'ADMIN') redirect('/');

  const { t } = await getServerDictionary();
  const m = t.skillAdmin;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{m.title}</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1 max-w-3xl">{m.subtitle}</p>
      </div>
      <SkillManager />
    </div>
  );
}
