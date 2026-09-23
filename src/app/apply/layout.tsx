import { internshipProductPage } from '@/lib/verticalPage';

// `/apply/[mentorId]` is a client component, so the vertical gate lives here:
// applying to a mentor is the internship product's front door and has no
// meaning for a marketing tenant (#2540).
export default async function ApplyLayout({ children }: { children: React.ReactNode }) {
  await internshipProductPage();
  return <>{children}</>;
}
