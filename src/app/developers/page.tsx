import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { pageMetadata } from '@/lib/pageMetadata';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { GET as publicSpec } from '@/app/api/v1/openapi.json/route';
import type { ApiErrorType } from '@/lib/api/v1';
import { API_DEPRECATIONS, DEPRECATION_WINDOW_MONTHS } from '@/lib/api/v1Lifecycle';
import { WEBHOOK_VERIFY_NODE } from '@/lib/api/webhookRecipe';
import { SANDBOX_DAILY_QUOTA, SANDBOX_KEY_TTL_MS, sandboxEnabled } from '@/lib/api/sandboxKeyRule';
import { DEMO_URL } from '@/lib/demoMode';
import { SandboxKeyButton } from '@/components/developers/SandboxKeyButton';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata((t) => ({ title: t.developers.title, description: t.developers.subtitle }));
}

// The public developer portal (#1992). Rendered from the PUBLIC spec — the
// handler of GET /api/v1/openapi.json itself, so the page and the JSON cannot
// describe different APIs — and never from the admin document
// (src/app/api/admin/openapi/route.ts), which maps every admin action and guard
// and stays behind a super-admin session.
//
// The spec's summaries are English, like the spec; the prose around them is
// translated.

// The HTTP status each error type answers with (src/lib/api/v1.ts). A Record
// over the union: a new type fails the typecheck until it is placed here.
const ERROR_STATUS: Record<ApiErrorType, string> = {
  invalid_api_key: '401',
  insufficient_scope: '403',
  org_unbound: '403',
  feature_locked: '403',
  invalid_link: '403',
  company_key_not_allowed: '403',
  source_key_not_allowed: '403',
  not_found: '404',
  validation_failed: '400 / 422',
  idempotency_key_reused: '409',
  idempotency_in_progress: '409',
  limit_reached: '409',
  duplicate_candidate: '409',
  invalid_transition: '409',
  stage_conflict: '409',
  rate_limited: '429',
  quota_exceeded: '429',
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  summary?: string;
  security?: { apiKey?: string[] }[];
}
interface Spec {
  info: { version: string };
  paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>;
  'x-webhooks'?: { events?: string[]; payloads?: Record<string, unknown> };
}

async function loadSpec(): Promise<Spec> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost';
  const res = await publicSpec(new Request(`http://${host}/api/v1/openapi.json`, { headers: { host } }));
  return (await res.json()) as Spec;
}

const cell = 'px-3 py-2 align-top';
const code = 'font-mono text-xs text-gray-800 dark:text-gray-200';

