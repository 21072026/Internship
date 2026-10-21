'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, XCircle } from 'lucide-react';
import { BrandTile } from '@/components/BrandMark';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { browserTimeZone } from '@/lib/timezone';

interface Meeting {
  title: string;
  // Null for a link-only meeting: the API has always been able to return one,
  // and a guest can now be added to one after the fact (#1446), so the page
  // must not render `new Date(null)` as "Invalid Date".
  scheduledAt: string | null;
  meetLink?: string | null;
  rsvp: string;
}

export default function RsvpPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const locale = useLocale();
  const autoResp = useSearchParams().get('r'); // 'yes' | 'no' from the email links
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined);
  const [done, setDone] = useState<'ACCEPTED' | 'DECLINED' | null>(null);
  // "Suggest another time" (#1982): offered after a decline, for a participant
  // of a meeting that is still on. The token is the only credential.
  const [canCounter, setCanCounter] = useState(false);
  const [counterAt, setCounterAt] = useState('');
  const [suggested, setSuggested] = useState<string | null>(null);
  const [suggestFailed, setSuggestFailed] = useState(false);

  const suggest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!counterAt) return;
    setSuggestFailed(false);
    const res = await fetch('/api/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The wall clock as typed, with the clock it was typed on.
      body: JSON.stringify({ token, response: 'no', proposedAt: counterAt, timeZone: browserTimeZone() }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.counterProposal) setSuggested(body.counterProposal.proposedAt);
    else setSuggestFailed(true);
  };

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
        setCanCounter(d.canCounter === true);
        if (d.meeting && (autoResp === 'yes' || autoResp === 'no')) respond(autoResp);
      })
      .catch(() => setMeeting(null));
  }, [token, autoResp, respond]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <BrandTile />
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
          {meeting === undefined ? (
            <p className="text-gray-500">…</p>
          ) : meeting === null ? (
            <p className="text-gray-500">{t.rsvp.notFound}</p>
          ) : (
            <>
              <h1 className="text-xl font-bold text-gray-900">{meeting.title}</h1>
              {meeting.scheduledAt && (
                <p className="text-gray-500 mt-1">{formatDateTime(new Date(meeting.scheduledAt), locale)}</p>
              )}
              {meeting.meetLink && (
                <a href={meeting.meetLink} className="text-blue-600 hover:underline text-sm block mt-2">
                  {meeting.meetLink}
                </a>
              )}
              {meeting.scheduledAt && (
                <a href={`/api/calendar/${token}`} className="block text-sm text-blue-600 hover:underline mt-2">
                  {t.rsvp.addToCalendar}
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
                  {done === 'DECLINED' && canCounter && (suggested ? (
                    <p className="text-sm text-gray-700 mt-2" data-testid="rsvp-suggested">
                      {t.rsvp.suggested.replace('{when}', formatDateTime(new Date(suggested), locale))}
                    </p>
                  ) : (
                    <form onSubmit={suggest} className="mt-4 w-full text-left" data-testid="rsvp-suggest-form">
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="rsvp-suggest-at">{t.rsvp.suggestTitle}</label>
                      <div className="flex gap-2">
                        <input
                          id="rsvp-suggest-at"
                          type="datetime-local"
                          value={counterAt}
                          onChange={(e) => setCounterAt(e.target.value)}
                          data-testid="rsvp-suggest-at"
                          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                        />
                        <button type="submit" disabled={!counterAt} data-testid="rsvp-suggest-submit" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                          {t.rsvp.suggestSubmit}
                        </button>
                      </div>
                      {suggestFailed && <p className="text-sm text-red-600 mt-2" role="alert">{t.rsvp.suggestFailed}</p>}
                    </form>
                  ))}
                </div>
              ) : !meeting.scheduledAt ? null : (
                <div className="mt-6 flex justify-center gap-3">
                  <button
                    onClick={() => respond('yes')}
                    data-testid="rsvp-accept"
                    className="bg-green-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-green-800"
                  >
                    {t.rsvp.yes}
                  </button>
                  <button
                    onClick={() => respond('no')}
                    data-testid="rsvp-decline"
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
