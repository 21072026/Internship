import { ProgramTerminologyScope } from '@/i18n/programScope';

// One programme's pages read that programme's own vocabulary (#3400). The id is
// honoured only for a programme of the caller's own org (programScope.tsx);
// anything else renders with the org's words, exactly as before. The scope is
// this section's own (#3599): `admin` carries only the chrome since the split.
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ProgramTerminologyScope programId={id} scope="admin/programs">
      {children}
    </ProgramTerminologyScope>
  );
}
