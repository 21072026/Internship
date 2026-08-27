import Link from 'next/link';
import { Building2, Mail, MapPin, Phone, ScrollText, ShieldCheck, Github, UserRound } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { GITHUB_URL } from '@/components/landing/links';
import { operatorIdentity } from '@/lib/imprint';

// The identity comes from the deployment's environment, which only exists at
// RUNTIME: the image is built on a GitHub runner that has none of these
// variables (see CLAUDE.md → Deployment). Prerendered at build time, this page
// would bake in the "no imprint published" state and keep serving it forever
// after the operator filled the env file in.
export const dynamic = 'force-dynamic';

/**
 * Imprint / Impressum / Künye (#1396).
 *
 * The one page that says who is behind this deployment. It answers two
 * different duties with the same facts — §5 DDG (the imprint a commercial site
 * aimed at Germany owes) and GDPR Art. 13 (the controller a visitor handing
 * over personal data is entitled to know) — which is why /privacy points here
 * rather than repeating them.
 *
 * The email is rendered as a plain, clickable `mailto:`. Obfuscating it would
 * shave a little spam off at the cost of the thing the page exists for: the
 * address has to be one a visitor can actually reach without solving a puzzle,
 * and a JS-scrambled address is not that.
 */
export default async function ImprintPage() {
  const { t } = await getServerDictionary();
  const m = t.imprint;
  const operator = operatorIdentity();

  const rows = operator
    ? ([
        { icon: Building2, label: m.operatorTitle, value: operator.name, testid: 'imprint-operator' },
        operator.address.length
          ? { icon: MapPin, label: m.addressTitle, value: operator.address, testid: 'imprint-address' }
          : null,
        {
          icon: Mail,
          label: m.contactTitle,
          value: (
            <a href={`mailto:${operator.email}`} className="text-blue-600 hover:underline">
              {operator.email}
            </a>
          ),
          testid: 'imprint-email',
        },
        operator.phone ? { icon: Phone, label: '', value: operator.phone, testid: 'imprint-phone' } : null,
        operator.responsible
          ? { icon: UserRound, label: m.responsibleTitle, value: operator.responsible, testid: 'imprint-responsible' }
          : null,
        operator.vatId ? { icon: ScrollText, label: m.vatTitle, value: operator.vatId, testid: 'imprint-vat' } : null,
        operator.register
          ? { icon: ScrollText, label: m.registerTitle, value: operator.register, testid: 'imprint-register' }
          : null,
        operator.dpo ? { icon: ShieldCheck, label: m.dpoTitle, value: operator.dpo, testid: 'imprint-dpo' } : null,
      ].filter(Boolean) as {
        icon: typeof Building2;
        label: string;
        value: React.ReactNode | string[];
        testid: string;
      }[])
    : [];

  // "… see the {privacy}." — the link is placed inside the sentence rather than
  // bolted on after it, so the three languages can each put it where their
  // grammar wants it.
  const [noteBefore, noteAfter] = m.controllerNote.split('{privacy}');

  return (
    <PublicShell>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">{m.title}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">{m.intro}</p>

          {operator ? (
            <>
              <dl className="space-y-5" data-testid="imprint-details">
                {rows.map((row) => (
                  <div key={row.testid} className="flex items-start gap-3">
                    <row.icon className="h-4 w-4 text-gray-400 flex-shrink-0 mt-1" aria-hidden="true" />
                    <div className="min-w-0">
                      {row.label && (
                        <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          {row.label}
                        </dt>
                      )}
                      <dd className="text-sm text-gray-800 dark:text-gray-200 mt-0.5" data-testid={row.testid}>
                        {Array.isArray(row.value)
                          ? row.value.map((line) => <div key={line}>{line}</div>)
                          : row.value}
                      </dd>
                    </div>
                  </div>
                ))}
              </dl>

              <p className="mt-8 pt-6 border-t border-gray-100 dark:border-gray-800 text-sm text-gray-600 dark:text-gray-300">
                {noteBefore}
                <Link href="/privacy" className="text-blue-600 hover:underline">
                  {m.privacyLink}
                </Link>
                {noteAfter}
              </p>
            </>
          ) : (
            /* Honest empty state (#1396). Nothing is invented and nothing
               pretends to be pending paperwork: this deployment's operator has
               not published their details, and the visitor is handed the one
               route that does exist. */
            <div
              data-testid="imprint-unset"
              className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 p-5"
            >
              <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-1">{m.unsetTitle}</h2>
              <p className="text-sm text-amber-800 dark:text-amber-100/80 leading-relaxed">{m.unsetBody}</p>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
              >
                <Github className="h-4 w-4" aria-hidden="true" />
                {m.unsetLink}
              </a>
            </div>
          )}

          <Link href="/" className="inline-block mt-8 text-sm text-blue-600 hover:underline">
            ← {m.back}
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
