import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { MyTodos } from '@/components/todos/MyTodos';

// "Yapılacaklar" — one list per person (#1113): what a mentor handed them, what
// their projects need, and what they wrote for themselves.
export default async function TodosPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/auth/signin');
  const { t } = await getServerDictionary();

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.todos.title}</h1>
      <p className="mt-1 mb-6 text-sm text-gray-500">{t.todos.subtitle}</p>
      <MyTodos myId={session.user.id} />
    </div>
  );
}
