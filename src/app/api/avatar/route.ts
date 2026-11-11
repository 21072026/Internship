import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { actorFromSession, can } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { contentMatchesType, CONTENT_MISMATCH_ERROR } from '@/lib/fileType';
import { resolveOrgId } from '@/lib/orgScope';
import { userInCallerOrg } from '@/lib/ownerOrg';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// POST (multipart) — upload/replace own avatar (admin may set anyone's via targetUserId).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const form = await request.formData();
  const file = form.get('file');
  const targetUserId = (form.get('targetUserId') as string) || session.user.id;

  // Someone else's avatar is an admin's write — the permission layer's answer (#1571).
  if (targetUserId !== session.user.id) {
    const actor = await actorFromSession(session);
    if (!actor || !(await can(actor, 'user.write', undefined, session))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
  // An admin sets avatars in their own org only (#2542): AvatarFile carries no
  // orgId, so the target user's org is the boundary; a foreign one reads as 404.
  if (targetUserId !== session.user.id && !(await userInCallerOrg(targetUserId, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json({ error: 'Only PNG, JPEG, WebP or GIF images are allowed' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Image too large (max 2 MB)' }, { status: 400 });
  }

  const data = Buffer.from(await file.arrayBuffer());
  if (!contentMatchesType(data, file.type)) {
    return NextResponse.json({ error: CONTENT_MISMATCH_ERROR }, { status: 400 });
  }
  await prisma.avatarFile.upsert({
    where: { userId: targetUserId },
    create: { userId: targetUserId, contentType: file.type, size: file.size, data },
    update: { contentType: file.type, size: file.size, data },
  });
  // An upload is the user's own photo: clearing the hash tells the SSO
  // directory sync (#1943) not to replace it unless the IdP is authoritative.
  await prisma.user.update({ where: { id: targetUserId }, data: { avatarUrl: `/api/avatar/${targetUserId}`, ssoPhotoUrlHash: null } });

  return NextResponse.json({ ok: true, avatarUrl: `/api/avatar/${targetUserId}` });
  });
}
