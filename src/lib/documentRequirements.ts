import 'server-only';

import type { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { Locale } from '@/i18n/config';

export interface RequirementLabels { en: string; tr: string; de: string }

export interface MissingRequirement {
  id: string;
  key: string;
  label: string;
  labels: RequirementLabels;
  appliesToStage: string | null;
  appliesToRole: string | null;
  order: number;
}

interface RequirementRow {
  id: string;
  key: string;
  labels: unknown;
  appliesToStage: string | null;
  appliesToRole: string | null;
  order: number;
  mandatory: boolean;
  active: boolean;
}

export function parseRequirementLabels(value: unknown): RequirementLabels | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const labels = value as Record<string, unknown>;
  if (!['en', 'tr', 'de'].every((locale) => typeof labels[locale] === 'string' && labels[locale].trim().length > 0)) return null;
  return { en: String(labels.en).trim(), tr: String(labels.tr).trim(), de: String(labels.de).trim() };
}

export function requirementLabel(labels: unknown, locale: Locale, key: string): string {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return key;
  const values = labels as Record<string, unknown>;
  const localized = typeof values[locale] === 'string' ? values[locale].trim() : '';
  const english = typeof values.en === 'string' ? values.en.trim() : '';
  return localized || english || key;
}

function applies(requirement: RequirementRow, role: string, stages: Set<string>): boolean {
  return (!requirement.appliesToRole || requirement.appliesToRole === role)
    && (!requirement.appliesToStage || stages.has(requirement.appliesToStage));
}

function localized(requirement: RequirementRow, locale: Locale): MissingRequirement {
  const values = requirement.labels && typeof requirement.labels === 'object' && !Array.isArray(requirement.labels)
    ? requirement.labels as Record<string, unknown>
    : {};
  const labels: RequirementLabels = {
    en: requirementLabel(values, 'en', requirement.key),
    tr: requirementLabel(values, 'tr', requirement.key),
    de: requirementLabel(values, 'de', requirement.key),
  };
  return {
    id: requirement.id,
    key: requirement.key,
    label: requirementLabel(values, locale, requirement.key),
    labels,
    appliesToStage: requirement.appliesToStage,
    appliesToRole: requirement.appliesToRole,
    order: requirement.order,
  };
}

const requirementSelect = {
  id: true,
  key: true,
  labels: true,
  appliesToStage: true,
  appliesToRole: true,
  order: true,
  mandatory: true,
  active: true,
} as const;

export async function applicableRequirementsForUser(
  userId: string,
  locale: Locale,
  options: { mandatoryOnly?: boolean } = {},
): Promise<MissingRequirement[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      orgId: true,
      role: true,
      menteeRelations: { where: { status: 'ACTIVE' }, select: { pipelineStatus: true } },
    },
  });
  if (!user?.orgId) return [];
  const requirements = await prisma.documentRequirement.findMany({
    where: {
      orgId: user.orgId,
      active: true,
      ...(options.mandatoryOnly ? { mandatory: true } : {}),
      OR: [{ appliesToRole: null }, { appliesToRole: user.role }],
    },
    select: requirementSelect,
    orderBy: [{ order: 'asc' }, { key: 'asc' }],
  });
  const stages = new Set(user.menteeRelations.map((relation) => relation.pipelineStatus));
  return requirements.filter((requirement) => applies(requirement, user.role, stages)).map((requirement) => localized(requirement, locale));
}

export async function missingRequirementsForUser(userId: string, locale: Locale): Promise<MissingRequirement[]> {
  const applicable = await applicableRequirementsForUser(userId, locale, { mandatoryOnly: true });
  if (applicable.length === 0) return [];
  const completed = await prisma.document.findMany({
    where: { ownerId: userId, isTemplate: false, requirementId: { in: applicable.map((requirement) => requirement.id) } },
    select: { requirementId: true },
    distinct: ['requirementId'],
  });
  const completedIds = new Set(completed.map((document) => document.requirementId).filter(Boolean));
  return applicable.filter((requirement) => !completedIds.has(requirement.id));
}

export interface BulkMissingRow {
  user: { id: string; fullName: string; email: string; role: Role };
  stages: string[];
  missing: MissingRequirement[];
}

export async function bulkMissingRequirements(options: {
  orgId: string;
  role: Role;
  stage?: string;
  search?: string;
  page: number;
  pageSize: number;
  locale: Locale;
}): Promise<{ rows: BulkMissingRow[]; eligibleUserCount: number; page: number; pageSize: number; hasNextPage: boolean }> {
  const search = options.search?.trim();
  const userWhere = {
    orgId: options.orgId,
    role: options.role,
    isActive: true,
    ...(search ? { OR: [{ fullName: { contains: search } }, { email: { contains: search } }] } : {}),
    ...(options.stage ? { menteeRelations: { some: { status: 'ACTIVE' as const, pipelineStatus: options.stage } } } : {}),
  };
  const [requirements, users, eligibleUserCount] = await Promise.all([
    prisma.documentRequirement.findMany({
      where: {
        orgId: options.orgId,
        active: true,
        mandatory: true,
        OR: [{ appliesToRole: null }, { appliesToRole: options.role }],
      },
      select: requirementSelect,
      orderBy: [{ order: 'asc' }, { key: 'asc' }],
    }),
    prisma.user.findMany({
      where: userWhere,
      select: {
        id: true, fullName: true, email: true, role: true,
        menteeRelations: { where: { status: 'ACTIVE' }, select: { pipelineStatus: true } },
        documents: { where: { isTemplate: false, requirementId: { not: null } }, select: { requirementId: true } },
      },
      orderBy: { fullName: 'asc' },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.user.count({ where: userWhere }),
  ]);

  const rows = users.flatMap((user) => {
    const stages = [...new Set(user.menteeRelations.map((relation) => relation.pipelineStatus))];
    const stageSet = new Set(stages);
    const completed = new Set(user.documents.map((document) => document.requirementId).filter(Boolean));
    const missing = requirements
      .filter((requirement) => applies(requirement, user.role, stageSet) && !completed.has(requirement.id))
      .map((requirement) => localized(requirement, options.locale));
    return missing.length > 0 ? [{ user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role }, stages, missing }] : [];
  });
  return {
    rows,
    eligibleUserCount,
    page: options.page,
    pageSize: options.pageSize,
    hasNextPage: options.page * options.pageSize < eligibleUserCount,
  };
}
