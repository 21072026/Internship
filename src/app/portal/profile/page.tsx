'use client';
import { useT } from "@/i18n/client";

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { CvManager } from '@/components/CvManager';
import { CvFeedback } from '@/components/CvFeedback';
import { CvSuggestPanel } from '@/components/CvSuggestPanel';
import { SkillRating } from '@/components/SkillRating';
import { AvatarManager } from '@/components/AvatarManager';
import { DocumentsManager } from '@/components/DocumentsManager';
import { TemplatesLibrary } from '@/components/TemplatesLibrary';
import { useToast } from '@/components/ui/Toast';

// Allows only +, digits, spaces, hyphens and parentheses, and requires 7-15 digits.
function isValidPhone(v: string): boolean {
  if (!/^[0-9+\s()-]+$/.test(v)) return false;
  const digitCount = (v.match(/\d/g) || []).length;
  return digitCount >= 7 && digitCount <= 15;
}

// Requires a real calendar date in YYYY-MM-DD format that is today or earlier.
function isValidPastOrTodayDate(v: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return false;
  return v <= new Date().toISOString().slice(0, 10);
}

const profileSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  phone: z.string().optional().refine((v) => !v || isValidPhone(v), 'Please enter a valid phone number'),
  whatsapp: z.string().optional().refine((v) => !v || isValidPhone(v), 'Please enter a valid phone number'),
  city: z.string().optional(),
  birthDate: z.string().optional().refine((v) => !v || isValidPastOrTodayDate(v), 'Please enter a valid date not in the future'),
  university: z.string().optional(),
  department: z.string().optional(),
  graduationYear: z.coerce.number().int().min(2010).max(new Date().getFullYear() + 5).optional().or(z.literal(0)),
  skills: z.string().optional(),
  // Accept a full URL or an internal path (e.g. /api/cv/<id> set on upload).
  cvUrl: z.string().refine((v) => v === '' || /^https?:\/\//.test(v) || v.startsWith('/'), 'Please enter a valid URL').optional().or(z.literal('')),
  displayName: z.string().optional(),
  bio: z.string().optional(),
  country: z.string().optional(),
  timezone: z.string().optional(),
  linkedinUrl: z.string().url('Please enter a valid URL').optional().or(z.literal('')),
  githubUrl: z.string().url('Please enter a valid URL').optional().or(z.literal('')),
  portfolioUrl: z.string().url('Please enter a valid URL').optional().or(z.literal('')),
  interests: z.string().optional(),
  targetPosition: z.string().optional(),
  mentorCapacity: z.coerce.number().int().min(0).max(100).optional().or(z.literal(0)),
});

type ProfileFormData = z.infer<typeof profileSchema>;

const MIN_GRAD_YEAR = 2010;
const MAX_GRAD_YEAR = new Date().getFullYear() + 5;
const graduationYearOptions = [
  { value: '0', label: 'Not set' },
  ...Array.from({ length: MAX_GRAD_YEAR - MIN_GRAD_YEAR + 1 }, (_, i) => ({
    value: String(MIN_GRAD_YEAR + i),
    label: String(MIN_GRAD_YEAR + i),
  })),
];

const DEFAULT_TIMEZONE = 'Europe/Istanbul';
const FALLBACK_TIMEZONES = [
  'Europe/Istanbul', 'Europe/Berlin', 'Europe/London', 'Europe/Paris',
  'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC',
];
function getTimezoneOptions(): { value: string; label: string }[] {
  let zones: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    zones = (Intl as any).supportedValuesOf('timeZone');
  } catch {
    zones = FALLBACK_TIMEZONES;
  }
  return zones.map((tz) => ({ value: tz, label: tz }));
}
const timezoneOptions = getTimezoneOptions();
function resolveTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  return timezoneOptions.some((opt) => opt.value === tz) ? tz : DEFAULT_TIMEZONE;
}

