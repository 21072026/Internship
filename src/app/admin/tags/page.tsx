import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { TagManager } from '@/components/admin/TagManager';

export const dynamic = 'force-dynamic';

// Tag management (#845). Admin-only: creating and applying a label is everyday
// work a mentor should do, but renaming, merging or deleting one rewrites the
// org's shared vocabulary for everybody at once.
export default async function AdminTagsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'ADMIN') redirect('/');

  const { t } = await getServerDictionary();
  const m = t.tagAdmin;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{m.title}</h1>
        <p className="text-gray-500 mt-1 max-w-3xl">{m.subtitle}</p>
      </div>
      <TagManager />
    </div>
  );
}
