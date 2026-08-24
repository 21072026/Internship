import Link from 'next/link';
import { FileSignature, ArrowRight } from 'lucide-react';

/**
 * The gate shown in place of a contributor surface (#1025).
 *
 * Deliberately narrow: it stands in front of the places where a contribution —
 * and therefore the IP question — actually happens, and nowhere else. A mentee
 * reading their dashboard, messaging their mentor or editing their profile is
 * not contributing anything, and blocking that would turn a legal safeguard
 * into a nuisance.
 */
export function ContributorTermsGate({
  title,
  body,
  cta,
  next,
}: {
  title: string;
  body: string;
  cta: string;
  next: string;
}) {
  return (
    <div
      data-testid="contributor-terms-gate"
      className="mx-auto max-w-xl rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-8 text-center"
    >
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/60">
        <FileSignature className="h-7 w-7 text-amber-700 dark:text-amber-300" />
      </div>
      <h2 className="text-lg font-semibold text-amber-900 dark:text-amber-100">{title}</h2>
      <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">{body}</p>
      <Link
        href={`/onboarding/contributor-terms?next=${encodeURIComponent(next)}`}
        data-testid="contributor-terms-gate-cta"
        className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
      >
        {cta}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
