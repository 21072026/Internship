'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useT } from '@/i18n/client';

// Self-service SSO onboarding inside the Enterprise SSO card (#1933): the
// stored certificate's expiry badge, the IdP-metadata import and "Test
// connection". The import only PREVIEWS — "Use these values" fills the card's
// fields, and the admin's Save goes through the one validated write path
// (PATCH /api/admin/organizations), so nothing here writes the trust anchor.

export type CertificateSummary =
  | null
  | { invalid: true }
  | { invalid: false; notAfter: string; status: 'valid' | 'expiring' | 'expired'; daysLeft: number };

const fmtDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function SsoCertificateBadge({ certificate }: { certificate: CertificateSummary }) {
  const t = useT();
  if (!certificate) return null;
  const o = t.organizations;
  let text: string;
  let tone: string;
  if (certificate.invalid) {
    text = o.ssoCertBadgeInvalid;
    tone = 'bg-red-100 text-red-800';
  } else if (certificate.status === 'expired') {
    text = o.ssoCertBadgeExpired.replace('{date}', fmtDate(certificate.notAfter));
    tone = 'bg-red-100 text-red-800';
  } else if (certificate.status === 'expiring') {
    text = o.ssoCertBadgeExpiring
      .replace('{days}', String(certificate.daysLeft))
      .replace('{date}', fmtDate(certificate.notAfter));
    tone = 'bg-amber-100 text-amber-800';
  } else {
    text = o.ssoCertBadgeValid.replace('{date}', fmtDate(certificate.notAfter));
    tone = 'bg-green-100 text-green-800';
  }
  return (
    <span
      data-testid="sso-cert-badge"
      data-status={certificate.invalid ? 'invalid' : certificate.status}
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      {text}
    </span>
  );
}

export interface ImportedIdp {
  ssoProvider: string;
  ssoIssuer: string;
  ssoEntryPoint: string;
  ssoCertificate: string | null;
}

interface Preview extends ImportedIdp {
  sloUrl: string | null;
  certificates: {
    chosen: boolean;
    fingerprintSha256: string | null;
    notAfter: string | null;
    status: 'valid' | 'expiring' | 'expired' | null;
    daysLeft: number | null;
  }[];
}

export function SsoMetadataImport({ orgId, onApply }: { orgId: string; onApply: (v: ImportedIdp) => void }) {
  const t = useT();
  const o = t.organizations;
  const [xml, setXml] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState(false);

  const read = async (body: { xml: string } | { url: string }) => {
    setBusy(true);
    setError('');
    setPreview(null);
    setApplied(false);
    try {
      const res = await fetch(`/api/admin/organizations/${encodeURIComponent(orgId)}/sso/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setPreview(data.preview);
      else setError((o.ssoImportErrors as Record<string, string>)[data.code] ?? data.error ?? t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setXml(text);
    await read({ xml: text });
  };

  const chosen = preview?.certificates.find((c) => c.chosen);
  return (
    <div data-testid="sso-metadata-import" className="rounded-lg border border-gray-200 p-3 space-y-2">
      <p className="text-sm font-medium text-gray-700">{o.ssoImportTitle}</p>
      <p className="text-xs text-gray-500">{o.ssoImportHint}</p>
      <textarea
        data-testid="sso-metadata-xml"
        aria-label={o.ssoImportXml}
        value={xml}
        onChange={(e) => setXml(e.target.value)}
        rows={3}
        placeholder="<md:EntityDescriptor …>"
        className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" loading={busy} disabled={!xml.trim()} onClick={() => read({ xml })} data-testid="sso-metadata-read">
          {o.ssoImportRead}
        </Button>
        <label className="text-sm text-blue-700 cursor-pointer">
          {o.ssoImportFile}
          <input type="file" accept=".xml,application/xml,text/xml" className="sr-only" data-testid="sso-metadata-file" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[220px]">
          <Input label={o.ssoImportUrl} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://idp.example.com/metadata" data-testid="sso-metadata-url" />
        </div>
        <Button type="button" variant="outline" loading={busy} disabled={!url.trim()} onClick={() => read({ url })} data-testid="sso-metadata-fetch">
          {o.ssoImportRead}
        </Button>
      </div>
      {error && <p className="text-sm text-red-700" data-testid="sso-metadata-error">{error}</p>}
      {preview && (
        <div data-testid="sso-metadata-preview" className="rounded-lg bg-gray-50 p-3 text-sm space-y-1">
          <p className="font-medium text-gray-700">{o.ssoImportPreview}</p>
          <p><span className="text-gray-500">{o.ssoIssuer}:</span> <span className="break-all font-mono text-xs">{preview.ssoIssuer}</span></p>
          <p><span className="text-gray-500">{o.ssoEntryPoint}:</span> <span className="break-all font-mono text-xs">{preview.ssoEntryPoint}</span></p>
          {chosen?.fingerprintSha256 && (
            <p><span className="text-gray-500">SHA-256:</span> <span className="break-all font-mono text-xs">{chosen.fingerprintSha256}</span></p>
          )}
          {chosen?.notAfter && chosen.status && (
            <SsoCertificateBadge certificate={{ invalid: false, notAfter: chosen.notAfter, status: chosen.status, daysLeft: chosen.daysLeft ?? 0 }} />
          )}
          {preview.certificates.length > 1 && (
            <p className="text-xs text-gray-500">{o.ssoImportCertCount.replace('{count}', String(preview.certificates.length))}</p>
          )}
          <div className="pt-1">
            <Button
              type="button"
              data-testid="sso-metadata-apply"
              onClick={() => {
                onApply(preview);
                setApplied(true);
              }}
            >
              {o.ssoImportApply}
            </Button>
          </div>
          {applied && <p className="text-xs text-gray-600" data-testid="sso-metadata-applied">{o.ssoImportApplied}</p>}
        </div>
      )}
    </div>
  );
}

interface TestResult {
  ok: boolean;
  checks: { check: string; ok: boolean; detail?: string }[];
}

export function SsoTestConnection({ orgId }: { orgId: string }) {
  const t = useT();
  const o = t.organizations;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(`/api/admin/organizations/${encodeURIComponent(orgId)}/sso/test`, { method: 'POST' });
      if (res.ok) setResult(await res.json());
      else setError(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const labels = o.ssoTestChecks as Record<string, string>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" loading={busy} onClick={run} data-testid="sso-test-connection">
          {o.ssoTest}
        </Button>
        <span className="text-xs text-gray-500">{o.ssoTestHint}</span>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {result && (
        <div data-testid="sso-test-result" data-ok={String(result.ok)} className="text-sm">
          <p className={result.ok ? 'text-green-700' : 'text-red-700'}>{result.ok ? o.ssoTestPassed : o.ssoTestFailed}</p>
          <ul className="mt-1 space-y-0.5">
            {result.checks.map((c) => (
              <li key={c.check} data-testid={`sso-test-${c.check}`} data-ok={String(c.ok)}>
                {c.ok ? '✓' : '✗'} {labels[c.check] ?? c.check}
                {c.detail && <span className="text-xs text-gray-500"> — {c.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
