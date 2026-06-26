import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

/**
 * Direct DB access for E2E setup/teardown. Lets tests seed invitation tokens and
 * users without going through the email-sending invite flow, so the suite is
 * self-contained and never sends real mail (works in CI and against any env).
 */
export const prisma = new PrismaClient();

export function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@e2e.local`;
}

export async function seedInvite(email: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE') {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.invitationToken.create({ data: { token, email, role, expiresAt } });
  return token;
}

export async function seedUser(
  email: string,
  password: string,
  role: 'ADMIN' | 'MENTOR' | 'MENTEE',
  fullName: string
) {
  const hash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: { email, password: hash, role, fullName, skills: [] },
  });
}

export async function cleanupByEmail(email: string) {
  // Remove dependent mentorship relations first, then the user + any tokens.
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.mentorshipRelation.deleteMany({
      where: { OR: [{ mentorId: user.id }, { menteeId: user.id }] },
    });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
  await prisma.invitationToken.deleteMany({ where: { email } });
}
