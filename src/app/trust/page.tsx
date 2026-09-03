import Link from 'next/link';
import { ShieldCheck, Server, Users, Globe, FileText, AlertTriangle } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { GITHUB_URL } from '@/components/landing/links';
import { operatorIdentity } from '@/lib/imprint';
import {
  getSubprocessors,
  CONTROL_KEYS,
  LIMITATION_KEYS,
  SUBPROCESSORS_UPDATED,
} from '@/lib/trust';

// Same reason as /privacy: the operator's identity is read from the
// deployment's env, which only exists at runtime. Prerendering would freeze
// "no operator published" into the image (src/lib/imprint.ts).
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Trust centre',
  description:
    'Subprocessors, security controls, and where the data is hosted — the answers a procurement review asks for.',
};

const DOC_BASE = `${GITHUB_URL}/blob/main/docs/trust`;

/**
 * /trust (#2027) — one URL a salesperson can paste into a procurement e-mail.
 *
 * The register itself is NOT written here and is not written three times in the
 * dictionary: it lives once, typed, in `src/lib/trust.ts`, and only the prose is
 * translated (keyed by the same ids, so a missing translation is a type error).
 * The long-form documents it summarises are in `docs/trust/`.
 *
 * Rule of the page: nothing on it may be a claim this repository cannot
 * evidence. That is why the "what is not true yet" block exists rather than
 * being tidied away — enforcement of tenant isolation is off in production
 * (#1572), and saying so is what makes the rest of the page worth reading.
 */
export default async function TrustPage() {
  const { t } = await getServerDictionary();
  const p = t.trust;

  const operator = operatorIdentity();
  const operatorBody = operator
    ? p.operatorBody.replace('{operator}', operator.name)
    : p.operatorUnset;

  const subprocessors = getSubprocessors(t);

  const postureCards = [
    { key: 'hosting', icon: Server, title: p.posture.hostingT, body: p.posture.hostingD },
    { key: 'data', icon: Users, title: p.posture.dataT, body: p.posture.dataD },
    { key: 'thirdParties', icon: Globe, title: p.posture.thirdPartiesT, body: p.posture.thirdPartiesD },
    { key: 'crm', icon: ShieldCheck, title: p.posture.crmT, body: p.posture.crmD },
  ];

  const docLinks = [
    { href: `${DOC_BASE}/subprocessors.md`, label: p.docs.subprocessors, external: true },
    { href: `${DOC_BASE}/security-overview.md`, label: p.docs.security, external: true },
    { href: `${DOC_BASE}/hosting-and-residency.md`, label: p.docs.hosting, external: true },
    { href: '/privacy', label: p.docs.privacy, external: false },
    { href: '/imprint', label: p.docs.imprint, external: false },
    // /status is #1604 and does not exist yet. The public liveness half of
    // /api/health is what can honestly be linked today.
    { href: '/api/health', label: p.docs.health, external: false },
  ];

  return (
    <PublicShell>
      <div className="max-w-5xl mx-auto my-12 px-4">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{p.title}</h1>
          <p className="mt-2 text-base text-gray-600 dark:text-gray-300">{p.subtitle}</p>
          <p className="mt-1 text-xs text-gray-400">
            {p.lastUpdatedLabel}: {SUBPROCESSORS_UPDATED}
          </p>
        </header>

        <p className="text-sm text-gray-600 dark:text-gray-300 mb-8">{p.intro}</p>

        {/* Posture summary */}
        <section className="mb-10" data-testid="trust-posture">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{p.postureTitle}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {postureCards.map((c) => {
              const Icon = c.icon;
              return (
                <div
                  key={c.key}
                  className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-5"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="h-5 w-5 text-blue-600 flex-shrink-0" aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{c.title}</h3>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300">{c.body}</p>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-sm font-medium text-gray-700 dark:text-gray-200">{p.freeNote}</p>
        </section>

        {/* Who runs this deployment — never hardcoded, see src/lib/imprint.ts */}
        <section className="mb-10" data-testid="trust-operator">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{p.operatorTitle}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300">{operatorBody}</p>
        </section>

        {/* Subprocessor register */}
        <section className="mb-10" data-testid="trust-subprocessors">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {p.subprocessorsTitle}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{p.subprocessorsIntro}</p>

          {/* The table is the widest thing on the page by far, so it scrolls
              inside its own box. Without this the whole document scrolls
              sideways on a phone. */}
          <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            <table className="min-w-[52rem] w-full text-left text-sm" data-testid="subprocessor-table">
              <thead className="bg-gray-50 dark:bg-gray-800/60">
                <tr className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <th scope="col" className="px-4 py-3 font-semibold">{p.colSubprocessor}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{p.colPurpose}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{p.colData}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{p.colLocation}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{p.colBasis}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{p.colOptional}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {subprocessors.map((s) => (
                  <tr key={s.id} data-testid={`subprocessor-row-${s.id}`} className="align-top">
                    <th scope="row" className="px-4 py-3 font-semibold text-gray-900 dark:text-gray-100">
                      {s.name}
                      {s.env.length > 0 && (
                        <span className="mt-1 block font-mono text-[11px] font-normal text-gray-400 break-all">
                          {s.env.join(', ')}
                        </span>
                      )}
                    </th>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{s.purpose}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{s.data}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{s.location}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{s.basis}</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          'inline-block rounded-full px-2 py-0.5 text-xs font-medium ' +
                          (s.optionality === 'required'
                            ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200'
                            : 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200')
                        }
                      >
                        {s.optionalityLabel}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Controls grid */}
        <section className="mb-10" data-testid="trust-controls">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{p.controlsTitle}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{p.controlsIntro}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {CONTROL_KEYS.map((key) => (
              <div
                key={key}
                className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-5"
              >
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                  {p.controls[key].t}
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-300">{p.controls[key].d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* The honest half. Deliberately not collapsed or footnoted. */}
        <section className="mb-10" data-testid="trust-limitations">
          {/* `bg-amber-50` + `text-amber-900` is the pairing globals.css already
              retints for dark mode (the box goes dark amber, the text goes
              amber-300), so no `dark:` overrides are needed here beyond the
              border, which those rules do not cover. */}
          <div className="rounded-2xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 p-5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-5 w-5 text-amber-700 flex-shrink-0" aria-hidden="true" />
              <h2 className="text-lg font-semibold text-amber-900">{p.limitationsTitle}</h2>
            </div>
            <p className="text-sm text-amber-900 mb-3">{p.limitationsIntro}</p>
            <ul className="list-disc pl-5 space-y-2 text-sm text-amber-900">
              {LIMITATION_KEYS.map((key) => (
                <li key={key} data-testid={`trust-limitation-${key}`}>
                  {p.limitations[key]}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Residency */}
        <section className="mb-10" data-testid="trust-residency">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{p.residencyTitle}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">{p.residencyBody}</p>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-5">{p.residencyEu}</p>

          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
              {p.residencySelfHostTitle}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-300">{p.residencySelfHost}</p>
          </div>
        </section>

        {/* Link row */}
        <section data-testid="trust-docs">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{p.docsTitle}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">{p.docsIntro}</p>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {docLinks.map((l) => (
              <li key={l.href} className="flex items-center gap-1.5">
                <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
                {l.external ? (
                  <a
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {l.label}
                  </a>
                ) : (
                  <Link href={l.href} className="text-blue-600 hover:underline">
                    {l.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>

        <Link href="/" className="inline-block mt-10 text-sm text-blue-600 hover:underline">
          ← {p.back}
        </Link>
      </div>
    </PublicShell>
  );
}
