import Link from 'next/link';
import { interpolate } from '@/lib/notificationText';

// Previous / next links for a paged portal list. Plain links: the pages are
// server-rendered, so a page is a URL (?page=N) the partner can reload or share.
export function PortalPager({
  path,
  page,
  total,
  perPage,
  query = {},
  labels,
}: {
  path: string;
  page: number;
  total: number;
  perPage: number;
  query?: Record<string, string>;
  labels: { prev: string; next: string; pageOf: string };
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const href = (p: number) => `${path}?${new URLSearchParams({ ...query, page: String(p) }).toString()}`;
  const link = 'text-sm font-medium text-blue-600 hover:underline';
  return (
    <nav className="flex items-center justify-between gap-3 text-sm" aria-label={interpolate(labels.pageOf, { page: String(page), pages: String(pages) })}>
      {page > 1 ? <Link href={href(page - 1)} className={link}>{labels.prev}</Link> : <span />}
      <span className="text-gray-500">{interpolate(labels.pageOf, { page: String(page), pages: String(pages) })}</span>
      {page < pages ? <Link href={href(page + 1)} className={link}>{labels.next}</Link> : <span />}
    </nav>
  );
}
