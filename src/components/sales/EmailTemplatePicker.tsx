'use client';

import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { emailTemplateMailto, templatePreview, type EmailTemplateVars, type MessageTemplateDto } from '@/lib/messageTemplates';

// E-mail templates beside a lead's address (#3908). The rep picks one and the
// address link becomes a `mailto:` with the subject and text filled in, in the
// rep's own language, placeholders filled from the lead — their own mail
// program still does the sending (#3741). The pool is the org's
// `MessageTemplate` rows of channel 'email' (GET /api/message-templates is
// tenant-scoped), managed on /admin/message-templates. No template, no picker.

export function useEmailTemplates(enabled: boolean): MessageTemplateDto[] {
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch('/api/message-templates?channel=email')
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d) => alive && setTemplates(d.templates ?? []))
      .catch(() => alive && setTemplates([]));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return templates;
}

export function EmailTemplatePicker({
  templates,
  value,
  onChange,
}: {
  templates: MessageTemplateDto[];
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  if (templates.length === 0) return null;
  return (
    <select
      aria-label={t.sales.lead.emailTemplate}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 block w-full max-w-xs rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
      data-testid="sales-lead-email-template"
    >
      <option value="">{t.sales.lead.emailTemplateNone}</option>
      {templates.map((tpl) => (
        <option key={tpl.id} value={tpl.id}>
          {templatePreview(tpl.subjects[locale] ?? tpl.subjects.en ?? Object.values(tpl.subjects)[0] ?? tpl.title, 60)}
        </option>
      ))}
    </select>
  );
}

/** The address link's target: the picked template's `mailto:`, else the bare address. */
export function emailHref(to: string, template: MessageTemplateDto | undefined, locale: string, vars: EmailTemplateVars): string {
  return template ? emailTemplateMailto(to, template, locale, vars) : `mailto:${to}`;
}
