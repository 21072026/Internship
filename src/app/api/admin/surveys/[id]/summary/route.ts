import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { getLocale } from '@/i18n/server';
import { loadSurveyResults } from '@/lib/surveyResults';
import { runOpenTextSummary } from '@/lib/ai/summarizeOpenText';
import { AI_PACK_FEATURE } from '@/lib/aiGate';

// "Summarise these answers" (#1910) — an admin-triggered AI summary of one
// free-text question, on the open-text engine since #2046 part 2: themes with
// the answers behind each, a sentiment flag (no score), quotes that appear
// verbatim in an answer, and the caveats of how it was made.
//   • ADMIN only, tenant-scoped. An org-side feature: participant-facing AI is
//     untouched, and nobody is shown a paywall. An operator task (#1738), so
//     an org without the AI pack gets the shared 403 `feature_locked` (the
//     gate's 'not_entitled') — the one denial that is not a 200 with a
//     reason, because it is not a passing condition the admin can fix here.
//   • Only above the survey's response floor — the same `suppressed` verdict
//     the results screen uses (409 `below_floor`) — AND only when the question
//     itself has at least that many written answers: the engine is handed the
//     survey's k-floor, so a question three people answered is not summarised
//     in a survey ten people took.
//   • The texts come from loadSurveyResults, i.e. unattributed and in
//     alphabetical order. The engine masks contact details and sends each
//     answer under a neutral label; no respondent id, name or timestamp exists
//     here to send. An answer's id is its position in that list, which is how
//     the screen opens the answers behind a theme.
//   • Through runAiGated: quota-metered, cached as an artefact keyed on exactly
//     the answers sent, and no per-person consent because no person is
//     processed. When AI is unavailable the reply says why and the screen keeps
//     the plain list (graceful degradation, never an error).
const bodySchema = z.object({ questionKey: z.string().min(1).max(64), regenerate: z.boolean().optional() }).strict();

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
    // Fewer than the floor answered this one question (#1877): no texts left the results either.
    if (question.suppressed) return NextResponse.json({ error: 'below_floor', code: 'below_floor' }, { status: 409 });
    const texts = question.texts ?? [];
    if (texts.length === 0) return NextResponse.json({ summary: null, reason: 'no_answers' });

    const outcome = await runOpenTextSummary({
      scope: 'survey_summary',
      orgId,
      userId: session.user.id,
      // The survey and question are part of each id, so two surveys with the
      // same answers never share a stored summary; only the index reaches the screen.
      items: texts.map((text, i) => ({ id: `${owned.id}/${question.key}/${i}`, text })),
      purpose: `written answers to one survey question: "${question.label}"`,
      locale,
      floor: results.floor,
      regenerate: parsed.data.regenerate,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_entitled') {
        return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: AI_PACK_FEATURE }, { status: 403 });
      }
      const reason = outcome.reason === 'no_rows' ? 'no_answers' : outcome.reason;
      return NextResponse.json({ summary: null, reason, caveats: 'caveats' in outcome ? outcome.caveats : [] });
    }
    const index = (rowId: string) => Number(rowId.slice(rowId.lastIndexOf('/') + 1));
    const s = outcome.summary;
    return NextResponse.json({
      summary: {
        themes: s.themes.map((t) => ({ label: t.label, count: t.count, sentiment: t.sentiment, answers: t.exampleIds.map(index) })),
        overall: s.overall,
        quotes: s.notableQuotes.map((q) => q.text),
        caveats: s.caveats,
        answersSent: s.sent,
      },
      cached: outcome.cached,
      artifact: outcome.artifact,
    });
  });
}
