'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import { TEXT_LIMITS } from '@/lib/textLimits';

const step1Schema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  bio: z.string().max(TEXT_LIMITS.bio).optional(),
});

const step2Schema = z.object({
  skills: z.string().optional(),
  interests: z.string().max(2000).optional(),
});

const step3Schema = z.object({
  mentorCapacity: z.coerce.number().int().min(0).max(100).optional(),
});

type Step1Data = z.infer<typeof step1Schema>;
type Step2Data = z.infer<typeof step2Schema>;
type Step3Data = z.infer<typeof step3Schema>;

interface Slot { id: string; weekday: number; startTime: string; endTime: string }

// Mentor-side onboarding wizard (#911): a 4-step version of the mentee
// OnboardingForm above, reusing the same progress/step-card shell but
// collecting mentor-specific fields (bio, skills, interests, capacity,
// availability) instead. Profile/expertise/capacity are saved together on
// Finish via PUT /api/profile, same as the mentee flow; availability slots
// are saved as they're added via the existing /api/availability endpoint.
export function MentorOnboardingForm() {
  const t = useT();
  const steps = [
    t.onboarding.mentor.stepProfile,
    t.onboarding.mentor.stepExpertise,
    t.onboarding.mentor.stepCapacity,
    t.onboarding.mentor.stepAvailability,
  ];
  const days = t.availability.days as string[];
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [allData, setAllData] = useState<Partial<Step1Data & Step2Data & Step3Data>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [slots, setSlots] = useState<Slot[]>([]);
  const [weekday, setWeekday] = useState('1');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [slotError, setSlotError] = useState('');
  const [savingSlot, setSavingSlot] = useState(false);

  const step1Form = useForm<Step1Data>({ resolver: zodResolver(step1Schema), defaultValues: allData });
  const step2Form = useForm<Step2Data>({ resolver: zodResolver(step2Schema), defaultValues: allData });
  const step3Form = useForm<Step3Data>({ resolver: zodResolver(step3Schema), defaultValues: allData });

  // Prefill from the existing profile, same pattern as the mentee form.
  useEffect(() => {
    Promise.all([
      fetch('/api/profile').then((r) => r.json()),
      fetch('/api/availability').then((r) => r.json()),
    ])
      .then(([profileBody, availabilityBody]) => {
        const user = profileBody.user;
        if (user) {
          const seed = {
            fullName: user.fullName || '',
            bio: user.bio || '',
            skills: Array.isArray(user.skills) ? user.skills.join(', ') : '',
            interests: user.interests || '',
            mentorCapacity: user.mentorCapacity ?? undefined,
          };
          setAllData(seed);
          step1Form.reset({ fullName: seed.fullName, bio: seed.bio });
          step2Form.reset({ skills: seed.skills, interests: seed.interests });
          step3Form.reset({ mentorCapacity: seed.mentorCapacity as number | undefined });
        }
        setSlots(availabilityBody.slots ?? []);
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

  const handleStep3 = step3Form.handleSubmit((data) => {
    setAllData((prev) => ({ ...prev, ...data }));
    setCurrentStep(3);
  });

  const saveProfile = async () => {
    const skillsArray = (allData.skills || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: allData.fullName,
        bio: allData.bio || '',
        skills: skillsArray,
        interests: allData.interests || '',
        mentorCapacity: allData.mentorCapacity ?? null,
      }),
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error || 'Failed to save profile');
    }
  };

  const addSlot = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSlot(true);
    setSlotError('');
    try {
      const res = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekday: Number(weekday), startTime, endTime }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to add slot');
      setSlots((prev) => [...prev, body.slot]);
    } catch (err) {
      setSlotError(err instanceof Error ? err.message : 'Failed to add slot');
    } finally {
      setSavingSlot(false);
    }
  };

  const finish = async () => {
    setLoading(true);
    setError('');
    try {
      await saveProfile();
      router.push('/mentor');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const skip = () => {
    router.push('/mentor');
  };

  return (
    <div className="w-full max-w-lg">
      {/* Progress */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <div className="flex justify-between flex-1">
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
                    className={`h-1 w-10 sm:w-16 mx-1 rounded ${
                      idx < currentStep ? 'bg-blue-600' : 'bg-gray-200'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={skip}
            data-testid="mentor-onboarding-skip"
            className="ml-4 text-sm text-gray-400 hover:text-gray-600 flex-shrink-0"
          >
            {t.onboarding.mentor.skip}
          </button>
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

      {/* Step 1: Profile */}
      {currentStep === 0 && (
        <form onSubmit={handleStep1} className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">{t.onboarding.mentor.stepProfile}</h2>
          <Input
            label={t.onboarding.fullName}
            required
            {...step1Form.register('fullName')}
            error={step1Form.formState.errors.fullName?.message}
          />
          <div>
            <label htmlFor="mentor-onboarding-bio" className="block text-sm font-medium text-gray-700 mb-1.5">{t.profileForm.bio}</label>
            <Textarea
              id="mentor-onboarding-bio"
              {...step1Form.register('bio')}
              rows={3}
              maxLength={TEXT_LIMITS.bio}
              showCounter
              placeholder={t.profileForm.bioHint}
            />
          </div>
          <Button type="submit" className="w-full" size="lg">
            {t.onboarding.continue}
          </Button>
        </form>
      )}

      {/* Step 2: Expertise */}
      {currentStep === 1 && (
        <form onSubmit={handleStep2} className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">{t.onboarding.mentor.stepExpertise}</h2>
          <Input
            label={t.onboarding.skills}
            placeholder="e.g. React, Python, Data Analysis"
            hint="Separate multiple skills with commas"
            {...step2Form.register('skills')}
            error={step2Form.formState.errors.skills?.message}
          />
          <Input
            label={t.profileForm.interests}
            placeholder={t.profileForm.interestsHint}
            {...step2Form.register('interests')}
            error={step2Form.formState.errors.interests?.message}
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

      {/* Step 3: Capacity */}
      {currentStep === 2 && (
        <form onSubmit={handleStep3} className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">{t.onboarding.mentor.stepCapacity}</h2>
          <Input
            label={t.profileForm.mentorCapacity}
            type="number"
            min={0}
            hint={t.profileForm.mentorCapacityHint}
            {...step3Form.register('mentorCapacity')}
            error={step3Form.formState.errors.mentorCapacity?.message}
          />
          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={() => setCurrentStep(1)} className="flex-1" size="lg">
              {t.onboarding.back}
            </Button>
            <Button type="submit" className="flex-1" size="lg">
              {t.onboarding.continue}
            </Button>
          </div>
        </form>
      )}

      {/* Step 4: Availability */}
      {currentStep === 3 && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">{t.onboarding.mentor.stepAvailability}</h2>
          {slotError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{slotError}</div>
          )}
          <form onSubmit={addSlot} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[120px]">
              <Select
                label={t.availability.day}
                value={weekday}
                onChange={(e) => setWeekday(e.target.value)}
                options={days.map((d, i) => ({ value: String(i), label: d }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.availability.from}</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.availability.to}</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <Button type="submit" variant="outline" loading={savingSlot}>
              {t.availability.add}
            </Button>
          </form>
          {slots.length > 0 && (
            <ul className="divide-y divide-gray-50 border border-gray-100 rounded-lg">
              {slots.map((s) => (
                <li key={s.id} className="px-3 py-2 text-sm text-gray-700">
                  <span className="font-medium text-gray-900">{days[s.weekday]}</span> · {s.startTime}–{s.endTime}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={() => setCurrentStep(2)} className="flex-1" size="lg">
              {t.onboarding.back}
            </Button>
            <Button type="button" onClick={finish} className="flex-1" size="lg" loading={loading} data-testid="mentor-onboarding-finish">
              {t.onboarding.mentor.finish}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
