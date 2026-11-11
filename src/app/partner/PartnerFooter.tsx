import Link from 'next/link';
import { legalLinks, type Landing, type LegalLinkKey } from '@/lib/affiliateLandingRule';

// The legal footer of the public programme page and its application form
// (#3363): the organisation's own Imprint / Privacy / Terms when it set them,
// else this host's own pages — plus the partner contract's public page when the
// programme has a contract.
export function PartnerFooter({
  landing,
  hasContract,
  labels,
  className = 'border-t border-gray-200 py-8 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400',
  style,
}: {
  landing: Pick<Landing, LegalLinkKey>;
  hasContract: boolean;
  labels: { legalLabel: string; imprint: string; privacy: string; terms: string; partnerTerms: string };
  /** The themed page (#3535) draws its own border and colours. */
  className?: string;
  style?: React.CSSProperties;
}) {
  const links = legalLinks(landing);
  const item = (key: LegalLinkKey, text: string) =>
    links[key].external ? (
      <a key={key} href={links[key].href} rel="noopener" className="hover:underline" data-testid={`partner-legal-${key}`}>
        {text}
      </a>
    ) : (
      <Link key={key} href={links[key].href} className="hover:underline" data-testid={`partner-legal-${key}`}>
        {text}
      </Link>
    );
  return (
    <footer className={className} style={style}>
      <nav className="mx-auto flex max-w-5xl flex-wrap justify-center gap-6 px-4" aria-label={labels.legalLabel}>
        {item('imprintUrl', labels.imprint)}
        {item('privacyUrl', labels.privacy)}
        {item('termsUrl', labels.terms)}
        {hasContract && (
          <Link href="/partner/terms" className="hover:underline" data-testid="partner-legal-contract">
            {labels.partnerTerms}
          </Link>
        )}
      </nav>
    </footer>
  );
}
