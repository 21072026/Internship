'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Send, Mail, Copy, Check } from 'lucide-react';

const inviteSchema = z.object({
  email: z.string().email('Invalid email'),
  role: z.enum(['MENTOR', 'MENTEE', 'ADMIN']),
});

type InviteData = z.infer<typeof inviteSchema>;

const roleOptions = [
  { value: 'MENTEE', label: 'Mentee' },
  { value: 'MENTOR', label: 'Mentor' },
  { value: 'ADMIN', label: 'Admin' },
];

export default function InvitePage() {
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sentInvites, setSentInvites] = useState<
    { email: string; role: string; time: string; registerUrl: string; emailSent: boolean }[]
  >([]);
  const [copied, setCopied] = useState<string | null>(null);

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteData>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { role: 'MENTEE' },
  });

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error || 'Failed to send invitation');
      }

      setSuccess(
        body.emailSent
          ? `Invitation emailed to ${data.email}`
          : `Invitation created for ${data.email} — email not delivered, share the link below manually`
      );
      setSentInvites((prev) => [
        {
          email: data.email,
          role: data.role,
          time: new Date().toLocaleString(),
          registerUrl: body.registerUrl ?? '',
          emailSent: !!body.emailSent,
        },
        ...prev,
      ]);
      reset({ role: 'MENTEE' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  });

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Send Invitations</h1>
        <p className="text-gray-500 mt-1">Invite mentors and mentees to join the platform</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-blue-600" />
              <CardTitle>New Invitation</CardTitle>
            </div>
          </CardHeader>

          {success && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
              ✓ {success}
            </div>
          )}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            <Input
              label="Email Address"
              type="email"
              required
              placeholder="user@example.com"
              {...register('email')}
              error={errors.email?.message}
            />
            <Select
              label="Role"
              required
              options={roleOptions}
              {...register('role')}
              error={errors.role?.message}
            />
            <Button type="submit" className="w-full" loading={loading}>
              <Send className="h-4 w-4" />
              Send Invitation
            </Button>
          </form>

          <div className="mt-6 p-4 bg-blue-50 rounded-xl">
            <p className="text-sm font-medium text-blue-800 mb-2">How it works</p>
            <ol className="text-sm text-blue-700 space-y-1 list-decimal list-inside">
              <li>Enter the recipient&apos;s email and select their role</li>
              <li>They receive an email with a registration link</li>
              <li>If email isn&apos;t delivered, copy the link and share it manually</li>
              <li>The link expires in 7 days</li>
            </ol>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Invitations</CardTitle>
          </CardHeader>
          {sentInvites.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              No invitations sent in this session
            </p>
          ) : (
            <div className="space-y-3">
              {sentInvites.map((invite, idx) => (
                <div key={idx} className="py-3 border-b border-gray-50 last:border-0">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{invite.email}</p>
                      <p className="text-xs text-gray-400">
                        {invite.time} · {invite.emailSent ? 'emailed' : 'not emailed'}
                      </p>
                    </div>
                    <Badge
                      variant={
                        invite.role === 'ADMIN'
                          ? 'danger'
                          : invite.role === 'MENTOR'
                          ? 'info'
                          : 'success'
                      }
                    >
                      {invite.role}
                    </Badge>
                  </div>
                  {invite.registerUrl && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        readOnly
                        value={invite.registerUrl}
                        className="flex-1 min-w-0 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-gray-600"
                      />
                      <button
                        type="button"
                        onClick={() => copyLink(invite.registerUrl)}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 flex-shrink-0"
                      >
                        {copied === invite.registerUrl ? (
                          <>
                            <Check className="h-3.5 w-3.5" /> Kopyalandı
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" /> Kopyala
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
