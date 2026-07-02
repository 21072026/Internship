'use client';

import { useState } from 'react';
import { FileText, Mail, ClipboardList, CheckSquare, Eye, Download, Printer, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT, useLocale } from '@/i18n/client';
import { TEMPLATES, type DocTemplate, type TemplateLocale } from '@/lib/templates';
import { templateToHtml, templateToText } from '@/lib/renderTemplate';

const ICONS: Record<string, typeof FileText> = { FileText, Mail, ClipboardList, CheckSquare };
const LOCALES: TemplateLocale[] = ['en', 'tr', 'de'];
const LOCALE_LABEL: Record<TemplateLocale, string> = { en: 'EN', tr: 'TR', de: 'DE' };

// Print-optimised stylesheet for the "Save as PDF" window. Inlined so the popup
// is fully self-contained (no app CSS, no external requests — Docker-safe PDF).
const PRINT_CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111827; margin: 0; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 40px; line-height: 1.55; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  h2 { font-size: 16px; margin: 22px 0 6px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 16px 0 4px; }
  p { margin: 6px 0; }
  ul { margin: 6px 0; padding-left: 22px; }
  li { margin: 3px 0; }
  li.task { list-style: none; margin-left: -22px; }
  .cb { display: inline-block; width: 16px; }
  @page { margin: 18mm; }
`;

function download(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function printPdf(title: string, bodyHtml: string) {
  const w = window.open('', '_blank', 'width=820,height=1040');
  if (!w) return;
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>${PRINT_CSS}</style></head><body><main>${bodyHtml}</main>` +
    `<script>window.onload=function(){setTimeout(function(){window.focus();window.print();},150);};<\/script>` +
    `</body></html>`,
  );
  w.document.close();
}

// Multilingual document templates with in-app preview and PDF / TXT / Markdown
// export. Replaces the old single-language, download-only template list.
export function TemplatesLibrary() {
  const t = useT();
  const locale = useLocale() as TemplateLocale;
  const base: TemplateLocale = (['en', 'tr', 'de'].includes(locale) ? locale : 'en') as TemplateLocale;
  const [active, setActive] = useState<DocTemplate | null>(null);
  const [lang, setLang] = useState<TemplateLocale>(base);

  const open = (tpl: DocTemplate) => { setLang(base); setActive(tpl); };
  const tl = t.templatesLib;

  return (
    <Card>
      <CardHeader><CardTitle>{t.documents.curatedTitle}</CardTitle></CardHeader>

      <div className="divide-y divide-gray-50">
        {TEMPLATES.map((tpl) => {
          const Icon = ICONS[tpl.icon] ?? FileText;
          return (
            <div key={tpl.id} data-testid={`tpl-${tpl.id}`} className="flex items-center gap-3 py-2.5">
              <Icon className="h-5 w-5 text-gray-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-800 truncate">{tpl.title[base]}</p>
                <p className="text-xs text-gray-400 truncate">{tpl.summary[base]}</p>
              </div>
              <button
                type="button"
                onClick={() => open(tpl)}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Eye className="h-4 w-4" /> {tl.preview}
              </button>
            </div>
          );
        })}
      </div>

      {active && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={active.title[lang]}
          onClick={() => setActive(null)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-gray-100 dark:border-gray-800 p-4">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 flex-1 truncate">{active.title[lang]}</h2>
              <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
                {LOCALES.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    aria-pressed={lang === l}
                    className={`px-2 py-1 text-xs rounded-md ${lang === l ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}
                  >
                    {LOCALE_LABEL[l]}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setActive(null)} aria-label={tl.close} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="overflow-y-auto p-6">
              <div
                className="tpl-preview text-sm text-gray-800 dark:text-gray-200 leading-relaxed [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-1 [&_h2]:border-b [&_h2]:border-gray-100 dark:[&_h2]:border-gray-800 [&_h2]:pb-1 [&_h3]:font-semibold [&_h3]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-1.5 [&_li]:my-0.5 [&_li.task]:list-none [&_li.task]:-ml-6 [&_p]:my-1.5"
                dangerouslySetInnerHTML={{ __html: templateToHtml(active.body[lang]) }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 dark:border-gray-800 p-4">
              <button
                type="button"
                onClick={() => download(`${active.id}-${lang}.txt`, templateToText(active.body[lang]), 'text/plain;charset=utf-8')}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Download className="h-4 w-4" /> {tl.txt}
              </button>
              <button
                type="button"
                onClick={() => download(`${active.id}-${lang}.md`, active.body[lang], 'text/markdown;charset=utf-8')}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Download className="h-4 w-4" /> {tl.md}
              </button>
              <button
                type="button"
                onClick={() => printPdf(active.title[lang], templateToHtml(active.body[lang]))}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                <Printer className="h-4 w-4" /> {tl.pdf}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
