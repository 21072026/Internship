import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';

// Friendly empty-state with an optional primary action.
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actionLabel,
  actionHref,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="text-center py-14 px-4">
      <div className="mx-auto w-12 h-12 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-gray-400 dark:text-gray-400" />
      </div>
      <p className="text-gray-900 dark:text-gray-100 font-medium">{title}</p>
      {description && <p className="text-gray-500 dark:text-gray-400 text-sm mt-1 max-w-sm mx-auto">{description}</p>}
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="inline-flex items-center mt-4 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
