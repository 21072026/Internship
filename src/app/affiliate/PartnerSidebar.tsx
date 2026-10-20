'use client';

// The partner's left menu. Sign-out goes through signOutEverywhere(), the one
// sign-out path the app allows (CLAUDE.md), so the device trust is revoked too.
import Link from 'next/link';
import { signOutEverywhere } from '@/lib/signOutClient';

export function PartnerSidebar({
  brand,
  labels,
}: {
  brand: React.ReactNode;
  labels: { portal: string; account: string; signOut: string };
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
      <div className="mt-auto">
        <button
          type="button"
          onClick={() => signOutEverywhere()}
          className="w-full rounded border px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          {labels.signOut}
        </button>
      </div>
    </aside>
  );
}
