// The refusals of the two thread-AI routes (#2048), in one place so they read
// the same as every other AI route: consent and quota are typed denials, a
// provider failure is "not right now", and none of them is ever a paywall.

import { NextResponse } from 'next/server';
import { AI_PACK_FEATURE, type AiDenialReason } from '@/lib/aiGate';

export function threadAiRefusal(reason: AiDenialReason | 'forbidden'): NextResponse {
  if (reason === 'forbidden') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (reason === 'no_consent') {
    return NextResponse.json({ error: 'Consent required', code: 'consent_required' }, { status: 403 });
  }
  // An operator use of a task without the AI pack (#1738): the shared locked shape.
  if (reason === 'not_entitled') return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: AI_PACK_FEATURE }, { status: 403 });
  if (reason === 'quota_exceeded') return NextResponse.json({ error: 'Monthly AI quota exhausted', code: 'quota_exceeded' }, { status: 429 });
  if (reason === 'provider_error') return NextResponse.json({ error: 'Temporarily unavailable', code: 'provider_error' }, { status: 503 });
  return NextResponse.json({ error: 'AI is not configured', code: 'not_configured' }, { status: 501 });
}
