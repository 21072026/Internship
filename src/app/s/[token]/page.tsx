'use client';

import { use, useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { BrandTile } from '@/components/BrandMark';
import { useT } from '@/i18n/client';
import { isSurveyQuestionType, validateSurveyAnswer } from '@/lib/surveySchema';

// Answering a survey from the mailed link, no login (#1881). The RSVP page's
// shape: read the token from the route, GET the survey, POST the answers,
// render a done state. One question per screen on a phone, all of them on one
// screen from `sm` up. Partial answers live in component state only — an
// unfinished anonymous draft saved anywhere would be a stored identity.
// Answers are checked with the same validator the server uses.

interface Question {
  key: string;
  type: string;
  required: boolean;
  label: string;
  helpText: string | null;
  options: { value: string; label: string }[] | null;
}

interface SurveyPayload {
  state: 'open' | 'alreadyAnswered' | 'closed' | 'expired' | 'invalid';
  /** Starting values the server already knows (#1912) — still the person's to change. */
  prefill?: Record<string, unknown>;
  survey?: { title: string; intro?: string | null; anonymity?: 'IDENTIFIED' | 'CONFIDENTIAL' | 'ANONYMOUS'; questions?: Question[] };
}

type Answers = Record<string, unknown>;

export default function SurveyRespondPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const r = t.surveyRespond;
  const [data, setData] = useState<SurveyPayload | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`/api/surveys/respond?token=${encodeURIComponent(token)}`)
      .then(async (res) => (res.status === 429 ? { state: 'invalid' as const } : ((await res.json()) as SurveyPayload)))
      .then((d) => {
        setData(d);
        if (d.prefill) setAnswers((a) => ({ ...d.prefill, ...a }));
      })
      .catch(() => setData({ state: 'invalid' }));
  }, [token]);

  const questions = data?.survey?.questions ?? [];
  const errorText = (key: string) => (r.errors as Record<string, string>)[key] ?? r.errors.invalid_type;
  const check = (q: Question) =>
    isSurveyQuestionType(q.type)
      ? validateSurveyAnswer({ key: q.key, type: q.type, required: q.required, options: q.options?.map((o) => ({ value: o.value, labels: { en: o.label } })) }, answers[q.key])
      : null;
  const set = (key: string, value: unknown) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const next = () => {
    const q = questions[step];
    const error = q && check(q);
    if (error) return setErrors((e) => ({ ...e, [q.key]: errorText(error) }));
    setStep((s) => Math.min(s + 1, questions.length - 1));
  };

  const submit = async () => {
    const found: Record<string, string> = {};
    for (const q of questions) {
      const error = check(q);
      if (error) found[q.key] = errorText(error);
    }
    if (Object.keys(found).length) {
      setErrors(found);
      setStep(questions.findIndex((q) => found[q.key]));
      return;
    }
    setSending(true);
    const res = await fetch('/api/surveys/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, answers }),
    }).catch(() => null);
    setSending(false);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (body.state === 'answered') return setDone(true);
    if (body.state === 'invalid_answers') {
      setErrors(Object.fromEntries(Object.entries(body.errors ?? {}).map(([k, v]) => [k, errorText(String(v))])));
      return;
    }
    if (body.state) setData((d) => ({ ...(d ?? {}), state: body.state }));
  };

  const message =
    data?.state === 'alreadyAnswered' ? r.alreadyAnswered : data?.state === 'closed' ? r.closed : data?.state === 'expired' ? r.expired : data?.state === 'invalid' ? r.invalid : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-start sm:items-center justify-center p-4">
      <div className="w-full max-w-xl">
        <div className="flex justify-center mb-6">
          <BrandTile />
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 sm:p-8" data-testid="survey-respond">
          {data === null ? (
            <p className="text-gray-500 text-center">…</p>
          ) : done ? (
            <div className="flex flex-col items-center gap-2 text-center" data-testid="survey-thanks">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              <p className="font-semibold text-gray-900">{t.programSurvey.thankYou.title}</p>
              <p className="text-sm text-gray-600">{t.programSurvey.thankYou.message}</p>
            </div>
          ) : message ? (
            <p className="text-center text-gray-600" data-testid={`survey-state-${data.state}`}>
              {message}
            </p>
          ) : (
            <>
              <h1 className="text-xl font-bold text-gray-900">{data.survey?.title}</h1>
              {data.survey?.intro && <p className="text-gray-600 mt-1">{data.survey.intro}</p>}
              {data.survey?.anonymity && <p className="text-xs text-gray-500 mt-2" data-testid="survey-anonymity">{r.anonymity[data.survey.anonymity]}</p>}
              <p className="sm:hidden mt-4 text-xs text-gray-500" data-testid="survey-progress">
                {r.progress.replace('{n}', String(step + 1)).replace('{total}', String(questions.length))}
              </p>
              <div className="mt-4 space-y-6">
                {questions.map((q, i) => (
                  <fieldset key={q.key} className={i === step ? 'block' : 'hidden sm:block'} data-testid={`survey-q-${q.key}`}>
                    <legend className="font-medium text-gray-900">
                      {q.label}
                      {q.required && <span className="text-red-500"> *</span>}
                    </legend>
                    {q.helpText && <p className="text-xs text-gray-500 mt-0.5">{q.helpText}</p>}
                    <div className="mt-2">
                      <Field q={q} value={answers[q.key]} onChange={(v) => set(q.key, v)} t={t} />
                    </div>
                    {errors[q.key] && <p className="mt-1 text-sm text-red-600" role="alert">{errors[q.key]}</p>}
                  </fieldset>
                ))}
              </div>
              <div className="mt-6 flex items-center justify-between gap-3">
                <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className="sm:hidden text-sm text-gray-600 disabled:opacity-40">
                  {r.back}
                </button>
                {step < questions.length - 1 && (
                  <button type="button" onClick={next} className="sm:hidden rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white" data-testid="survey-next">
                    {r.next}
                  </button>
                )}
                <button
                  type="button"
                  onClick={submit}
                  disabled={sending}
                  data-testid="survey-submit"
                  className={`${step < questions.length - 1 ? 'hidden sm:inline-flex' : 'inline-flex'} ml-auto rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50`}
                >
                  {r.submit}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ q, value, onChange, t }: { q: Question; value: unknown; onChange: (v: unknown) => void; t: ReturnType<typeof useT> }) {
  const r = t.surveyRespond;
  const pill = (active: boolean) =>
    `min-w-9 h-9 px-2 rounded-lg border text-sm font-medium ${active ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`;
  switch (q.type) {
    case 'NPS':
    case 'SCALE': {
      const [min, max] = q.type === 'NPS' ? [0, 10] : [1, 5];
      const low = q.type === 'NPS' ? t.programSurvey.scaleLow : t.surveyTemplates.scale.low;
      const high = q.type === 'NPS' ? t.programSurvey.scaleHigh : t.surveyTemplates.scale.high;
      // inline-block: the anchor labels span the buttons, not the whole card.
      return (
        <div className="inline-block max-w-full">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={q.label}>
            {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={value === n} onClick={() => onChange(n)} className={pill(value === n)} data-testid={`survey-${q.key}-${n}`}>
                {n}
              </button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-gray-400">
            <span>{low}</span>
            <span>{high}</span>
          </div>
        </div>
      );
    }
    case 'BOOLEAN':
      return (
        <div className="flex gap-2">
          <button type="button" onClick={() => onChange(true)} className={pill(value === true)}>{r.yes}</button>
          <button type="button" onClick={() => onChange(false)} className={pill(value === false)}>{r.no}</button>
        </div>
      );
    case 'SELECT':
      return (
        <div className="space-y-1">
          {(q.options ?? []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="radio" name={q.key} checked={value === o.value} onChange={() => onChange(o.value)} /> {o.label}
            </label>
          ))}
        </div>
      );
    case 'MULTI_SELECT': {
      const current = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="space-y-1">
          {(q.options ?? []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={current.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value))}
              />{' '}
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'NUMBER':
      return (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      );
    case 'DATE':
      return <input type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />;
    case 'LONG_TEXT':
      return (
        <textarea
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          maxLength={5000}
          className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          data-testid={`survey-${q.key}-text`}
        />
      );
    default:
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          maxLength={500}
          className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          data-testid={`survey-${q.key}-text`}
        />
      );
  }
}
