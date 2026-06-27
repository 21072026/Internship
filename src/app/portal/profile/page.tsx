'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';

const profileSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  city: z.string().optional(),
  birthDate: z.string().optional(),
  university: z.string().optional(),
  department: z.string().optional(),
  graduationYear: z.coerce.number().int().min(2020).max(2035).optional().or(z.literal(0)),
  skills: z.string().optional(),
  cvUrl: z.string().url('Please enter a valid URL').optional().or(z.literal('')),
});

type ProfileFormData = z.infer<typeof profileSchema>;

const graduationYearOptions = [
  { value: '0', label: 'Not set' },
  ...Array.from({ length: 16 }, (_, i) => ({
    value: String(2020 + i),
    label: String(2020 + i),
  })),
];

export default function ProfilePage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
  });

  useEffect(() => {
    fetch('/api/profile')
      .then((res) => res.json())
      .then(({ user }) => {
        if (user) {
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
            cvUrl: user.cvUrl || '',
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

      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          skills: skillsArray,
          graduationYear: data.graduationYear || null,
          cvUrl: data.cvUrl || null,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Failed to save');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  });

  if (loading) return <div className="text-center py-12 text-gray-400">Loading...</div>;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">My Profile</h1>
        <p className="text-gray-500 mt-1">Update your personal information and preferences</p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Profile Information</CardTitle>
        </CardHeader>

        {success && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            ✓ Profile updated successfully
          </div>
        )}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <Input
            label="Full Name"
            required
            {...register('fullName')}
            error={errors.fullName?.message}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Phone Number"
              type="tel"
              {...register('phone')}
              error={errors.phone?.message}
            />
            <Input
              label="WhatsApp"
              type="tel"
              placeholder="+49..."
              {...register('whatsapp')}
              error={errors.whatsapp?.message}
            />
            <Input label="City" placeholder="e.g. Monheim" {...register('city')} error={errors.city?.message} />
            <Input label="Birth Date" type="date" {...register('birthDate')} error={errors.birthDate?.message} />
          </div>

          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-4">Education</p>
            <div className="space-y-4">
              <Input
                label="University"
                placeholder="e.g. MIT"
                {...register('university')}
                error={errors.university?.message}
              />
              <Input
                label="Department / Major"
                placeholder="e.g. Computer Science"
                {...register('department')}
                error={errors.department?.message}
              />
              <Select
                label="Graduation Year"
                options={graduationYearOptions}
                {...register('graduationYear')}
                error={errors.graduationYear?.message}
              />
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-4">Skills & CV</p>
            <div className="space-y-4">
              <Input
                label="Skills"
                placeholder="React, Python, Data Analysis (comma-separated)"
                hint="Separate multiple skills with commas"
                {...register('skills')}
                error={errors.skills?.message}
              />
              <Input
                label="CV URL"
                type="url"
                placeholder="https://drive.google.com/..."
                hint="Link to your CV"
                {...register('cvUrl')}
                error={errors.cvUrl?.message}
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button type="submit" loading={saving}>
              Save Changes
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
