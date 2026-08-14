'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';

type Candidate = { id: string; fullName: string };
type Shortlist = { id: string; status: string; note: string | null; mentee: Candidate };
type Interview = { id: string; menteeId: string; status: string };

export default function CompanyRequisitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(); const text = t.interviewRequests;
  const [requisition, setRequisition] = useState<{ title: string } | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [shortlist, setShortlist] = useState<Shortlist[]>([]);
  const [requests, setRequests] = useState<Interview[]>([]);
  const [candidateId, setCandidateId] = useState(''); const [note, setNote] = useState(''); const [error, setError] = useState('');
  const load = useCallback(async () => {
    const [req, rels, interests, interviews] = await Promise.all([
      fetch(`/api/requisitions/${id}`).then((r) => r.json()), fetch('/api/mentorship').then((r) => r.json()),
      fetch(`/api/company/interests?requisitionId=${id}`).then((r) => r.json()), fetch(`/api/interview-requests?requisitionId=${id}`).then((r) => r.json()),
    ]);
    setRequisition(req.requisition ?? null);
    setCandidates((rels.relations ?? []).map((relation: { mentee: Candidate }) => relation.mentee));
    setShortlist(interests.interests ?? []); setRequests(interviews.requests ?? []);
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const add = async () => {
    const res = await fetch('/api/company/interests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requisitionId: id, menteeId: candidateId, status: 'SHORTLISTED', note }) });
    if (!res.ok) setError(text.errors.saveFailed); else { setCandidateId(''); setNote(''); await load(); }
  };
  const requestInterview = async (menteeId: string) => {
    const res = await fetch('/api/interview-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requisitionId: id, menteeId }) });
    if (!res.ok) setError((await res.json()).error ?? text.errors.saveFailed); else await load();
  };
  const removeFromShortlist = async (item: Shortlist) => {
    const res = await fetch('/api/company/interests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requisitionId: id, menteeId: item.mentee.id, status: 'PASS', note: item.note ?? undefined }),
    });
    if (!res.ok) setError(text.errors.saveFailed); else await load();
  };
  if (!requisition) return <p className="py-10 text-center text-gray-500">{t.common.loading}</p>;
  return <div data-testid="requisition-shortlist"><Link href="/company/requisitions" className="text-sm text-blue-600">← {t.requisitions.title}</Link><h1 className="my-5 text-2xl font-bold text-gray-900 dark:text-gray-100">{requisition.title}</h1>
    {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
    <Card className="mb-5"><CardHeader><CardTitle>{text.shortlist}</CardTitle></CardHeader><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><Select value={candidateId} onChange={(e) => setCandidateId(e.target.value)} placeholder={text.selectCandidate} options={candidates.map((candidate) => ({ value: candidate.id, label: candidate.fullName }))} /><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={text.note} /></div><Button className="mt-3" disabled={!candidateId} onClick={() => void add()}>{text.shortlistAction}</Button></Card>
    <Card><CardHeader><CardTitle>{text.shortlisted}</CardTitle></CardHeader>{shortlist.length === 0 ? <p className="text-sm text-gray-500">{text.empty}</p> : <div className="space-y-3">{shortlist.map((item) => { const request = requests.find((value) => value.menteeId === item.mentee.id); return <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 pb-3 dark:border-gray-800"><Link href={`/company/candidates/${item.mentee.id}`} className="font-medium text-blue-600">{item.mentee.fullName}</Link><div className="flex flex-wrap items-center gap-2">{request ? <><Badge>{text.statuses[request.status as keyof typeof text.statuses]}</Badge>{request.status === 'APPROVED' && <span className="text-sm text-gray-500">{text.scheduleWithProgram}</span>}</> : <><Button size="sm" onClick={() => void requestInterview(item.mentee.id)}>{text.requestInterview}</Button><Button size="sm" variant="outline" onClick={() => void removeFromShortlist(item)}>{text.removeFromShortlist}</Button></>}</div></div>; })}</div>}</Card>
  </div>;
}
