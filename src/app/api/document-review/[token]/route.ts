import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { REVIEW_DECISIONS, nextStep } from '@/lib/documentReview';
import { decideStep, loadReviewDocument } from '@/lib/documentReviewStore';
import { requirementLabel } from '@/lib/documentRequirements';
import { isLocale } from '@/i18n/config';

// The account-less reviewer's door (#1859): an EXTERNAL step of a document's
// review chain, decided by whoever holds the emailed token — no account, the
// token is the credential (the MeetingGuest.rsvpToken precedent). It answers
// for that one step of that one document and nothing else: no session is made,
// nothing else in the app becomes reachable, and the token is cleared when the
// step is decided, so a link works exactly once. An unknown, spent or
// out-of-turn token is a 404 either way.

const TOKEN = /^[a-f0-9]{48}$/;

async function resolve(token: string) {
  if (!TOKEN.test(token)) return null;
  const review = await prisma.documentReview.findUnique({ where: { reviewToken: token }, select: { id: true, documentId: true } });
  if (!review) return null;
  const doc = await loadReviewDocument(review.documentId);
  if (!doc || doc.reviewStatus !== 'PENDING') return null;
  const current = nextStep(doc.reviews);
  if (!current || current.id !== review.id || current.reviewerRole !== 'EXTERNAL') return null;
  return { doc, current };
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const limited = enforceRateLimit(request, 'document-review-read', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const resolved = await resolve((await params).token);
  if (!resolved) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { doc, current } = resolved;
  const pref = doc.owner?.preferredLanguage;
  return NextResponse.json({
    title: doc.title,
    requirement: doc.requirement ? requirementLabel(doc.requirement.labels, isLocale(pref) ? pref : 'en', doc.requirement.key) : null,
    owner: doc.owner?.fullName ?? null,
    step: current.step,
    steps: doc.reviews.length,
  });
}

const bodySchema = z.object({
  step: z.number().int().min(1).max(10),
  decision: z.enum(REVIEW_DECISIONS),
  note: z.string().trim().max(2000).optional(),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const limited = enforceRateLimit(request, 'document-review', { limit: 20, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
  const resolved = await resolve((await params).token);
  if (!resolved) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { doc, current } = resolved;
  const result = await decideStep({
    doc,
    step: parsed.data.step,
    decision: parsed.data.decision,
    note: parsed.data.note,
    by: { kind: 'token', reviewId: current.id },
  });
  if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
  await logActivity({
    action: 'document.review',
    actorId: null,
    actorEmail: doc.reviews.find((r) => r.id === current.id)?.reviewerEmail ?? null,
    targetType: 'document',
    targetId: doc.id,
    detail: `step ${result.step} (external): ${parsed.data.decision} -> ${result.documentStatus}`,
    request,
    orgId: doc.requirement?.orgId ?? null,
  });
  return NextResponse.json({ reviewStatus: result.documentStatus });
}
