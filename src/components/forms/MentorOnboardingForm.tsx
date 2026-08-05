'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';

interface Slot { weekday: number; startTime: string; endTime: string }

export function MentorOnboardingForm() {
  const t = useT();
  const m = t.mentorOnboarding;
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [bio, setBio] = useState('');
  const [interests, setInterests] = useState('');
  const [skills, setSkills] = useState('');
  const [capacity, setCapacity] = useState('');
  const [slots, setSlots] = useState<Slot[]>([{ weekday: 1, startTime: '09:00', endTime: '10:00' }]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const stepLabels = [m.profileStep, m.expertiseStep, m.capacityStep, m.availabilityStep];
  const days = t.availability.days as string[];

  useEffect(() => {
    fetch('/api/profile')
      .then((res) => res.json())
      .then(({ user }) => {
        if (!user) return;
        setBio(user.bio || '');
        setInterests(user.interests || '');
        setSkills(Array.isArray(user.skills) ? user.skills.join(', ') : '');
        setCapacity(user.mentorCapacity == null ? '' : String(user.mentorCapacity));
      })
      .catch(() => {});
  }, []);

  const next = () => {
    setError('');
    if (step === 0 && !bio.trim()) return setError(m.bioRequired);
    if (step === 1 && (!interests.trim() || !skills.split(',').some((value) => value.trim()))) return setError(m.expertiseRequired);
    if (step === 2 && (capacity === '' || !Number.isInteger(Number(capacity)) || Number(capacity) < 0 || Number(capacity) > 100)) return setError(m.capacityRequired);
    setStep((value) => Math.min(3, value + 1));
  };

  const updateSlot = (index: number, patch: Partial<Slot>) => {
    setSlots((current) => current.map((slot, slotIndex) => slotIndex === index ? { ...slot, ...patch } : slot));
  };

  const finish = async () => {
    setError('');
    if (slots.length === 0) return setError(m.slotRequired);
    if (slots.some((slot) => slot.endTime <= slot.startTime)) return setError(m.invalidTime);
    const slotKeys = slots.map((slot) => `${slot.weekday}:${slot.startTime}:${slot.endTime}`);
    if (new Set(slotKeys).size !== slotKeys.length) return setError(m.duplicateSlot);
    setSaving(true);
    try {
      const skillsArray = [...new Set(skills.split(',').map((value) => value.trim()).filter(Boolean))];
      const profileRes = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio: bio.trim(), interests: interests.trim(), skills: skillsArray, mentorCapacity: Number(capacity) }),
      });
      if (!profileRes.ok) throw new Error(m.saveFailed);

      const availabilityRes = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots }),
      });
      if (!availabilityRes.ok) throw new Error(m.saveFailed);
      router.push('/mentor');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : m.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skip' }),
      });
      if (!res.ok) throw new Error(m.saveFailed);
      router.push('/mentor');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : m.saveFailed);
      setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-lg" data-testid="mentor-onboarding-wizard">
      <div className="mb-8">
        <div className="flex justify-between mb-2">
          {stepLabels.map((label, index) => (
            <div key={label} className="flex items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${index <= step ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-300'}`}>
                {index < step ? '✓' : index + 1}
              </div>
              {index < stepLabels.length - 1 && <div className={`h-1 w-12 sm:w-20 mx-1 rounded ${index < step ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'}`} />}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-1 text-center">
          {stepLabels.map((label, index) => <span key={label} className={`text-xs break-words ${index === step ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-400'}`}>{label}</span>)}
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>}

      {step === 0 && <div className="space-y-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{m.bioLabel}</label>
        <Textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={2000} showCounter rows={6} />
      </div>}
      {step === 1 && <div className="space-y-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{m.interestsLabel}</label>
        <Textarea value={interests} onChange={(event) => setInterests(event.target.value)} maxLength={2000} showCounter rows={5} />
        <Input label={m.skillsLabel} value={skills} onChange={(event) => setSkills(event.target.value)} hint={m.skillsHint} />
      </div>}
      {step === 2 && <Input label={m.capacityLabel} type="number" min={0} max={100} value={capacity} onChange={(event) => setCapacity(event.target.value)} hint={m.capacityHint} />}
      {step === 3 && <div className="space-y-3">
        <p className="text-sm text-gray-600 dark:text-gray-300">{m.availabilityHint}</p>
        {slots.map((slot, index) => <div key={index} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end rounded-lg border border-gray-200 dark:border-gray-700 p-3" data-testid="mentor-onboarding-slot">
          <Select label={m.dayLabel} value={String(slot.weekday)} onChange={(event) => updateSlot(index, { weekday: Number(event.target.value) })} options={days.map((day, dayIndex) => ({ value: String(dayIndex), label: day }))} />
          <Input label={m.startLabel} type="time" value={slot.startTime} onChange={(event) => updateSlot(index, { startTime: event.target.value })} />
          <Input label={m.endLabel} type="time" value={slot.endTime} onChange={(event) => updateSlot(index, { endTime: event.target.value })} />
          <button type="button" aria-label={m.removeSlot} onClick={() => setSlots((current) => current.filter((_, slotIndex) => slotIndex !== index))} className="p-2 text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
        </div>)}
        <Button type="button" variant="outline" onClick={() => setSlots((current) => [...current, { weekday: 1, startTime: '09:00', endTime: '10:00' }])}><Plus className="h-4 w-4 mr-1" />{m.addSlot}</Button>
      </div>}

      <div className="mt-6 flex gap-3">
        {step > 0 && <Button type="button" variant="outline" onClick={() => { setError(''); setStep((value) => value - 1); }} className="flex-1">{t.onboarding.back}</Button>}
        <Button type="button" onClick={step === 3 ? finish : next} loading={saving} className="flex-1">{step === 3 ? m.finish : t.onboarding.continue}</Button>
      </div>
      <button type="button" onClick={skip} disabled={saving} className="mt-4 w-full text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-50">{m.skip}</button>
      <p className="mt-1 text-center text-xs text-gray-400 dark:text-gray-500">{m.completeLater}</p>
    </div>
  );
}
