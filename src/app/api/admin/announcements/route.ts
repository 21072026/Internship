import { NextResponse } from 'next/server';
import { normalizeMachineList } from '@/lib/machineTranslation';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { logActivity } from '@/lib/activity';
import { mailQueueNotice } from '@/lib/mailOutbox';
import { enqueue } from '@/lib/jobs/queue';
import { isValidAudienceInput, parseAudience } from '@/lib/announcementAudience';
import { announcementMailRecipients, announcementRecipients, deliverAnnouncement } from '@/lib/announcementSend';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { checkBroadcastQuota, broadcastQuotaError } from '@/lib/broadcastQuota';
import { withRequestScope } from '@/lib/requestContext';
import {
  validateAnnouncementImage,
  announcementImageUrl,
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  CONTENT_MISMATCH_ERROR,
} from '@/lib/announcementImage';
import {
  normalizeAnnouncementTranslations,
  canonicalAnnouncementText,
} from '@/lib/announcementText';
import { requirePermission } from '@/lib/authz';

const schema = z.object({
  // Long-form announcements (release notes, articles) are allowed; the previous
  // 2 000-char cap rejected them with a bare 400. Kept bounded to protect the
  // per-user notification fan-out.
  //
  // Optional since #1163: an admin may send `translations` instead, in which
  // case `text` is derived from them. One of the two must produce a body — see
  // the empty check in the handler.
  text: z.string().max(TEXT_LIMITS.announcementText).optional(),
  // { en?, tr?, de? }. Unknown keys and blank values are dropped by
  // normalizeAnnouncementTranslations rather than rejected, so a form that
  // submits three boxes with two of them empty is valid.
  translations: z.record(z.string(), z.string()).optional(),
  // Locales a machine filled and nobody has reviewed yet (#2055).
  machineTranslated: z.array(z.string()).max(3).optional(),
  link: z.string().max(TEXT_LIMITS.announcementLink).optional(),
  email: z.boolean().optional(),
  // Targeting (#1721): CRITERIA, resolved server-side at send time — there is
  // deliberately no field for a list of recipients. Absent = everyone.
  audience: z.unknown().optional(),
  // A future ISO instant to send at instead of now (#1721).
  scheduledAt: z.string().max(40).optional(),
});

// A schedule must be at least this far ahead; anything sooner is sent now.
const MIN_SCHEDULE_LEAD_MS = 60_000;
// …and at most this far: a forgotten schedule a year out is a surprise, not a plan.
const MAX_SCHEDULE_LEAD_MS = 366 * 24 * 60 * 60 * 1000;


const IMAGE_ERROR: Record<string, string> = {
  unsupported: 'Only PNG, JPEG, WebP or GIF images are allowed',
  tooLarge: `Image too large (max ${ANNOUNCEMENT_IMAGE_MAX_BYTES / (1024 * 1024)} MB)`,
  // Same wording as every other upload route (#888).
  unreadable: CONTENT_MISMATCH_ERROR,
};

/** A multipart field carrying JSON; an unparseable one is dropped, not thrown. */
function safeJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * The body arrives either as JSON (no image — the original contract, still used
 * by API clients and several e2e specs) or as multipart/form-data when the admin
 * attaches an image. Normalised here so the handler below sees one shape.
 */
async function readBody(request: Request): Promise<{ fields: unknown; image: File | null }> {
  try {
    if (!(request.headers.get('content-type') || '').includes('multipart/form-data')) {
      return { fields: await request.json(), image: null };
    }
    const form = await request.formData();
    const image = form.get('image');
    return {
      fields: {
        // FormData has no undefined: an omitted optional field reads as null, which
        // `.optional()` rejects — drop the empty ones instead.
        ...(form.get('text') ? { text: form.get('text') } : {}),
        // The multilingual form sends one field per language; JSON clients send
        // a `translations` object. Both land in the same shape here.
        ...(form.get('translations') ? { translations: safeJson(form.get('translations')) } : {}),
        ...(form.get('machineTranslated') ? { machineTranslated: safeJson(form.get('machineTranslated')) } : {}),
        ...(form.get('link') ? { link: form.get('link') } : {}),
        ...(form.get('email') === null ? {} : { email: form.get('email') === 'true' }),
        ...(form.get('audience') ? { audience: safeJson(form.get('audience')) } : {}),
        ...(form.get('scheduledAt') ? { scheduledAt: form.get('scheduledAt') } : {}),
      },
      image: image instanceof File && image.size > 0 ? image : null,
    };
  } catch {
    // An unparseable body should be the 400 below, not an unhandled 500.
    return { fields: null, image: null };
  }
}

