import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';

const schema = z.object({
  companyId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
});

// POST — admin provisions a read-only COMPANY login for a company. The user is
// created unverified with a placeholder password and emailed a set-password link.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  const { companyId, email, fullName } = parsed.data;

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });

  const user = await prisma.user.create({
    data: { email, fullName, role: 'COMPANY', companyId, password: '!company-no-login', emailVerified: false, skills: [] },
  });

  const token = await createPasswordResetToken(user.id, 'SET_INITIAL');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  try {
    await sendPasswordResetEmail({ to: user.email, token, fullName: user.fullName, purpose: 'SET_INITIAL' });
  } catch (e) {
    console.error('Company-user set-password email failed:', e);
  }

  return NextResponse.json({ ok: true, setPasswordUrl: `${appUrl}/auth/reset?token=${token}` });
}
