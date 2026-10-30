'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { interpolate } from '@/lib/notificationText';
import {
  LANDING_LIMITS,
  LANDING_LOCALES,
  type Landing,
  type LandingCopy,
  type LandingIssue,
  type LandingIssueCode,
  type LandingLocale,
  type LandingParagraphField,
  type LandingTextField,
} from '@/lib/affiliateLandingRule';

// The public programme page's content (#3359): copy per locale plus the contact
// details and the product's sign-up address. The server is the judge
// (parseLanding); this form only keeps what is typed and marks the fields the
// server names by their path (`copy.de.heroTitle`, `phone`, …).

type Section = { title: keyof Labels['sections']; fields: (LandingTextField | LandingParagraphField)[] };
type Labels = ReturnType<typeof useT>['affiliateSettings']['landing'];

const SECTIONS: Section[] = [
  { title: 'hero', fields: ['heroTitle', 'heroSubtitle', 'applyLabel', 'portalLabel', 'productSignupLabel', 'intro'] },
  { title: 'table', fields: ['tableTitle', 'tableCtaLabel'] },
  { title: 'steps', fields: ['stepsTitle'] },
  { title: 'contact', fields: ['contactTitle', 'contactText', 'callLabel'] },
  { title: 'cta', fields: ['ctaTitle', 'ctaText', 'ctaApplyLabel', 'ctaContactLabel'] },
];
const PARAGRAPHS: readonly string[] = ['intro', 'contactText', 'ctaText'];

interface Props {
  initial: Landing;
  readOnly: boolean;
  localeLabel: Record<LandingLocale, string>;
}

