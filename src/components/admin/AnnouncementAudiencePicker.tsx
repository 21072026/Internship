'use client';

import { useEffect, useState } from 'react';
import { useT, useLocale } from '@/i18n/client';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { AUDIENCE_ROLES, type Audience } from '@/lib/announcementAudience';

type Option = { id: string; name: string };
type Options = { cohorts: Option[]; companies: Option[]; tags: Option[]; stages: { key: string; label: string }[] };
type ListKey = 'cohortIds' | 'stages' | 'companyIds' | 'tagIds';

// The announcement composer's audience picker (#1721). It edits CRITERIA —
// the server resolves who matches, at send time — and shows how many people
// they reach right now through the same functions the send uses
// (POST /api/admin/announcements/estimate).
export function AnnouncementAudiencePicker({ value, onChange }: { value: Audience; onChange: (next: Audience) => void }) {
  const t = useT();
  const a = t.announcements;
  const locale = useLocale();
  const [options, setOptions] = useState<Options | null>(null);
  const [estimate, setEstimate] = useState<{ recipients: number; emailable: number } | null>(null);

  useEffect(() => {
    fetch(`/api/admin/announcements/estimate?locale=${locale}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setOptions(d))
      .catch(() => {});
  }, [locale]);

  useEffect(() => {
    const id = setTimeout(() => {
      fetch('/api/admin/announcements/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience: value }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setEstimate(d))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(id);
  }, [value]);

  const toggle = <K extends keyof Audience>(key: K, item: string) => {
    const current = (value[key] ?? []) as string[];
    const next = current.includes(item) ? current.filter((x) => x !== item) : [...current, item];
    const out = { ...value, [key]: next } as Audience;
    if (next.length === 0) delete out[key];
    onChange(out);
  };

  const list = (key: ListKey, title: string, items: { id: string; label: string }[]) =>
    items.length === 0 ? null : (
      <fieldset className="min-w-0">
        <legend className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">{title}</legend>
        <div className="max-h-32 space-y-0.5 overflow-y-auto rounded border border-gray-200 p-1.5 dark:border-gray-700" data-testid={`audience-${key}`}>
          {items.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={((value[key] ?? []) as string[]).includes(o.id)} onChange={() => toggle(key, o.id)} />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );

  const roleLabels = t.documentRequirements.roles as Record<string, string>;

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="announcement-audience">
      <div className="text-sm font-medium text-gray-700 dark:text-gray-200">{a.audienceTitle}</div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{a.audienceHint}</p>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">{a.audienceRoles}</legend>
        <div className="flex flex-wrap gap-3">
          {AUDIENCE_ROLES.map((r) => (
            <label key={r} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={(value.roles ?? []).includes(r)} onChange={() => toggle('roles', r)} data-testid={`audience-role-${r}`} />
              {roleLabels[r] ?? r}
            </label>
          ))}
        </div>
      </fieldset>
      {options && (
        <div className="grid gap-3 sm:grid-cols-2">
          {list('cohortIds', a.audienceCohorts, options.cohorts.map((o) => ({ id: o.id, label: o.name })))}
          {list('stages', a.audienceStages, options.stages.map((s) => ({ id: s.key, label: s.label })))}
          {list('companyIds', a.audienceCompanies, options.companies.map((o) => ({ id: o.id, label: o.name })))}
          {list('tagIds', a.audienceTags, options.tags.map((o) => ({ id: o.id, label: o.name })))}
        </div>
      )}
      <p className="text-sm text-gray-700 dark:text-gray-200" role="status" data-testid="audience-estimate">
        {Object.keys(value).length === 0 ? `${a.audienceEveryone}. ` : ''}
        {estimate ? fillTemplate(a.audienceEstimate, { n: String(estimate.recipients), m: String(estimate.emailable) }) : null}
      </p>
    </div>
  );
}
