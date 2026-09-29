import { requireVerticalCapability } from '@/lib/verticalPage';

// `/apply/[mentorId]` is a client component, so the vertical gate lives here:
// applying to a mentor is the `mentorship` module's front door and has no
// meaning for a vertical without it (#2544).
export default async function ApplyLayout({ children }: { children: React.ReactNode }) {
  await requireVerticalCapability('mentorship');
  return <>{children}</>;
}