export function LandingSettings({ initial, readOnly, localeLabel }: Props) {
  const t = useT();
  const L = t.affiliateSettings.landing;
  const toast = useToast();
  const [copy, setCopy] = useState<Partial<Record<LandingLocale, LandingCopy>>>(initial.copy);
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [signupUrl, setSignupUrl] = useState(initial.productSignupUrl ?? '');
  const [lang, setLang] = useState<LandingLocale>('de');
  const [issues, setIssues] = useState<Map<string, LandingIssueCode>>(new Map());
  const [busy, setBusy] = useState(false);

  const c: LandingCopy = copy[lang] ?? {};
  const setC = (patch: Partial<LandingCopy>) => setCopy({ ...copy, [lang]: { ...c, ...patch } });
  const err = (path: string) => {
    const code = issues.get(path);
    return code ? L.errors[code] : undefined;
  };
  const langHasIssue = (l: LandingLocale) => [...issues.keys()].some((k) => k.startsWith(`copy.${l}`));

  async function save() {
    setBusy(true);
    setIssues(new Map());
    try {
      const res = await fetch('/api/admin/affiliate/settings/landing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ landing: { copy, phone, email, productSignupUrl: signupUrl } }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(body.changed ? L.saved : L.unchanged);
        const saved = body.landing as Landing;
        setCopy(saved.copy);
        setPhone(saved.phone ?? '');
        setEmail(saved.email ?? '');
        setSignupUrl(saved.productSignupUrl ?? '');
      } else if (body.code === 'invalid_landing') {
        setIssues(new Map((body.issues as LandingIssue[]).map((i) => [i.field, i.code])));
        toast(t.affiliateSettings.errorInvalid, 'error');
      } else toast(body.code === 'conflict' ? t.affiliateSettings.errorConflict : t.affiliateSettings.loadFailed, 'error');
    } finally {
      setBusy(false);
    }
  }

  const steps = c.steps ?? [];
  const bullets = c.bullets ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{L.title}</CardTitle>
        <p className="text-sm text-gray-600 dark:text-gray-400">{L.hint}</p>
      </CardHeader>
      <fieldset disabled={readOnly} className="space-y-6" data-testid="affiliate-landing">
        <div className="flex gap-2" role="group" aria-label={L.language}>
          {LANDING_LOCALES.map((l) => (
            <Button
              key={l}
              type="button"
              size="sm"
              variant={l === lang ? 'primary' : 'outline'}
              aria-pressed={l === lang}
              onClick={() => setLang(l)}
              data-testid={`affiliate-landing-lang-${l}`}
            >
              {localeLabel[l]}
              {langHasIssue(l) && <span className="ml-1 text-red-600" aria-label={t.affiliateSettings.errorInvalid}>•</span>}
            </Button>
          ))}
        </div>

        {SECTIONS.map((section) => (
          <div key={section.title} className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{L.sections[section.title]}</h3>
            {section.fields.map((f) =>
              PARAGRAPHS.includes(f) ? (
                <label key={f} className="block space-y-1">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{L.fields[f]}</span>
                  <Textarea
                    rows={3}
                    lang={lang}
                    maxLength={LANDING_LIMITS.paragraph}
                    value={c[f] ?? ''}
                    onChange={(e) => setC({ [f]: e.target.value })}
                    data-testid={`affiliate-landing-${f}`}
                  />
                  {err(`copy.${lang}.${f}`) && <span className="text-sm text-red-600">{err(`copy.${lang}.${f}`)}</span>}
                </label>
              ) : (
                <Input
                  key={f}
                  label={L.fields[f]}
                  lang={lang}
                  maxLength={LANDING_LIMITS.text}
                  value={c[f] ?? ''}
                  error={err(`copy.${lang}.${f}`)}
                  onChange={(e) => setC({ [f]: e.target.value })}
                  data-testid={`affiliate-landing-${f}`}
                />
              ),
            )}

            {section.title === 'steps' && (
              <div className="space-y-3">
                {steps.map((step, i) => (
                  <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] items-end gap-2" data-testid={`affiliate-landing-step-${i}`}>
                    <Input
                      label={interpolate(L.stepTitle, { n: String(i + 1) })}
                      lang={lang}
                      maxLength={LANDING_LIMITS.stepTitle}
                      value={step.title}
                      error={err(`copy.${lang}.steps.${i}.title`)}
                      onChange={(e) => setC({ steps: steps.map((s, j) => (j === i ? { ...s, title: e.target.value } : s)) })}
                    />
                    <Input
                      label={interpolate(L.stepText, { n: String(i + 1) })}
                      lang={lang}
                      maxLength={LANDING_LIMITS.stepText}
                      value={step.text}
                      error={err(`copy.${lang}.steps.${i}.text`)}
                      onChange={(e) => setC({ steps: steps.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)) })}
                    />
                    <Button type="button" variant="ghost" onClick={() => setC({ steps: steps.filter((_, j) => j !== i) })}>
                      {L.remove}
                    </Button>
                  </div>
                ))}
                {err(`copy.${lang}.steps`) && <p className="text-sm text-red-600">{err(`copy.${lang}.steps`)}</p>}
                {steps.length < LANDING_LIMITS.steps && (
                  <Button type="button" variant="outline" onClick={() => setC({ steps: [...steps, { title: '', text: '' }] })} data-testid="affiliate-landing-add-step">
                    {L.addStep}
                  </Button>
                )}
              </div>
            )}

            {section.title === 'cta' && (
              <div className="space-y-3">
                {bullets.map((b, i) => (
                  <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_auto] items-end gap-2">
                    <Input
                      label={interpolate(L.bullet, { n: String(i + 1) })}
                      lang={lang}
                      maxLength={LANDING_LIMITS.bullet}
                      value={b}
                      error={err(`copy.${lang}.bullets.${i}`)}
                      onChange={(e) => setC({ bullets: bullets.map((x, j) => (j === i ? e.target.value : x)) })}
                    />
                    <Button type="button" variant="ghost" onClick={() => setC({ bullets: bullets.filter((_, j) => j !== i) })}>
                      {L.remove}
                    </Button>
                  </div>
                ))}
                {bullets.length < LANDING_LIMITS.bullets && (
                  <Button type="button" variant="outline" onClick={() => setC({ bullets: [...bullets, ''] })}>
                    {L.addBullet}
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}

        <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{L.sections.shared}</h3>
          <Input label={L.phone} hint={L.phoneHint} type="tel" value={phone} error={err('phone')} onChange={(e) => setPhone(e.target.value)} data-testid="affiliate-landing-phone" />
          <Input label={L.email} hint={L.emailHint} type="email" value={email} error={err('email')} onChange={(e) => setEmail(e.target.value)} data-testid="affiliate-landing-email" />
          <Input
            label={L.productSignupUrl}
            hint={L.productSignupUrlHint}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={signupUrl}
            error={err('productSignupUrl')}
            onChange={(e) => setSignupUrl(e.target.value)}
            data-testid="affiliate-landing-signup-url"
          />
        </div>

        {!readOnly && (
          <Button type="button" onClick={() => void save()} disabled={busy} data-testid="affiliate-save-landing">
            {L.save}
          </Button>
        )}
      </fieldset>
    </Card>
  );
}