// GET — paginated history of past broadcasts (most recent first).
//
// The request-correlation context (#1601) is bound outside the tenant scope, so
// both are established at the top of the handler and every log line from the
// broadcast fan-out below carries the request id.
export async function GET(request: Request) {
  return withRequestScope(request, () => handleGet(request));
}

async function handleGet(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  return await withTenantScope(session, async () => {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = 20;

  // The sending history of the caller's own tenant, by hand (#2542, #2590):
  // recipient counts and bodies of another product's broadcasts are that
  // tenant's business, and the middleware scopes nothing while
  // MT_ENFORCE_ISOLATION is off.
  const tenant = await tenantWhere(session);
  const [total, announcements] = await Promise.all([
    prisma.announcement.count({ where: withinTenant({}, tenant) }),
    prisma.announcement.findMany({
      where: withinTenant({}, tenant),
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // `select: { id: true }` on the relation, never the blob — an `include`
      // would drag every attached image's bytes into the history response.
      include: { image: { select: { id: true } } },
    }),
  ]);

  const senderIds = [...new Set(announcements.map((a) => a.sentById))];
  const senders = await prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, fullName: true } });
  const senderName = new Map(senders.map((s) => [s.id, s.fullName]));

  // Read tracking (#1721): an aggregate over the bell rows each broadcast
  // already wrote (`Notification.read`, keyed by announcementId) — no new
  // mechanism. Delivered = rows written; read = rows the reader opened.
  const ids = announcements.map((a) => a.id);
  const counts = ids.length
    ? await prisma.notification.groupBy({
        by: ['announcementId', 'read'],
        where: { announcementId: { in: ids } },
        _count: { _all: true },
      })
    : [];
  const stats = new Map<string, { delivered: number; read: number }>();
  for (const c of counts) {
    if (!c.announcementId) continue;
    const s = stats.get(c.announcementId) ?? { delivered: 0, read: 0 };
    s.delivered += c._count._all;
    if (c.read) s.read += c._count._all;
    stats.set(c.announcementId, s);
  }

  return NextResponse.json({
    announcements: announcements.map(({ image, ...a }) => ({
      ...a,
      audience: parseAudience(a.audience),
      delivered: stats.get(a.id)?.delivered ?? 0,
      read: stats.get(a.id)?.read ?? 0,
      // Normalized rather than passed through raw: the edit form binds one box
      // per language and should never be handed an unexpected key (#1163).
      translations: normalizeAnnouncementTranslations(a.translations),
      machineTranslated: normalizeMachineList(a.machineTranslated, normalizeAnnouncementTranslations(a.translations)),
      sentByName: senderName.get(a.sentById) ?? null,
      imageUrl: image ? announcementImageUrl(a.id) : null,
    })),
    total,
    page,
    pageSize,
  });
  });
}

