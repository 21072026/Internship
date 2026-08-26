import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { isLocale } from '@/i18n/config';
import {
  canonicalNewsletterContent,
  newsletterImageUrl,
  normalizeNewsletterContent,
  type NewsletterAudience,
} from '@/lib/newsletter';
import { renderNewsletterFor } from '@/lib/newsletterDispatch';

const schema = z.object({
  content: z.record(z.string(), z.unknown()),
  audience: z.enum(['MENTEE', 'MENTOR', 'BOTH']).default('MENTEE'),
  /** Which language to preview. */
  locale: z.string().max(8).optional(),
  /** Whose copy to preview — this is how the mentor block is checked. */
  asRole: z.enum(['MENTEE', 'MENTOR']).default('MENTEE'),
  /** An already-saved issue whose hero image should appear in the preview. */
  newsletterId: z.string().max(64).optional(),
});

/**
 * POST — render the issue exactly as a recipient would receive it (#1469).
 *
 * Takes the content from the request rather than from a row, so an admin can
 * preview a draft they have not saved yet — the moment the format actually
 * needs checking. The renderer is the one the dispatcher uses, so what appears
 * in the preview pane is the mail, not an approximation of it.
 *
 * POST rather than GET because the body is a whole issue in up to three
 * languages, which does not belong in a query string.
 */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });

  const variants = normalizeNewsletterContent(parsed.data.content);
  const canonical = canonicalNewsletterContent(variants);
  if (!canonical) {
    return NextResponse.json({ error: 'Nothing to preview yet', empty: true }, { status: 400 });
  }

  const { subject, html, locale } = await renderNewsletterFor({
    variants,
    canonical,
    audience: parsed.data.audience as NewsletterAudience,
    role: parsed.data.asRole,
    preferredLanguage: isLocale(parsed.data.locale) ? parsed.data.locale : undefined,
    // A URL, not a cid: this HTML is rendered in the admin's browser, which can
    // load the image route (it is session-gated and they have a session). An
    // unsaved image simply does not show — the composer displays the picked
    // file next to the preview.
    imageSrc: parsed.data.newsletterId ? newsletterImageUrl(parsed.data.newsletterId) : null,
    userId: null,
  });

  return NextResponse.json({ subject, html, locale });
}
