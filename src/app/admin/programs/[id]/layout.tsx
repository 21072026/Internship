import { ProgramTerminologyScope } from '@/i18n/programScope';

// One programme's pages read that programme's own vocabulary (#3400). The id is
// honoured only for a programme of the caller's own org (programScope.tsx);
// anything else renders with the org's words, exactly as before.
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ProgramTerminologyScope programId={id} scope="admin">
      {children}
    </ProgramTerminologyScope>
  );
}
