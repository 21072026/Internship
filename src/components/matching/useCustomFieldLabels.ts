'use client';

import { useEffect, useState } from 'react';
import { useLocale } from '@/i18n/client';
import { localized } from '@/components/forms/FormFieldInput';
import type { LocalizedText } from '@/lib/forms/schema';

// The labels of the org's matchable admin-defined questions (#1803), so a
// `customField:<key>` dimension reads as its question, not its key. One fetch
// per page load, shared by every breakdown on the page; a reader without
// access (or a failed fetch) just gets an empty map and the readable fallback.

// The org attributes (#3424) ride on the same fetch: `attribute:<key>` reads
// as the attribute's own label, in the reader's language.

type Labelled = { key: string; labels: LocalizedText };
let pending: Promise<{ customFields: Labelled[]; attributes: Labelled[] }> | null = null;

function load() {
  pending ??= fetch('/api/admin/matching/custom-fields')
    .then((r) => (r.ok ? r.json() : {}))
    .then((d: { customFields?: unknown; attributes?: unknown }) => ({
      customFields: Array.isArray(d.customFields) ? (d.customFields as Labelled[]) : [],
      attributes: Array.isArray(d.attributes) ? (d.attributes as Labelled[]) : [],
    }))
    .catch(() => ({ customFields: [], attributes: [] }));
  return pending;
}

/** `customField:<key>` / `attribute:<key>` → its label in the reader's language. */
export function useCustomFieldLabels(enabled: boolean): Record<string, string> {
  const locale = useLocale();
  const [labels, setLabels] = useState<{ customFields: Labelled[]; attributes: Labelled[] }>({ customFields: [], attributes: [] });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then((f) => live && setLabels(f));
    return () => {
      live = false;
    };
  }, [enabled]);
  return Object.fromEntries([
    ...labels.customFields.map((f) => [`customField:${f.key}`, localized(f.labels, locale) || f.key]),
    ...labels.attributes.map((a) => [`attribute:${a.key}`, localized(a.labels, locale) || a.key]),
  ]);
}

/** A key the label list does not know: `customField:target_industry` → "Target industry". */
export function humanizeCustomKey(dimension: string): string {
  const key = dimension.slice(dimension.indexOf(':') + 1).replace(/_/g, ' ');
  return key.charAt(0).toUpperCase() + key.slice(1);
}