export default async function DevelopersPage() {
  const [{ t }, spec] = await Promise.all([getServerDictionary(), loadSpec()]);
  const D = t.developers;
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((m) => ({
      method: m.toUpperCase(),
      path: `/api/v1${path}`,
      summary: item[m]!.summary ?? '',
      scopes: (item[m]!.security ?? []).flatMap((s) => s.apiKey ?? []),
    })),
  );
  const payloads = Object.entries(spec['x-webhooks']?.payloads ?? {});

  return (
    <PublicShell breadcrumb={{ name: D.title, path: '/developers' }}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 space-y-12">
        <header>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">{D.title}</h1>
          <p className="text-gray-600 dark:text-gray-400">{D.subtitle}</p>
          <p className="mt-3 text-sm">
            <a href="/api/v1/openapi.json" className="text-blue-700 hover:underline dark:text-blue-400" data-testid="developers-spec-link">
              {D.specLink}
            </a>{' '}
            <span className="text-gray-500">· v{spec.info.version}</span>
          </p>
        </header>

        <section aria-labelledby="dev-auth">
          <h2 id="dev-auth" className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">{D.authTitle}</h2>
          <p className="text-sm text-gray-700 dark:text-gray-300">{D.authBody}</p>
          <h3 className="mt-4 font-semibold text-gray-900 dark:text-gray-100">{D.limitsTitle}</h3>
          <p className="text-sm text-gray-700 dark:text-gray-300">{D.limitsBody}</p>
        </section>

        <section aria-labelledby="dev-sandbox" data-testid="developers-sandbox">
          <h2 id="dev-sandbox" className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">{D.sandboxTitle}</h2>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {D.sandboxBody.replace('{hours}', String(SANDBOX_KEY_TTL_MS / 3_600_000)).replace('{quota}', String(SANDBOX_DAILY_QUOTA))}
          </p>
          {/* Only the demo mints (sandboxKeyRule.ts); everywhere else this points there. */}
          {sandboxEnabled(process.env) ? (
            <SandboxKeyButton />
          ) : (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {D.sandboxElsewhere}{' '}
              <a href={`${DEMO_URL}/developers`} className="text-blue-700 hover:underline dark:text-blue-400" data-testid="developers-sandbox-demo-link">
                {D.sandboxDemoLink}
              </a>
            </p>
          )}
        </section>

        <section aria-labelledby="dev-conventions">
          <h2 id="dev-conventions" className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">{D.conventionsTitle}</h2>
          <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700 dark:text-gray-300">
            <li>{D.paginationBody}</li>
            <li>{D.writesBody}</li>
            <li>{D.errorsBody}</li>
          </ul>
        </section>

        <section aria-labelledby="dev-endpoints">
          <h2 id="dev-endpoints" className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-3">{D.endpointsTitle}</h2>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800" tabIndex={0}>
            <table className="w-full text-sm" data-testid="developers-endpoints">
              <thead className="bg-gray-50 dark:bg-gray-900 text-left text-gray-600 dark:text-gray-400">
                <tr>
                  <th className={cell}>{D.colMethod}</th>
                  <th className={cell}>{D.colPath}</th>
                  <th className={cell}>{D.colScope}</th>
                  <th className={cell}>{D.colSummary}</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((op) => (
                  <tr key={`${op.method} ${op.path}`} className="border-t border-gray-100 dark:border-gray-800">
                    <td className={`${cell} ${code}`}>{op.method}</td>
                    <td className={`${cell} ${code} break-all`}>{op.path}</td>
                    <td className={`${cell} ${code}`}>{op.scopes.join(', ') || '—'}</td>
                    <td className={`${cell} text-gray-700 dark:text-gray-300`}>{op.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="dev-errors">
          <h2 id="dev-errors" className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-3">{D.errorsTitle}</h2>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800" tabIndex={0}>
            <table className="w-full text-sm" data-testid="developers-errors">
              <thead className="bg-gray-50 dark:bg-gray-900 text-left text-gray-600 dark:text-gray-400">
                <tr>
                  <th className={cell}>{D.colType}</th>
                  <th className={cell}>{D.colStatus}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(ERROR_STATUS).map(([type, status]) => (
                  <tr key={type} className="border-t border-gray-100 dark:border-gray-800">
                    <td className={`${cell} ${code}`}>{type}</td>
                    <td className={`${cell} ${code}`}>{status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="dev-webhooks">
          <h2 id="dev-webhooks" className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">{D.webhooksTitle}</h2>
          <p className="text-sm text-gray-700 dark:text-gray-300">{D.webhooksBody}</p>
          <h3 className="mt-4 mb-2 font-semibold text-gray-900 dark:text-gray-100">{D.recipeTitle}</h3>
          <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-xs text-gray-100" tabIndex={0} data-testid="developers-webhook-recipe">
            <code>{WEBHOOK_VERIFY_NODE}</code>
          </pre>
          <h3 className="mt-6 mb-2 font-semibold text-gray-900 dark:text-gray-100">{D.eventsTitle}</h3>
          <div className="space-y-2" data-testid="developers-events">
            {payloads.map(([name, schema]) => (
              <details key={name} className="rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2">
                <summary className={`cursor-pointer ${code}`}>{name}</summary>
                <p className="mt-2 text-xs text-gray-500">{D.colPayload}</p>
                <pre className="mt-1 overflow-x-auto text-xs text-gray-700 dark:text-gray-300" tabIndex={0}>
                  <code>{JSON.stringify(schema, null, 2)}</code>
                </pre>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="dev-lifecycle">
          <h2 id="dev-lifecycle" className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">{D.lifecycleTitle}</h2>
          <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="developers-lifecycle">
            {D.lifecycleBody.replace('{months}', String(DEPRECATION_WINDOW_MONTHS))}
          </p>
          <h3 className="mt-4 mb-2 font-semibold text-gray-900 dark:text-gray-100">{D.deprecationsTitle}</h3>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800" tabIndex={0}>
            <table className="w-full text-sm" data-testid="developers-deprecations">
              <thead className="bg-gray-50 dark:bg-gray-900 text-left text-gray-600 dark:text-gray-400">
                <tr>
                  <th className={cell}>{D.colWhat}</th>
                  <th className={cell}>{D.colSince}</th>
                  <th className={cell}>{D.colSunset}</th>
                </tr>
              </thead>
              <tbody>
                {API_DEPRECATIONS.map((d) => (
                  <tr key={d.what} className="border-t border-gray-100 dark:border-gray-800">
                    <td className={`${cell} ${code}`}>{d.what}</td>
                    <td className={`${cell} ${code}`}>{d.since}</td>
                    <td className={`${cell} ${code}`}>{d.sunset}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-gray-700 dark:text-gray-300">
            {D.changelogBody}{' '}
            <Link href="/release-notes" className="text-blue-700 hover:underline dark:text-blue-400">
              {D.changelogLink}
            </Link>
          </p>
        </section>
      </div>
    </PublicShell>
  );
}
