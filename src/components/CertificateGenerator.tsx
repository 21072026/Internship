'use client';

import { useEffect, useState } from 'react';
import { Award, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import { templateToHtml } from '@/lib/renderTemplate';
import { useModalFocus } from '@/components/ui/useModalFocus';
import {
  buildCertificateBody,
  buildReferenceLetterBody,
  formatDuration,
  type CertificateVariant,
  type CertLocale,
} from '@/lib/certificateTemplates';

const LOCALES: CertLocale[] = ['en', 'tr', 'de'];

// Admin/mentor action on a completed internship (#813): preview an org-branded
// certificate or reference letter draft (auto-filled, freely editable), then
// generate the final PDF, stored as the mentee's CERTIFICATE Document.
export function CertificateGenerator({
  relationId,
  eligible,
  mentee,
  mentor,
  companyName,
  startDate,
  completedAt,
  onGenerated,
}: {
  relationId: string;
  eligible: boolean;
  mentee: { fullName: string; skills: string[] };
  mentor: { fullName: string };
  companyName: string | null;
  startDate: string;
  completedAt: string | null;
  onGenerated?: () => void;
}) {
  const t = useT();
  const c = t.certificate;
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<CertificateVariant>('CERTIFICATE');
  const [locale, setLocale] = useState<CertLocale>('en');
  const [start, setStart] = useState(startDate.slice(0, 10));
  const [end, setEnd] = useState((completedAt ?? new Date().toISOString()).slice(0, 10));
  const [skills, setSkills] = useState<string[]>(mentee.skills);
  const [body, setBody] = useState('');
  const [signatureName, setSignatureName] = useState(mentor.fullName);
  const [signatureTitle, setSignatureTitle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const dialogRef = useModalFocus<HTMLDivElement>(open, () => setOpen(false));

  // Regenerates the draft body from the current fields. Re-runs whenever the
  // structured inputs change — changing a field after hand-editing the body
  // will overwrite that edit, mirroring how switching a template resets its
  // preview elsewhere in the app (TemplatesLibrary).
  useEffect(() => {
    if (!open) return;
    const vars = {
      menteeName: mentee.fullName,
      mentorName: mentor.fullName,
      companyName,
      startDate: start,
      endDate: end,
      duration: formatDuration(start, end, locale),
      skills,
    };
    setBody(variant === 'CERTIFICATE' ? buildCertificateBody(vars, locale) : buildReferenceLetterBody(vars, locale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, variant, locale, start, end, skills]);

  const toggleSkill = (skill: string) => {
    setSkills((prev) => (prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]));
  };

  const generate = async () => {
    setGenerating(true);
    setError('');
    setSuccess(false);
    try {
      const res = await fetch(`/api/mentorship/${relationId}/certificate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, locale, body, signatureName, signatureTitle }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t.common.error);
      setSuccess(true);
      onGenerated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setGenerating(false);
    }
  };

  if (!eligible) return null;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="generate-certificate-button">
        <Award className="h-4 w-4" /> {c.action}
      </Button>

      {open && (
        <div
          ref={dialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={c.title}
          tabIndex={-1}
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
            data-testid="certificate-modal"
          >
            <div className="flex items-center gap-3 border-b border-gray-100 dark:border-gray-800 p-4">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 flex-1">{c.title}</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label={t.templatesLib.close} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="overflow-y-auto p-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
                  {(['CERTIFICATE', 'REFERENCE_LETTER'] as CertificateVariant[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      data-testid={v === 'CERTIFICATE' ? 'variant-certificate' : 'variant-reference'}
                      onClick={() => setVariant(v)}
                      aria-pressed={variant === v}
                      className={`px-2.5 py-1 text-xs rounded-md ${variant === v ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}
                    >
                      {v === 'CERTIFICATE' ? c.variantCertificate : c.variantReference}
                    </button>
                  ))}
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
                  {LOCALES.map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setLocale(l)}
                      aria-pressed={locale === l}
                      className={`px-2 py-1 text-xs rounded-md ${locale === l ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}
                    >
                      {l.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input label={c.startDate} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
                <Input label={c.endDate} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>

              {mentee.skills.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1.5">{c.skills}</p>
                  <div className="flex flex-wrap gap-2">
                    {mentee.skills.map((s) => (
                      <label key={s} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                        <input type="checkbox" checked={skills.includes(s)} onChange={() => toggleSkill(s)} />
                        {s}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{c.body}</label>
                <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} data-testid="certificate-body" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input label={c.signatureName} value={signatureName} onChange={(e) => setSignatureName(e.target.value)} />
                <Input label={c.signatureTitle} value={signatureTitle} onChange={(e) => setSignatureTitle(e.target.value)} placeholder={c.signatureTitlePlaceholder} />
              </div>

              <div>
                <p className="text-xs text-gray-500 mb-1.5">{c.preview}</p>
                <div
                  className="border border-gray-100 dark:border-gray-800 rounded-xl p-4 text-sm text-gray-800 dark:text-gray-200 leading-relaxed [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_ul]:list-disc [&_ul]:pl-5"
                  dangerouslySetInnerHTML={{ __html: templateToHtml(body) }}
                />
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
              {success && <p className="text-sm text-green-600" data-testid="certificate-generated">{c.success}</p>}
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-100 dark:border-gray-800 p-4">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t.common.cancel}</Button>
              <Button size="sm" onClick={generate} loading={generating} data-testid="generate-certificate-submit">{c.generate}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
