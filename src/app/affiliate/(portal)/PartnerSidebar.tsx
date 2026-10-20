'use client';

// The partner's left menu. The account menu, with sign-out, sits at the bottom.
import Link from 'next/link';

export function PartnerSidebar({
  brand,
  account,
  labels,
}: {
  brand: React.ReactNode;
  account: React.ReactNode;
  labels: { portal: string; account: string };
}) {
  return (
    <aside className="flex h-full w-64 flex-col border-r border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-6 px-3">{brand}</div>
      <nav className="flex flex-col gap-1">
        <Link href="/affiliate" className="rounded px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800">
          {labels.portal}
        </Link>
        <Link href="/account" className="rounded px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800">
          {labels.account}
        </Link>
      </nav>
      <div className="mt-auto pt-4">{account}</div>
    </aside>
  );
}
