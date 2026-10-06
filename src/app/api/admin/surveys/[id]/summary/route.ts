import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { runAiGated } from '@/lib/aiGate';
import { getLocale } from '@/i18n/server';
import { loadSurveyResults } from '@/lib/surveyResults';
import { prepareAnswerTexts } from '@/lib/surveyTextRules';
import { aiSummarizeSurveyTexts } from '@/lib/surveyTextSummary';

// "Summarise these answers" (#1910) — an admin-triggered AI summary of one
// free-text question: themes plus quotes that appear verbatim in the answers.
//   • ADMIN only, tenant-scoped. An org-side feature: participant-facing AI is
//     untouched, and nobody is shown a paywall.
//   • Only above the survey's response floor — the same `suppressed` verdict
//     the results screen uses (409 `below_floor`), so a summary can never be
//     read where the raw answers could not.
//   • The texts come from loadSurveyResults, i.e. unattributed and in
//     alphabetical order, and pass prepareAnswerTexts (contact details masked)
//     before they leave. No respondent id, name or timestamp is ever sent.
//   • Through runAiGated: quota-metered, and no per-person consent because no
//     person is processed — the same footing as mentor_match's anonymous
//     labels. When AI is unavailable the reply says why and the screen keeps
//     the plain list (graceful degradation, never an error).
const bodySchema = z.object({ questionKey: z.string().min(1).max(64) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  const { id } = await params;
  const locale = await getLocale();
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const owned = await prisma.survey.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { id: true } });
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const results = await loadSurveyResults(owned.id, locale);
    if (!results || results.suppressed) return NextResponse.json({ error: 'below_floor', code: 'below_floor' }, { status: 409 });
    const question = results.questions.find((q) => q.key === parsed.data.questionKey);
    if (!question || (question.type !== 'TEXT' && question.type !== 'LONG_TEXT')) {
      return NextResponse.json({ error: 'not_text', code: 'not_text' }, { status: 400 });
    }
    const answers = prepareAnswerTexts(question.texts ?? []);
    if (answers.length === 0) return NextResponse.json({ summary: null, reason: 'no_answers' });

    const gated = await runAiGated({
      scope: 'survey_summary',
      orgId,
      userId: session.user.id,
      call: () => aiSummarizeSurveyTexts(question.label, answers),
    }).catch(() => ({ ok: false as const, reason: 'provider_error' as const }));
    if (!gated.ok) return NextResponse.json({ summary: null, reason: gated.reason });
    if (!gated.result) return NextResponse.json({ summary: null, reason: 'unreadable' });
    return NextResponse.json({ summary: { themes: gated.result, answersSent: answers.length } });
  });
}
