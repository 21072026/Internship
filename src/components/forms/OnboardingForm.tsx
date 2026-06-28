'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { CvManager } from '@/components/CvManager';
import { useT } from '@/i18n/client';

// Graduation-year bounds: allow well before 2020, cap at this year + 5.
const MIN_GRAD_YEAR = 2010;
const MAX_GRAD_YEAR = new Date().getFullYear() + 5;

const step1Schema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  phone: z.string().optional(),
});

const step2Schema = z.object({
  university: z.string().min(1, 'University is required'),
  department: z.string().min(1, 'Department is required'),
  graduationYear: z.coerce.number().int().min(MIN_GRAD_YEAR).max(MAX_GRAD_YEAR),
});

const step3Schema = z.object({
  skills: z.string().min(1, 'Please add at least one skill'),
  cvUrl: z.string().url('Please enter a valid URL').optional().or(z.literal('')),
});

type Step1Data = z.infer<typeof step1Schema>;
type Step2Data = z.infer<typeof step2Schema>;
type Step3Data = z.infer<typeof step3Schema>;


export function OnboardingForm() {
  const t = useT();
  const steps = [t.onboarding.personalInfo, t.onboarding.education, t.onboarding.skillsCv];
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [allData, setAllData] = useState<Partial<Step1Data & Step2Data & Step3Data>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState('');
  const [initialCv, setInitialCv] = useState<string | null>(null);

  const step1Form = useForm<Step1Data>({
    resolver: zodResolver(step1Schema),
    defaultValues: allData,
  });

  const step2Form = useForm<Step2Data>({
    resolver: zodResolver(step2Schema),
    defaultValues: allData,
  });

  const step3Form = useForm<Step3Data>({
    resolver: zodResolver(step3Schema),
    defaultValues: allData,
  });

  // Prefill from the user's existing profile (e.g. the full name they entered
  // at registration) so the wizard isn't blank.
  useEffect(() => {
    fetch('/api/profile')
      .then((r) => r.json())
      .then(({ user }) => {
        if (!user) return;
        setUserId(user.id);
        setInitialCv(user.cvUrl || null);
        const seed = {
          fullName: user.fullName || '',
          phone: user.phone || '',
          university: user.university || '',
          department: user.department || '',
          graduationYear: user.graduationYear || undefined,
          skills: Array.isArray(user.skills) ? user.skills.join(', ') : '',
          cvUrl: user.cvUrl || '',
        };
        setAllData(seed);
        step1Form.reset({ fullName: seed.fullName, phone: seed.phone });
        step2Form.reset({
          university: seed.university,
          department: seed.department,
          graduationYear: seed.graduationYear as number | undefined,
        });
        step3Form.reset({ skills: seed.skills, cvUrl: seed.cvUrl });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStep1 = step1Form.handleSubmit((data) => {
    setAllData((prev) => ({ ...prev, ...data }));
    setCurrentStep(1);
  });

  const handleStep2 = step2Form.handleSubmit((data) => {
    setAllData((prev) => ({ ...prev, ...data }));
    setCurrentStep(2);
  });

  const handleStep3 = step3Form.handleSubmit(async (data) => {
    const finalData = { ...allData, ...data };
    setLoading(true);
    setError('');

    try {
      const skillsArray = data.skills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...finalData, skills: skillsArray }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Failed to save profile');
      }

      router.push('/portal');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  });

  const graduationYearOptions = Array.from(
    { length: MAX_GRAD_YEAR - MIN_GRAD_YEAR + 1 },
    (_, i) => ({ value: String(MIN_GRAD_YEAR + i), label: String(MIN_GRAD_YEAR + i) })
  );

  return (
    <div className="w-full max-w-lg">
      {/* Progress */}
      <div className="mb-8">
        <div className="flex justify-between mb-2">
          {steps.map((step, idx) => (
            <div key={step} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                  idx < currentStep
                    ? 'bg-blue-600 text-white'
                    : idx === currentStep
                    ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                    : 'bg-gray-200 text-gray-500'
                }`}
              >
                {idx < currentStep ? '✓' : idx + 1}
              </div>
              {idx < steps.length - 1 && (
                <div
                  className={`h-1 w-16 sm:w-24 mx-1 rounded ${
                    idx < currentStep ? 'bg-blue-600' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between">
          {steps.map((step, idx) => (
            <span
              key={step}
              className={`text-xs ${idx === currentStep ? 'text-blue-600 font-medium' : 'text-gray-400'}`}
            >
              {step}
            </span>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Step 1 */}
      {currentStep === 0 && (
        <form onSubmit={handleStep1} className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">{t.onboarding.personalInformation}</h2>
          <Input
            label={t.onboarding.fullName}
            required
            {...step1Form.register('fullName')}
            error={step1Form.formState.errors.fullName?.message}
          />
          <Input
            label={t.onboarding.phone}
            type="tel"
            placeholder="+1 (555) 000-0000"
            {...step1Form.register('phone')}
            error={step1Form.formState.errors.phone?.message}
          />
          <Button type="submit" className="w-full" size="lg">
            {t.onboarding.continue}
          </Button>
        </form>
      )}

      {/* Step 2 */}
      {currentStep === 1 && (
        <form onSubmit={handleStep2} className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">{t.onboarding.educationDetails}</h2>
          <Input
            label={t.onboarding.university}
            required
            placeholder="e.g. MIT, Stanford, etc."
            {...step2Form.register('university')}
            error={step2Form.formState.errors.university?.message}
          />
          <Input
            label={t.onboarding.department}
            required
            placeholder="e.g. Computer Science"
            {...step2Form.register('department')}
            error={step2Form.formState.errors.department?.message}
          />
          <Select
            label={t.onboarding.graduationYear}
            required
            options={graduationYearOptions}
            placeholder="Select year"
            {...step2Form.register('graduationYear')}
            error={step2Form.formState.errors.graduationYear?.message}
          />
          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={() => setCurrentStep(0)} className="flex-1" size="lg">
              {t.onboarding.back}
            </Button>
            <Button type="submit" className="flex-1" size="lg">
              {t.onboarding.continue}
            </Button>
          </div>
        </form>
      )}

      {/* Step 3 */}
      {currentStep === 2 && (
        <form onSubmit={handleStep3} className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">{t.onboarding.skillsAndCv}</h2>
          <Input
            label={t.onboarding.skills}
            required
            placeholder="e.g. React, Python, Data Analysis"
            hint="Separate multiple skills with commas"
            {...step3Form.register('skills')}
            error={step3Form.formState.errors.skills?.message}
          />
          <Input
            label={t.onboarding.cvUrl}
            type="url"
            placeholder="https://drive.google.com/..."
            hint="Link to your CV (Google Drive, Dropbox, etc.)"
            {...step3Form.register('cvUrl')}
            error={step3Form.formState.errors.cvUrl?.message}
          />
          {userId && (
            <div className="border-t border-gray-100 pt-4">
              <CvManager targetUserId={userId} initialCvUrl={initialCv} />
            </div>
          )}
          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={() => setCurrentStep(1)} className="flex-1" size="lg">
              {t.onboarding.back}
            </Button>
            <Button type="submit" className="flex-1" size="lg" loading={loading}>
              {t.onboarding.complete}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
