import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { canSeeCompensation } from '@/lib/offers';
import { renderLetterForOffer } from '@/lib/offerLetterServer';
import { generateOfferLetterPdf } from '@/lib/offerLetterPdf';
import { getOrgBranding } from '@/lib/orgBranding';
import { getDictionary } from '@/i18n/dictionaries';
import { isLocale, type Locale } from '@/i18n/config';

// The offer letter (#1857): the PDF (default) or `?format=json` → { markdown,
// locale, frozen } for an on-screen read.
//
// WHO: exactly the compensation rule — canSeeCompensation(), ADMIN or the
// offer's own MENTEE — because the letter states the pay. COMPANY gets 403
// even for its own offer, as does any other mentee; a DRAFT stays ADMIN-only
// like the offer itself. Another tenant's offer is a 404.
//
// WHAT: a sent offer is read from its frozen `letterSnapshot`, never
// re-rendered, so a template edit after sending changes nothing. A DRAFT is a
// live preview. An offer sent before letters existed (no snapshot) renders
// live too and says so (`frozen: false`).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const cap = await requireCapability(session.user.orgId, 'placements');
  if (cap) return cap;
  const role = session.user.role;

  return withTenantScope(session, async () => {
    const offer = await prisma.offer.findFirst({
      where: withinTenant({ id }, await tenantWhere(session)),
      select: {
        id: true,
        orgId: true,
        status: true,
        position: true,
        letterSnapshot: true,
        letterLocale: true,
        relation: { select: { menteeId: true } },
      },
    });
    if (!offer) return NextResponse.json({ error: 'Offer not found' }, { status: 404 });
    const isOwnMenteeOffer = role === 'MENTEE' && offer.relation.menteeId === session.user.id;
    if (!canSeeCompensation({ role, isOwnMenteeOffer }) || (role !== 'ADMIN' && offer.status === 'DRAFT')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const frozen = offer.letterSnapshot != null;
    const { markdown, locale } = frozen
      ? { markdown: offer.letterSnapshot as string, locale: (isLocale(offer.letterLocale) ? offer.letterLocale : 'en') as Locale }
      : await renderLetterForOffer(offer.id);

    if (new URL(request.url).searchParams.get('format') === 'json') {
      return NextResponse.json({ markdown, locale, frozen });
    }

    const pdf = await generateOfferLetterPdf({
      bodyMarkdown: markdown,
      branding: await getOrgBranding(offer.orgId ?? session.user.orgId),
      footer: getDictionary(locale).offers.letter.pdfFooter,
    });
    const safeName = offer.position.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'offer';
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="offer-letter-${safeName}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });
}
