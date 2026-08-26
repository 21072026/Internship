'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Check, Copy, KeyRound, ShieldAlert, Trash2 } from 'lucide-react';
import { useT } from '@/i18n/client';
import type { SwaggerUISystem } from 'swagger-ui-dist/swagger-ui-es-bundle.js';
import 'swagger-ui-dist/swagger-ui.css';

// The admin API explorer (#1447) — real Swagger UI over the FULL internal
// surface, not just the public /api/v1 read API.
//
// WHY IT IS BUILT THIS WAY
//   * The bundle comes from node_modules, never a CDN: `script-src` in
//     next.config.js is `'self'` plus a short allowlist that does not include
//     unpkg/jsdelivr-for-swagger, so a CDN tag would simply be blocked.
//   * `validatorUrl: null` — the default would POST the spec to
//     validator.swagger.io. That is blocked by the CSP anyway, but the real
//     reason is that this spec describes a private surface and must not leave
//     the origin.
//   * The heavy bundle (~1.2 MB) is `await import()`ed inside the effect, so it
//     becomes its own async chunk that only this route ever downloads. It also
//     touches `window` at module scope, which would break the server render if
//     it were a static import.
//
// THE TWO AUTH MODES (this is the whole point of the screen)
//   1. Session cookie — the admin is already signed in, so "Try it out" is
//      authenticated with no token at all. `withCredentials` covers Swagger's
//      XHR path and the requestInterceptor pins the fetch path to
//      `same-origin`, which is deliberately stricter than `include`: if a spec
//      ever grows an absolute server URL, the session cookie still will not be
//      sent off-origin.
//   2. Bearer API key — minted in-page and pushed straight into the Authorize
//      dialog via `preauthorizeApiKey`, so nobody copy-pastes a credential.
//      API keys authenticate `/api/v1/*` ONLY; everything else is session-only,
//      and the copy on the page says so rather than implying otherwise.

interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

function countOperations(spec: OpenApiSpec): { paths: number; operations: number } {
  const paths = spec.paths ?? {};
  let operations = 0;
  for (const item of Object.values(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method.toLowerCase())) operations += 1;
    }
  }
  return { paths: Object.keys(paths).length, operations };
}

interface MintedKey {
  id: string;
  name: string;
  raw: string;
}