// POST — broadcast an announcement to its audience (everyone by default; the
// criteria of #1721 otherwise) as an in-app notification, optionally also by
// email (respecting each user's opt-out) — now, or at `scheduledAt`.
export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  return await withTenantScope(session, async () => {
  const { fields, image } = await readBody(request);
  const parsed = schema.safeParse(fields);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const { link, email } = parsed.data;

  // One message, up to three languages (#1163). `text` is the canonical body —
  // the default locale's version, or the first language that was filled in —
  // and it is what a reader whose language was never written falls back to.
  const translations = normalizeAnnouncementTranslations(parsed.data.translations);
  const text = canonicalAnnouncementText(translations, parsed.data.text);
  // Neither a `text` nor a single non-blank translation: there is no message.
  if (!text) {
    return NextResponse.json({ error: 'Validation failed', details: { formErrors: ['text required'] } }, { status: 400 });
  }

  // Validated (type, size, magic bytes) before any fan-out happens — a rejected
  // image must not leave behind notifications for a broadcast that never landed.
  let imageData: Buffer | null = null;
  if (image) {
    const invalid = await validateAnnouncementImage(image);
    if (invalid) return NextResponse.json({ error: IMAGE_ERROR[invalid] }, { status: 400 });
    imageData = Buffer.from(await image.arrayBuffer());
  }

  if (!isValidAudienceInput(parsed.data.audience)) {
    return NextResponse.json({ error: 'Validation failed', details: { formErrors: ['audience'] } }, { status: 400 });
  }
  const audience = parseAudience(parsed.data.audience);
  let scheduledAt: Date | null = null;
  if (parsed.data.scheduledAt) {
    const when = new Date(parsed.data.scheduledAt);
    const lead = when.getTime() - Date.now();
    if (Number.isNaN(when.getTime()) || lead > MAX_SCHEDULE_LEAD_MS) {
      return NextResponse.json({ error: 'Validation failed', details: { formErrors: ['scheduledAt'] } }, { status: 400 });
    }
    if (lead >= MIN_SCHEDULE_LEAD_MS) scheduledAt = when;
  }

  // The audience is the SENDING TENANT's people, by hand (#2542, #2590) —
  // narrowed by the announcement's criteria (#1721), resolved here on the
  // server. The middleware does not scope while MT_ENFORCE_ISOLATION is off, so
  // the tenant filter is explicit; it is also the set the quota below is
  // measured against, so the number checked and the number mailed agree.
  const tenant = await tenantWhere(session);
  const users = await announcementRecipients(tenant, audience);

  // Who would actually be MAILED — computed before anything is written, because
  // that count is what the broadcast quota is measured against and a refusal
  // must not leave an Announcement row behind (#1754). For a scheduled send it
  // is an estimate checked now and checked again when it goes out.
  const mailRecipients = email ? announcementMailRecipients(users) : [];

  // Only the e-mail half is metered (an in-app announcement costs the sending
  // domain nothing).
  if (mailRecipients.length > 0) {
    const quota = await checkBroadcastQuota({
      orgId: resolveOrgId(session),
      requested: mailRecipients.length,
    });
    if (!quota.allowed) {
      // Refused WHOLE, before the first message.
      return NextResponse.json(broadcastQuotaError(quota), { status: 403 });
    }
  }

  // The Announcement row is written BEFORE the fan-out, so every notification it
  // produces can carry its id (#1162) — that link is what lets a later edit
  // correct the copy already sitting in everyone's bell, and a delete take those
  // rows with it.
  const announcement = await prisma.announcement.create({
    data: {
      text,
      translations,
      machineTranslated: normalizeMachineList(parsed.data.machineTranslated, translations),
      link: link || null,
      sentById: session.user.id,
      // The sending tenant (#2357).
      orgId: resolveOrgId(session),
      recipientCount: scheduledAt ? 0 : users.length,
      ...(audience ? { audience, targeted: true } : {}),
      ...(scheduledAt ? { scheduledAt, status: 'SCHEDULED' as const, emailRequested: !!email } : {}),
      ...(imageData && image
        ? { image: { create: { contentType: image.type, size: image.size, data: imageData } } }
        : {}),
    },
  });

  if (scheduledAt) {
    // On the job queue, not a cron (#1721): one job per announcement, due at its
    // time. Cancel or delete before then and the job finds nothing to claim.
    await enqueue('announcement.send', { announcementId: announcement.id }, {
      runAt: scheduledAt,
      idempotencyKey: `announcement:${announcement.id}`,
      orgId: announcement.orgId,
      trigger: 'manual',
    });
    await logActivity({ action: 'announcement.scheduled', actorId: session.user.id, actorEmail: session.user.email ?? null, detail: scheduledAt.toISOString() });
    return NextResponse.json(
      { scheduled: true, scheduledAt: scheduledAt.toISOString(), estimate: { recipients: users.length, emailable: mailRecipients.length } },
      { status: 201 },
    );
  }

  const { emailed, queued, held, skipped } = await deliverAnnouncement({
    announcement: { id: announcement.id, text, translations, link: link || null },
    users,
    mailRecipients,
    image: imageData && image ? { data: imageData, contentType: image.type } : null,
  });

  if (emailed > 0) {
    await prisma.announcement.update({ where: { id: announcement.id }, data: { emailedCount: emailed } });
  }

  await logActivity({ action: 'announcement.broadcast', actorId: session.user.id, actorEmail: session.user.email ?? null });
  return NextResponse.json(
    {
      recipients: users.length,
      emailed,
      skipped,
      ...(held > 0 ? { held } : {}),
      imageUrl: imageData ? announcementImageUrl(announcement.id) : null,
      // How many wait on the mail queue and roughly how long they take at this
      // environment's pace (#2951) — the composer says so.
      ...(queued > 0 ? { mailQueue: await mailQueueNotice(queued, { orgId: resolveOrgId(session), channel: 'bulk' }) } : {}),
    },
    { status: 201 }
  );
  });
}
