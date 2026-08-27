import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { TEXT_LIMITS } from '@/lib/textLimits';

export const REQUISITION_STATUSES = ['DRAFT', 'OPEN', 'ON_HOLD', 'FILLED', 'CANCELLED'] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export const REQUISITION_LIMITS = {
  title: 191,
  description: TEXT_LIMITS.companyDescription,
  city: 191,
  workMode: 191,
  skills: 50,
  skill: 100,
  pageSize: 100,
} as const;

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const isoDate = z.string().datetime({ offset: true }).nullable().optional();

export const requisitionInputSchema = z.object({
  companyId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(REQUISITION_LIMITS.title),
  description: nullableText(REQUISITION_LIMITS.description),
  status: z.enum(REQUISITION_STATUSES).default('DRAFT'),
  openings: z.number().int().min(1),
  filled: z.number().int().min(0).default(0),
  requiredSkills: z.array(z.string()).max(REQUISITION_LIMITS.skills),
  city: nullableText(REQUISITION_LIMITS.city),
  workMode: nullableText(REQUISITION_LIMITS.workMode),
  startDate: isoDate,
  ownerId: z.string().min(1).nullable().optional(),
}).strict();

export const requisitionPatchSchema = requisitionInputSchema.partial().omit({ companyId: true });

export const PROTECTED_REQUISITION_FIELDS = [
  'orgId', 'legacyCompanyNeedId', 'createdAt', 'closedAt',
] as const;

export function protectedFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return PROTECTED_REQUISITION_FIELDS.filter((field) => field in body);
}
export function normalizeSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of skills) {
    const skill = value.trim();
    if (!skill || seen.has(skill.toLocaleLowerCase('tr'))) continue;
    if (skill.length > REQUISITION_LIMITS.skill) throw new Error('skill_too_long');
    seen.add(skill.toLocaleLowerCase('tr'));
    normalized.push(skill);
  }
  return normalized;
}
export function closedAtForStatus(status: string, previous: Date | null = null): Date | null {
  if (status === 'FILLED' || status === 'CANCELLED') return previous ?? new Date();
  return null;
}

export async function validateRequisitionOwner(ownerId: string | null | undefined, orgId: string, companyId: string) {
  if (!ownerId) return null;
  return prisma.user.findFirst({
    where: { id: ownerId, orgId, companyId, role: 'COMPANY', isActive: true },
    select: { id: true },
  });
}

export async function validateOfferRequisition(
  requisitionId: string | null | undefined,
  orgId: string | null,
  companyId: string | null,
) {
  if (!requisitionId) return { ok: true as const };
  const requisition = await prisma.requisition.findFirst({
    where: { id: requisitionId, ...(orgId ? { orgId } : {}) },
    select: { companyId: true },
  });
  if (!requisition) return { ok: false as const, status: 404, code: 'requisition_not_found' as const };
  if (requisition.companyId !== companyId) {
    return { ok: false as const, status: 400, code: 'requisition_company_mismatch' as const };
  }
  return { ok: true as const };
}