export function ApiExplorer() {
  const t = useT();
  const toast = useToast();

  const containerRef = useRef<HTMLDivElement>(null);
  const uiRef = useRef<SwaggerUISystem | null>(null);
  const startedRef = useRef(false);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [counts, setCounts] = useState<{ paths: number; operations: number } | null>(null);

  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    // `reactStrictMode` double-invokes effects in dev, so the mount is guarded
    // by a ref. Note there is deliberately NO abort flag in the cleanup: with
    // the ref guard, cancelling on the first (immediately-unmounted) pass would
    // mean nothing ever mounts, because the second pass returns early.
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      // The spec is fetched here rather than handed to Swagger UI as a `url`
      // for three reasons: the request is unambiguously credentialed with the
      // admin's session cookie; the endpoint counts in the header come from the
      // same parse; and a 401/404/500 becomes a real message instead of
      // Swagger's opaque "Failed to load API definition".
      const res = await fetch('/api/admin/openapi', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && typeof body.error === 'string') detail = body.error;
        } catch {
          /* non-JSON error body — the status is all we have */
        }
        throw new Error(detail);
      }
      const spec = (await res.json()) as OpenApiSpec;
      setCounts(countOperations(spec));

      const { default: SwaggerUIBundle } = await import('swagger-ui-dist/swagger-ui-es-bundle.js');
      if (!containerRef.current) return;

      uiRef.current = SwaggerUIBundle({
        domNode: containerRef.current,
        spec,
        validatorUrl: null,
        // ~190 endpoints: everything collapsed, a filter box, and the models
        // section off by default, or the page is a wall of text.
        docExpansion: 'none',
        filter: true,
        defaultModelsExpandDepth: -1,
        deepLinking: true,
        tryItOutEnabled: true,
        // NOT persistAuthorization. Two reasons, in order: it would write the
        // raw `icrm_...` bearer key into localStorage, where it outlives the
        // tab and is readable by anything running on the origin — a poor trade
        // for saving one button click on a credential this page can re-mint.
        // And it does not even work for this flow: verified against
        // swagger-ui-dist 5.32, a key injected with preauthorizeApiKey is
        // authorized immediately but writes nothing to storage, so a reload
        // clears it either way. The copy in `generateHint` says so rather than
        // promising a persistence that never happened.
        displayRequestDuration: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
        // Auth mode 1: the admin's existing NextAuth session cookie rides along
        // on every "Try it out" request. See the header comment.
        withCredentials: true,
        requestInterceptor: (req: { credentials?: RequestCredentials }) => {
          req.credentials = 'same-origin';
          return req;
        },
      });
      setStatus('ready');
    })().catch((err: unknown) => {
      setLoadError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    });
  }, []);

  const generateKey = useCallback(async () => {
    setKeyBusy(true);
    setKeyError('');
    setCopied(false);
    setCopyFailed(false);
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const res = await fetch('/api/admin/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Swagger UI — ${stamp}` }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // Surfaced verbatim on purpose: on the public demo the middleware
        // refuses this route ("mints a real API credential"), and an unverified
        // admin gets the e-mail-verification 403. Both are worth reading.
        setKeyError(body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
        return;
      }
      setMinted({ id: String(body.id), name: String(body.name), raw: String(body.key) });
      // The no-copy-paste part: fill the Authorize dialog directly. If the spec
      // never loaded there is no dialog to fill — the key is still shown and
      // copyable, so mint it anyway rather than blocking the button.
      const ui = uiRef.current;
      if (ui?.preauthorizeApiKey) {
        // Called on the system object rather than as a detached function, and
        // the result is checked: Swagger UI returns null when the spec has no
        // `bearerApiKey` scheme, and a "filled the Authorize box" toast on top
        // of a silent no-op would be a lie.
        const filled = ui.preauthorizeApiKey('bearerApiKey', String(body.key)) !== null;
        if (filled) toast(t.apiExplorer.keyAuthorized);
      }
    } catch {
      setKeyError(t.apiExplorer.requestFailed);
    } finally {
      setKeyBusy(false);
    }
  }, [t, toast]);

  const copyKey = useCallback(async () => {
    if (!minted) return;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(minted.raw);
      setCopied(true);
      return;
    } catch {
      /* insecure context, or the permission was denied — fall back below */
    }
    // Fallback for browsers/contexts without the async clipboard API.
    try {
      const el = document.createElement('textarea');
      el.value = minted.raw;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      if (ok) {
        setCopied(true);
        return;
      }
    } catch {
      /* fall through to the "select it yourself" hint */
    }
    setCopyFailed(true);
  }, [minted]);

  const revokeKey = useCallback(async () => {
    if (!minted) return;
    setKeyBusy(true);
    setKeyError('');
    try {
      const res = await fetch(`/api/admin/api-keys?id=${encodeURIComponent(minted.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setKeyError(body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
        return;
      }
      setMinted(null);
      setCopied(false);
      setCopyFailed(false);
      toast(t.apiExplorer.revoked);
    } catch {
      setKeyError(t.apiExplorer.requestFailed);
    } finally {
      setKeyBusy(false);
      setConfirmRevoke(false);
    }
  }, [minted, t, toast]);

  return (
    <div>
      {/*
        Swagger UI ships one light stylesheet and no dark theme, so the widget is
        a deliberate light island in dark mode (see the copy in `themeNote`).
        The single thing that genuinely breaks is globals.css' native-control
        default (`html.dark input/select/textarea`), which would put a near-black
        field inside a white Swagger panel. These selectors repeat that rule's
        `:not()` chain with `.swagger-ui` added, so they outrank it on
        specificity rather than on source order. Kept local to this component so
        the shared stylesheet stays untouched; `style-src` allows 'unsafe-inline'.
      */}
      <style>{`
        html.dark .swagger-ui input:not([type='checkbox']):not([type='radio']):not([type='range']),
        html.dark .swagger-ui select,
        html.dark .swagger-ui textarea {
          background-color: #ffffff;
          color: #111827;
          border-color: #d1d5db;
        }
        html.dark .swagger-ui input::placeholder,
        html.dark .swagger-ui textarea::placeholder { color: #6b7280; }
        html.dark .swagger-ui option { background-color: #ffffff; color: #111827; }
      `}</style>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.apiExplorer.title}</h1>
        <p className="text-gray-500 mt-1">{t.apiExplorer.subtitle}</p>
      </div>

      <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
        <p data-testid="api-explorer-warning">{t.apiExplorer.warning}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <Card>
          <CardHeader><CardTitle>{t.apiExplorer.sessionMode}</CardTitle></CardHeader>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t.apiExplorer.sessionModeDesc}</p>
          <p className="text-xs text-gray-400 mt-2">{t.apiExplorer.unverifiedNote}</p>
          {counts && (
            <p data-testid="api-explorer-counts" className="text-xs text-gray-500 mt-3">
              {t.apiExplorer.endpoints
                .replace('{operations}', String(counts.operations))
                .replace('{paths}', String(counts.paths))}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <a href="/api/admin/openapi" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              {t.apiExplorer.rawSpecLink} →
            </a>
            <a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              {t.apiExplorer.publicSpecLink} →
            </a>
            <Link href="/admin/api-docs" className="text-blue-600 hover:underline">
              {t.apiExplorer.docsLink} →
            </Link>
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.apiExplorer.keyMode}</CardTitle></CardHeader>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t.apiExplorer.keyModeDesc}</p>
          <p className="text-xs text-gray-400 mt-2">{t.apiExplorer.generateHint}</p>

          {minted && (
            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              <p className="mb-2">{t.apiExplorer.keyOnce}</p>
              <code data-testid="api-explorer-key" className="block break-all font-mono">{minted.raw}</code>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={copyKey} data-testid="api-explorer-copy">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  <span className="ml-1.5">{copied ? t.apiExplorer.copied : t.apiExplorer.copy}</span>
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirmRevoke(true)} data-testid="api-explorer-revoke">
                  <Trash2 className="h-4 w-4" />
                  <span className="ml-1.5">{t.apiExplorer.revoke}</span>
                </Button>
              </div>
              {copyFailed && <p className="mt-2 text-amber-900">{t.apiExplorer.copyFailed}</p>}
            </div>
          )}

          {keyError && (
            <p data-testid="api-explorer-key-error" className="mt-3 text-sm text-red-600" role="alert">
              {keyError}
            </p>
          )}

          {!minted && (
            <Button
              className="mt-3"
              size="sm"
              onClick={generateKey}
              loading={keyBusy}
              disabled={status === 'loading'}
              data-testid="api-explorer-generate"
            >
              <KeyRound className="h-4 w-4" />
              <span className="ml-1.5">{keyBusy ? t.apiExplorer.generating : t.apiExplorer.generate}</span>
            </Button>
          )}
        </Card>
      </div>

      {status === 'loading' && (
        <Card>
          <p className="text-sm text-gray-500 mb-3">{t.apiExplorer.loading}</p>
          <SkeletonRows rows={8} />
        </Card>
      )}

      {status === 'error' && (
        <Card>
          <CardHeader><CardTitle>{t.apiExplorer.loadFailed}</CardTitle></CardHeader>
          <p className="text-sm text-red-600 break-words" role="alert">{loadError}</p>
          <p className="text-sm text-gray-500 mt-2">{t.apiExplorer.loadFailedHint}</p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <a href="/api/admin/openapi" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              {t.apiExplorer.rawSpecLink} →
            </a>
            <Link href="/admin/api-docs" className="text-blue-600 hover:underline">
              {t.apiExplorer.docsLink} →
            </Link>
          </div>
        </Card>
      )}

      <p className="text-xs text-gray-400 mb-2">{t.apiExplorer.themeNote}</p>
      {/*
        `dark:!bg-white` is required: globals.css retints `.bg-white` to #111827
        under html.dark, which would paint a dark ground behind Swagger's own
        white panels. `overflow-x-auto` keeps wide code samples inside the card
        instead of scrolling the page body.
      */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:!bg-white overflow-x-auto">
        <div ref={containerRef} data-testid="api-explorer-ui" />
      </div>

      <ConfirmDialog
        open={confirmRevoke}
        title={t.apiExplorer.revokeTitle}
        message={t.apiExplorer.revokeMessage}
        confirmLabel={t.apiExplorer.revokeConfirm}
        cancelLabel={t.apiExplorer.revokeCancel}
        variant="danger"
        loading={keyBusy}
        onConfirm={revokeKey}
        onCancel={() => setConfirmRevoke(false)}
      />
    </div>
  );
}