export default function ProfilePage() {
  const t = useT();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [userId, setUserId] = useState('');
  const [initialCv, setInitialCv] = useState<string | null>(null);
  // True when the stored CV is an uploaded file (internal /api/cv/... path).
  // In that case the CvManager owns it and the manual external-URL input hides.
  const [cvUploaded, setCvUploaded] = useState(false);
  const [publicProfile, setPublicProfile] = useState(false);
  const [profileViews, setProfileViews] = useState(0);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('');

  const [skillLevels, setSkillLevels] = useState<Record<string, number>>({});

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
  });

  // Merge CV-suggested skills into the comma-separated skills field (dedup,
  // case-insensitive), keeping the user's existing entries.
  const applySuggestedSkills = (incoming: string[]) => {
    const existing = (getValues('skills') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const seen = new Set(existing.map((s) => s.toLowerCase()));
    const merged = [...existing];
    for (const s of incoming) {
      if (!seen.has(s.toLowerCase())) { merged.push(s); seen.add(s.toLowerCase()); }
    }
    setValue('skills', merged.join(', '), { shouldDirty: true });
  };

  useEffect(() => {
    fetch('/api/profile')
      .then((res) => res.json())
      .then(({ user }) => {
        if (user) {
          setUserId(user.id);
          setInitialCv(user.cvUrl || null);
          setCvUploaded(!!user.cvUrl && user.cvUrl.startsWith('/'));
          setPublicProfile(!!user.publicProfile);
          setProfileViews(user.profileViews || 0);
          setAvatarUrl(user.avatarUrl || null);
          setFullName(user.fullName || '');
          setRole(user.role || '');
          setSkillLevels((user.skillLevels && typeof user.skillLevels === 'object') ? user.skillLevels : {});
          reset({
            fullName: user.fullName,
            phone: user.phone || '',
            whatsapp: user.whatsapp || '',
            city: user.city || '',
            birthDate: user.birthDate ? String(user.birthDate).slice(0, 10) : '',
            university: user.university || '',
            department: user.department || '',
            graduationYear: user.graduationYear || 0,
            skills: user.skills?.join(', ') || '',
            // Only seed the manual input with an *external* link; internal
            // upload paths are managed by the CvManager, not shown here.
            cvUrl: user.cvUrl && /^https?:\/\//.test(user.cvUrl) ? user.cvUrl : '',
            displayName: user.displayName || '',
            bio: user.bio || '',
            country: user.country || '',
            timezone: resolveTimezone(user.timezone),
            linkedinUrl: user.linkedinUrl || '',
            githubUrl: user.githubUrl || '',
            portfolioUrl: user.portfolioUrl || '',
            interests: user.interests || '',
            targetPosition: user.targetPosition || '',
            mentorCapacity: user.mentorCapacity || 0,
          });
        }
        setLoading(false);
      });
  }, [reset]);

  const onSubmit = handleSubmit(async (data) => {
    setSaving(true);
    setError('');
    setSuccess(false);

    try {
      const skillsArray = data.skills
        ? data.skills.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      // Keep levels only for skills the user still lists.
      const levels = Object.fromEntries(
        skillsArray.filter((s) => skillLevels[s]).map((s) => [s, skillLevels[s]])
      );

      // The manual field only ever carries an external link. When an uploaded
      // file CV exists, the CvManager owns cvUrl — omit it so we never clobber it.
      const { cvUrl: externalCvUrl, ...rest } = data;
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...rest,
          skills: skillsArray,
          skillLevels: levels,
          graduationYear: data.graduationYear || null,
          ...(cvUploaded ? {} : { cvUrl: externalCvUrl || null }),
          mentorCapacity: data.mentorCapacity || null,
          publicProfile,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Failed to save');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      toast(t.profileForm.updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  });

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.profileForm.title}</h1>
        <p className="text-gray-500 mt-1">{t.profileForm.subtitle}</p>
      </div>

      {userId && (
        <Card className="max-w-2xl mb-6">
          <CardHeader><CardTitle>{t.avatar.section}</CardTitle></CardHeader>
          <AvatarManager targetUserId={userId} initialAvatarUrl={avatarUrl} name={fullName} />
        </Card>
      )}

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t.profileForm.profileInformation}</CardTitle>
        </CardHeader>

        {success && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            ✓ {t.profileForm.updated}
          </div>
        )}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <Input
            label={t.profileForm.fullName}
            required
            {...register('fullName')}
            error={errors.fullName?.message}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={t.profileForm.phone}
              type="tel"
              {...register('phone')}
              error={errors.phone?.message}
            />
            <Input
              label={t.profileForm.whatsapp}
              type="tel"
              placeholder="+49..."
              {...register('whatsapp')}
              error={errors.whatsapp?.message}
            />
            <Input label={t.profileForm.city} placeholder="e.g. Monheim" {...register('city')} error={errors.city?.message} />
            <Input label={t.profileForm.birthDate} type="date" {...register('birthDate')} error={errors.birthDate?.message} />
          </div>

          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-4">{t.profileForm.about}</p>
            <div className="space-y-4">
              <Input label={t.profileForm.displayName} placeholder={t.profileForm.displayNameHint} {...register('displayName')} error={errors.displayName?.message} />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.profileForm.bio}</label>
                <textarea
                  {...register('bio')}
                  rows={3}
                  className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                  placeholder={t.profileForm.bioHint}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input label={t.profileForm.country} {...register('country')} error={errors.country?.message} />
                <Select label={t.profileForm.timezone} options={timezoneOptions} {...register('timezone')} error={errors.timezone?.message} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input label="LinkedIn" type="url" placeholder="https://linkedin.com/in/..." {...register('linkedinUrl')} error={errors.linkedinUrl?.message} />
                <Input label="GitHub" type="url" placeholder="https://github.com/..." {...register('githubUrl')} error={errors.githubUrl?.message} />
              </div>
              <Input label={t.profileForm.portfolio} type="url" placeholder="https://..." {...register('portfolioUrl')} error={errors.portfolioUrl?.message} />
              {role === 'MENTEE' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input label={t.profileForm.targetPosition} placeholder={t.profileForm.targetPositionHint} {...register('targetPosition')} error={errors.targetPosition?.message} />
                  <Input label={t.profileForm.interests} placeholder={t.profileForm.interestsHint} {...register('interests')} error={errors.interests?.message} />
                </div>
              )}
              {role === 'MENTOR' && (
                <Input label={t.profileForm.mentorCapacity} type="number" min={0} hint={t.profileForm.mentorCapacityHint} {...register('mentorCapacity')} error={errors.mentorCapacity?.message} />
              )}
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-4">{t.profileForm.education}</p>
            <div className="space-y-4">
              <Input
                label={t.profileForm.university}
                placeholder="e.g. MIT"
                {...register('university')}
                error={errors.university?.message}
              />
              <Input
                label={t.profileForm.department}
                placeholder="e.g. Computer Science"
                {...register('department')}
                error={errors.department?.message}
              />
              <Select
                label={t.profileForm.graduationYear}
                options={graduationYearOptions}
                {...register('graduationYear')}
                error={errors.graduationYear?.message}
              />
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-4">{t.profileForm.skillsCv}</p>
            <div className="space-y-4">
              <Input
                label={t.profileForm.skills}
                placeholder="React, Python, Data Analysis (comma-separated)"
                hint="Separate multiple skills with commas"
                {...register('skills')}
                error={errors.skills?.message}
              />
              {(() => {
                const list = (watch('skills') || '').split(',').map((s) => s.trim()).filter(Boolean);
                if (list.length === 0) return null;
                return (
                  <div>
                    <p className="text-xs font-medium text-gray-600 mb-2">{t.profileForm.skillLevels}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {list.map((s) => (
                        <div key={s} className="flex items-center justify-between gap-2 text-sm bg-gray-50 rounded-lg px-3 py-1.5">
                          <span className="truncate text-gray-700">{s}</span>
                          <SkillRating
                            label={s}
                            value={skillLevels[s] ?? 0}
                            onChange={(v) => setSkillLevels((prev) => ({ ...prev, [s]: v }))}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {/* Manual link is for an external CV only. Hidden once a file is
                  uploaded — the CvManager below then owns view/replace/delete. */}
              {!cvUploaded && (
                <Input
                  label={t.profileForm.cvUrl}
                  type="text"
                  inputMode="url"
                  placeholder="https://drive.google.com/..."
                  hint={t.profileForm.cvUrlHint}
                  {...register('cvUrl')}
                  error={errors.cvUrl?.message}
                />
              )}
              {userId && (
                <div className="border-t border-gray-100 pt-4">
                  <CvManager
                    targetUserId={userId}
                    initialCvUrl={initialCv}
                    onChange={(url) => setCvUploaded(!!url && url.startsWith('/'))}
                  />
                  {cvUploaded && (
                    <CvSuggestPanel
                      targetUserId={userId}
                      onApplyField={(field, value) => setValue(field as keyof ProfileFormData, value, { shouldDirty: true })}
                      onApplySkills={applySuggestedSkills}
                    />
                  )}
                  {cvUploaded && <CvFeedback />}
                </div>
              )}

              <div className="border-t border-gray-100 pt-4">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                  <input
                    type="checkbox"
                    checked={publicProfile}
                    onChange={(e) => setPublicProfile(e.target.checked)}
                  />
                  {t.profileForm.makePublic}
                </label>
                <p className="text-xs text-gray-400 mt-1">{t.profileForm.makePublicHint}</p>
                {publicProfile && userId && (
                  <div className="mt-1">
                    <a
                      href={`/p/${userId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline inline-block"
                    >
                      /p/{userId}
                    </a>
                    <p className="text-xs text-gray-500 mt-1">{t.profileForm.profileViews}: {profileViews}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button type="submit" loading={saving}>
              {t.profileForm.save}
            </Button>
          </div>
        </form>
      </Card>

      {userId && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl mt-6">
          <DocumentsManager targetUserId={userId} />
          <TemplatesLibrary />
        </div>
      )}
    </div>
  );
}
