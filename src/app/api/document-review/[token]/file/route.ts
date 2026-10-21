import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { downloadHeaders } from '@/lib/download';
import { nextStep } from '@/lib/documentReview';

// The document an external reviewer is asked to decide on (#1859) — readable
// through the same token, for exactly as long as that token can still decide
// its step. Nothing else is reachable through it.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const limited = enforceRateLimit(request, 'document-review-read', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/.test(token)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const review = await prisma.documentReview.findUnique({ where: { reviewToken: token }, select: { id: true, documentId: true } });
  if (!review) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const doc = await prisma.document.findUnique({
    where: { id: review.documentId },
    select: { reviewStatus: true, filename: true, contentType: true, size: true, data: true, reviews: { select: { id: true, step: true, decision: true, reviewerRole: true } } },
  });
  const current = doc && doc.reviewStatus === 'PENDING' ? nextStep(doc.reviews) : null;
  if (!doc || !current || current.id !== review.id || current.reviewerRole !== 'EXTERNAL') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return new NextResponse(Buffer.from(doc.data), {
    headers: downloadHeaders({ filename: doc.filename, contentType: doc.contentType, size: doc.size }),
  });
}
