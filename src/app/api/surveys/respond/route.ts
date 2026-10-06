import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { hashSurveyToken, submitSurveyResponse, SurveyAnswerInvalid, SurveyConflict, surveyAcceptsAnswers } from '@/lib/surveys';
import { resolveSurveyInvitation, type ResolvedInvitation } from '@/lib/surveyTokens';
import { pickLocalized } from '@/lib/surveySchema';

// Login-free survey answering (#1881). No session: the invitation token is the
// credential (src/lib/surveyTokens.ts). Both methods are rate-limited per IP,
// and POST also per token.
//
// GET returns the survey in the recipient's language and the invitation's
// STATE — `open`, `alreadyAnswered`, `closed`, `expired` — so the page can say
// something specific instead of failing. It never returns an answer: not
// anyone else's, and not the recipient's own (an anonymous answer has no owner
// to show it to).
//
// POST validates every answer through the shared validator and writes through
// submitSurveyResponse(), which severs the identity for ANONYMOUS surveys and
// claims the invitation so it answers once. A second submit is a friendly
// `alreadyAnswered`, never an error page.

type LocalizedJson = Partial<Record<Locale, string>> | null;
const pick = (text: unknown, locale: Locale) => pickLocalized(text, locale);

function localeOf(inv: ResolvedInvitation): Locale {
  if (isLocale(inv.locale ?? undefined)) return inv.locale as Locale;
  if (isLocale(inv.user?.preferredLanguage ?? undefined)) return inv.user!.preferredLanguage as Locale;
  return defaultLocale;
}

function stateOf(inv: ResolvedInvitation): 'open' | 'alreadyAnswered' | 'closed' {
  if (inv.respondedAt) return 'alreadyAnswered';
  return surveyAcceptsAnswers(inv.survey) ? 'open' : 'closed';
}

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, 'survey-read', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const inv = await resolveSurveyInvitation(token);
  if (inv === 'expired') return NextResponse.json({ state: 'expired' }, { status: 410 });
  if (!inv) return NextResponse.json({ state: 'invalid' }, { status: 404 });

  const locale = localeOf(inv);
  const state = stateOf(inv);
  return NextResponse.json({
    state,
    locale,
    survey:
      state === 'open'
        ? {
            title: pick(inv.survey.title, locale),
            intro: pick(inv.survey.intro, locale) || null,
            anonymity: inv.survey.anonymity,
            questions: inv.survey.questions.map((q) => ({
              key: q.key,
              type: q.type,
              required: q.required,
              label: pick(q.labels, locale),
              helpText: pick(q.helpText, locale) || null,
              options: Array.isArray(q.options)
                ? (q.options as { value: string; labels: LocalizedJson }[]).map((o) => ({ value: o.value, label: pick(o.labels, locale) }))
                : null,
            })),
          }
        : { title: pick(inv.survey.title, locale) },
  });
}

const postSchema = z.object({ token: z.string().min(1).max(200), answers: z.record(z.unknown()) }).strict();

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'survey-answer', { limit: 20, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  // Per token as well: one invitation cannot be hammered from many addresses.
  const perToken = enforceRateLimit(request, 'survey-answer-token', { limit: 10, windowMs: 10 * 60 * 1000, subject: hashSurveyToken(parsed.data.token) });
  if (perToken) return perToken;

  const inv = await resolveSurveyInvitation(parsed.data.token);
  if (inv === 'expired') return NextResponse.json({ state: 'expired' }, { status: 410 });
  if (!inv) return NextResponse.json({ state: 'invalid' }, { status: 404 });
  if (inv.respondedAt) return NextResponse.json({ state: 'alreadyAnswered' });
  if (!surveyAcceptsAnswers(inv.survey)) return NextResponse.json({ state: 'closed' });

  try {
    await submitSurveyResponse({
      surveyId: inv.survey.id,
      invitationId: inv.id,
      respondentId: inv.userId && inv.user?.isActive ? inv.userId : null,
      respondentRole: inv.user?.role ?? 'GUEST',
      answers: parsed.data.answers,
    });
    return NextResponse.json({ state: 'answered' });
  } catch (error) {
    if (error instanceof SurveyAnswerInvalid) return NextResponse.json({ state: 'invalid_answers', errors: error.errors }, { status: 400 });
    if (error instanceof SurveyConflict) {
      return NextResponse.json({ state: error.code === 'already_responded' ? 'alreadyAnswered' : 'closed' });
    }
    throw error;
  }
}
