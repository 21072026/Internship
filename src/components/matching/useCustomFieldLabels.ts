'use client';

import { useEffect, useState } from 'react';
import { useLocale } from '@/i18n/client';
import { localized } from '@/components/forms/FormFieldInput';
import type { LocalizedText } from '@/lib/forms/schema';

// The labels of the org's matchable admin-defined questions (#1803), so a
// `customField:<key>` dimension reads as its question, not its key. One fetch
// per page load, shared by every breakdown on the page; a reader without
// access (or a failed fetch) just gets an empty map and the readable fallback.

let pending: Promise<{ key: string; labels: LocalizedText }[]> | null = null;

function load() {
  pending ??= fetch('/api/admin/matching/custom-fields')
    .then((r) => (r.ok ? r.json() : { customFields: [] }))
    .then((d) => (Array.isArray(d.customFields) ? d.customFields : []))
    .catch(() => []);
  return pending;
}

/** `customField:<key>` → the question's label in the reader's language. */
export function useCustomFieldLabels(enabled: boolean): Record<string, string> {
  const locale = useLocale();
  const [fields, setFields] = useState<{ key: string; labels: LocalizedText }[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then((f) => live && setFields(f));
    return () => {
      live = false;
    };
  }, [enabled]);
  return Object.fromEntries(fields.map((f) => [`customField:${f.key}`, localized(f.labels, locale) || f.key]));
}

/** A key the label list does not know: `customField:target_industry` → "Target industry". */
export function humanizeCustomKey(dimension: string): string {
  const key = dimension.slice('customField:'.length).replace(/_/g, ' ');
  return key.charAt(0).toUpperCase() + key.slice(1);
}
