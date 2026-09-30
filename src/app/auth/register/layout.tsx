import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/pageMetadata';

// The register page is a client component, so its title lives here (#1376).
// `robots` is inherited from src/app/auth/layout.tsx.
export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata((t) => ({ title: t.seo.registerTitle, description: t.seo.registerDescription }));
}

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
