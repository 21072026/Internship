'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { GraduationCap, CheckCircle2, XCircle } from 'lucide-react';
import { useT } from '@/i18n/client';

interface Meeting {
  title: string;
  scheduledAt: string;
  meetLink?: string | null;
  rsvp: string;
}

export default function RsvpPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const autoResp = useSearchParams().get('r'); // 'yes' | 'no' from the email links
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined);
  const [done, setDone] = useState<'ACCEPTED' | 'DECLINED' | null>(null);

  const respond = useCallback(
    async (response: 'yes' | 'no') => {
      const res = await fetch('/api/rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, response }),
      });
      if (res.ok) setDone(response === 'yes' ? 'ACCEPTED' : 'DECLINED');
    },
    [token]
  );

  useEffect(() => {
    fetch(`/api/rsvp?token=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : { meeting: null }))
      .then((d) => {
        setMeeting(d.meeting ?? null);
        if (d.meeting && (autoResp === 'yes' || autoResp === 'no')) respond(autoResp);
      })
      .catch(() => setMeeting(null));
  }, [token, autoResp, respond]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center">
            <GraduationCap className="h-8 w-8 text-white" />
          </div>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
          {meeting === undefined ? (
            <p className="text-gray-500">…</p>
          ) : meeting === null ? (
            <p className="text-gray-500">{t.rsvp.notFound}</p>
          ) : (
            <>
              <h1 className="text-xl font-bold text-gray-900">{meeting.title}</h1>
              <p className="text-gray-500 mt-1">{new Date(meeting.scheduledAt).toLocaleString()}</p>
              {meeting.meetLink && (
                <a href={meeting.meetLink} className="text-blue-600 hover:underline text-sm block mt-2">
                  {meeting.meetLink}
                </a>
              )}
              {done ? (
                <div className="mt-6 flex flex-col items-center gap-2">
                  {done === 'ACCEPTED' ? (
                    <CheckCircle2 className="h-10 w-10 text-green-500" />
                  ) : (
                    <XCircle className="h-10 w-10 text-red-500" />
                  )}
                  <p className="text-sm text-gray-700">
                    {done === 'ACCEPTED' ? t.rsvp.accepted : t.rsvp.declined}
                  </p>
                </div>
              ) : (
                <div className="mt-6 flex justify-center gap-3">
                  <button
                    onClick={() => respond('yes')}
                    className="bg-green-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700"
                  >
                    {t.rsvp.yes}
                  </button>
                  <button
                    onClick={() => respond('no')}
                    className="bg-red-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-red-700"
                  >
                    {t.rsvp.no}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
