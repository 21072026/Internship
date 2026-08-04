'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { GraduationCap, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT, useLocale } from '@/i18n/client';
import { TEXT_LIMITS } from '@/lib/textLimits';

const applyMentorSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  expertise: z.string().min(1),
  experience: z.string().max(TEXT_LIMITS.mentorApplicationExperience).optional(),
  motivation: z.string().max(TEXT_LIMITS.mentorApplicationMotivation).optional(),
  capacity: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal('')),
  consent: z.literal(true, { errorMap: () => ({ message: 'Consent is required' }) }),
});

type ApplyMentorData = z.infer<typeof applyMentorSchema>;

export default function ApplyAsMentorPage() {
  const t = useT();
  const locale = useLocale();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ApplyMentorData>({ resolver: zodResolver(applyMentorSchema) });

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/mentor-applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: data.fullName,
          email: data.email,
          phone: data.phone || undefined,
          expertise: data.expertise,
          experience: data.experience || undefined,
          motivation: data.motivation || undefined,
          capacity: data.capacity ? Number(data.capacity) : undefined,
          linkedinUrl: data.linkedinUrl || undefined,
          locale,
        }),
      });

      // 409 (a pending application already exists for this email) and 429
      // (rate limited) both need a message distinct from a generic failure —
      // the same neutral `{ ok: true }` the API returns for an email tied to
      // an existing account, so there is nothing special to branch on there.
      if (res.status === 409) {
        setError(t.applyMentor.duplicateError);
        return;
      }
      if (res.status === 429) {
        setError(t.applyMentor.rateLimitError);
        return;
      }
      if (!res.ok) throw new Error('Failed');

      setDone(true);
    } catch {
      setError(t.applyMentor.genericError);
    } finally {
      setLoading(false);
    }
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="flex justify-center mb-6">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center">
            <GraduationCap className="h-8 w-8 text-white" />
          </div>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 sm:p-8">
          {done ? (
            <div className="text-center" data-testid="apply-mentor-success">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-3" />
              <h1 className="text-xl font-bold text-gray-900 mb-1">{t.applyMentor.thanksTitle}</h1>
              <p className="text-gray-500 text-sm">{t.applyMentor.thanksBody}</p>
              <p className="text-gray-400 text-xs mt-3">{t.applyMentor.noAccountYet}</p>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900 text-center">{t.applyMentor.title}</h1>
              <p className="text-gray-500 mt-1 mb-6 text-center">{t.applyMentor.subtitle}</p>
              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {error}
                </div>
              )}
              <form onSubmit={onSubmit} className="space-y-4" noValidate>
                <Input
                  label={t.applyMentor.fullName}
                  required
                  autoComplete="name"
                  {...register('fullName')}
                  error={errors.fullName ? t.applyMentor.fullNameRequired : undefined}
                />
                <Input
                  label={t.applyMentor.email}
                  type="email"
                  required
                  autoComplete="email"
                  {...register('email')}
                  error={errors.email ? t.applyMentor.emailInvalid : undefined}
                />
                <Input label={t.applyMentor.phone} type="tel" autoComplete="tel" {...register('phone')} />
                <Input
                  label={t.applyMentor.expertise}
                  required
                  placeholder="React, Node.js, Product Management…"
                  hint={t.applyMentor.expertiseHint}
                  {...register('expertise')}
                  error={errors.expertise ? t.applyMentor.expertiseRequired : undefined}
                />
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    {t.applyMentor.experience}
                  </label>
                  <Textarea rows={3} maxLength={TEXT_LIMITS.mentorApplicationExperience} showCounter {...register('experience')} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    {t.applyMentor.motivation}
                  </label>
                  <Textarea rows={3} maxLength={TEXT_LIMITS.mentorApplicationMotivation} showCounter {...register('motivation')} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input label={t.applyMentor.capacity} type="number" min={1} step={1} {...register('capacity')} />
                  <Input
                    label={t.applyMentor.linkedinUrl}
                    type="url"
                    placeholder="https://linkedin.com/in/…"
                    {...register('linkedinUrl')}
                    error={errors.linkedinUrl ? t.applyMentor.linkedinInvalid : undefined}
                  />
                </div>
                <label className="flex items-start gap-2 text-xs text-gray-600">
                  <input type="checkbox" className="mt-0.5" {...register('consent')} />
                  <span>
                    {t.applyMentor.consentNote}{' '}
                    <Link href="/privacy" className="text-blue-600 hover:underline">{t.applyMentor.privacyLink}</Link>
                    {' '}&{' '}
                    <Link href="/terms" className="text-blue-600 hover:underline">{t.applyMentor.termsLink}</Link>
                  </span>
                </label>
                {errors.consent && <p className="text-xs text-red-600">{t.applyMentor.consentRequired}</p>}
                <Button type="submit" className="w-full" size="lg" loading={loading}>
                  {t.applyMentor.submit}
                </Button>
              </form>
            </>
          )}
        </div>

        <div className="flex items-center justify-center gap-4 mt-6">
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">
            {t.applyMentor.backHome}
          </Link>
          <LanguageSwitcher current={locale} />
        </div>
      </div>
    </div>
  );
}
