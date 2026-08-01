import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import type { Prisma } from '@prisma/client';

// Field sets, narrowest first (#855). The admin list used to return every
// column — email, phone, university, department, birth year — for every user in
// the tenant, on every screen that needed so much as a name. `view` lets each
// caller ask for what it renders and nothing more.
const SELECTS = {
  // Owner/member pickers: a name and a role badge.
  picker: { id: true, fullName: true, role: true },
  // The /admin/users list: name, email, role badge, active/verified state.
  directory: { id: true, fullName: true, email: true, role: true, isActive: true, emailVerified: true },
} as const;

// No `view` → the historical full set. Still used by the candidates and mentors
// screens, which render university/skills/capacity columns.
const FULL_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  university: true,
  department: true,
  graduationYear: true,
  skills: true,
  mentorCapacity: true,
  phone: true,
  isActive: true,
  emailVerified: true,
  createdAt: true,
  _count: { select: { mentorRelations: true } },
} as const;

const ROLES = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE'] as const;

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      // Mentors get a minimal, PII-free directory of active mentors/admins —
      // just enough for the project owner/member picker (#618).
      if (session.user.role === 'MENTOR') {
        const users = await prisma.user.findMany({
          where: { role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
          select: SELECTS.picker,
          orderBy: { fullName: 'asc' },
        });
        return NextResponse.json({ users });
      }

      const { searchParams } = new URL(request.url);
      const view = searchParams.get('view');
      const select = view === 'picker' || view === 'directory' ? SELECTS[view] : FULL_SELECT;

      const roleParam = searchParams.get('role');
      const role = ROLES.find((r) => r === roleParam);
      const status = searchParams.get('status');
      const search = searchParams.get('search')?.trim();

      const where: Prisma.UserWhereInput = {};
      if (role) where.role = role;
      if (status === 'active') where.isActive = true;
      if (status === 'archived') where.isActive = false;
      if (search) {
        where.OR = [{ fullName: { contains: search } }, { email: { contains: search } }];
      }

      // Pagination is opt-in — applied only when `page` is passed, the same
      // contract /api/mentorship uses. The candidates and mentors screens filter
      // the whole set client-side and would break on a silently truncated list.
      const pageParam = searchParams.get('page');
      if (!pageParam) {
        const users = await prisma.user.findMany({ where, select, orderBy: { createdAt: 'desc' } });
        return NextResponse.json({ users });
      }

      const page = Math.max(1, parseInt(pageParam, 10) || 1);
      const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('perPage') || '25', 10) || 25));

      const [total, archivedCount, users] = await Promise.all([
        prisma.user.count({ where }),
        // For the "Archived (N)" tab: same role/search filter, opposite status.
        prisma.user.count({ where: { ...where, isActive: false } }),
        prisma.user.findMany({
          where,
          select,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * perPage,
          take: perPage,
        }),
      ]);

      return NextResponse.json({ users, total, page, perPage, archivedCount });
    });
  } catch (error) {
    console.error('Get users error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
