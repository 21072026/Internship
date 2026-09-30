import { NO_INDEX } from '@/lib/pageMetadata';

// Signed-in (or signing-in) area: never in a search result (#1376). A
// pass-through layout only to carry the metadata; it renders nothing itself.
export const metadata = NO_INDEX;

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
