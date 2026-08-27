import { Archive } from 'lucide-react';

// The one-line "this mentorship is finished, what you see is the record" banner
// the portal shows on an archived mentorship (#1408). A server component with
// no state: the pages already resolved the copy from the dictionary, so this is
// purely the shared shape — kept in one place so the dashboard, the journey page
// and the two panel pages cannot drift apart.
export function ArchivedNotice({ title, hint }: { title: string; hint: string }) {
  return (
    <div
      data-testid="mentorship-archived-notice"
      className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 dark:border-gray-700 dark:bg-gray-800/60"
    >
      <Archive className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500 dark:text-gray-400" />
      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</p>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-300">{hint}</p>
      </div>
    </div>
  );
}
