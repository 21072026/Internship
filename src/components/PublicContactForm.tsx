'use client';

import { useRef, useState } from 'react';
import { Mail, Send, Check } from 'lucide-react';
import { useT } from '@/i18n/client';

// Public contact form on a shared profile. Anti-spam is server-side (honeypot +
// min-time + rate limit); here we just capture the honeypot and render time.
export function PublicContactForm({ userId }: { userId: string }) {
  const t = useT();
  const c = t.publicContact;
  const renderedAt = useRef(Date.now());
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');
    try {
      const res = await fetch(`/api/public-contact/${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message, website, renderedAt: renderedAt.current }),
      });
      if (!res.ok) throw new Error();
      setStatus('sent');
      setName(''); setEmail(''); setMessage('');
    } catch {
      setStatus('error');
    }
  };

  if (status === 'sent') {
    return (
      <div className="mt-4 rounded-xl border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/20 p-4 text-sm text-green-800 dark:text-green-200 flex items-center gap-2">
        <Check className="h-4 w-4" /> {c.sent}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
        <Mail className="h-4 w-4 text-gray-400" /> {c.title}
      </p>
      {/* Honeypot: visually hidden, off-tab; real users never fill it. */}
      <input
        type="text" name="website" tabIndex={-1} autoComplete="off"
        value={website} onChange={(e) => setWebsite(e.target.value)}
        className="hidden" aria-hidden="true"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          required value={name} onChange={(e) => setName(e.target.value)} placeholder={c.name}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
        />
        <input
          required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={c.email}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
        />
      </div>
      <textarea
        required value={message} onChange={(e) => setMessage(e.target.value)} placeholder={c.message} rows={4}
        className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
      />
      {status === 'error' && <p className="text-xs text-red-600">{c.error}</p>}
      <button
        type="submit" disabled={status === 'sending'}
        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      >
        <Send className="h-4 w-4" /> {c.send}
      </button>
      <p className="text-xs text-gray-400">{c.notice}</p>
    </form>
  );
}
