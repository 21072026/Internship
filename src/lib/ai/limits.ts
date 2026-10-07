// AI endpoint rate limits (#2028).
//
// Every AI route is throttled before any database read or provider call to protect
// provider budgets and monthly organization quotas from rapid automated loops or
// accidental spam.
//
// NOTE: The underlying rate limiter is in-memory and per-container today (per-container
// until #1696 lands, which moves the counter behind a shared store). In the current
// single-container deployment, this provides process-local protection. For multi-container
// or distributed deployments, rate limiting state should be backed by Redis (#1696).
//
// Every limit carries its rationale below, matching the threshold documentation in
// k6/nightly-load.js.

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

export const AI_RATE_LIMITS = {
  // Generative mentee CV feedback (POST /api/cv/feedback).
  // 6 calls / 10 minutes: Generates multi-section analysis on full CV text. A mentee
  // iterating on their CV needs several minutes to edit and re-upload between runs;
  // 6 per 10m allows legitimate iterative feedback while blocking rapid script loops.
  cv_feedback: { limit: 6, windowMs: 10 * 60 * 1000 },

  // Generative interview preparation (POST /api/interview-prep).
  // 6 calls / 10 minutes: Generates tailored interview questions and scenarios.
  // Reviewing prep questions takes time; 6 per 10m provides generous headroom for
  // switching target positions or topics without draining provider tokens.
  interview_prep: { limit: 6, windowMs: 10 * 60 * 1000 },

  // AI-assisted CV profile field extraction (POST /api/cv/[userId]/extract-ai).
  // 6 calls / 10 minutes: Extracts structured profile fields from uploaded CV text.
  // Profile extraction only happens on upload or manual refresh; 6 per 10m easily
  // accommodates re-uploads while preventing bulk scraping.
  cv_extract: { limit: 6, windowMs: 10 * 60 * 1000 },

  // AI mentor match & ranking (POST /api/admin/mentor-suggest).
  // 20 calls / 10 minutes: Admin triage tool for candidate-to-mentor matching.
  // Admins processing queues legitimately click between candidates rapidly; 20 per 10m
  // accommodates an active triage session without risking runaway background loops.
  mentor_match: { limit: 20, windowMs: 10 * 60 * 1000 },

  // AI interaction summary (POST /api/interactions/summary).
  // 10 calls / 10 minutes: Summarizes relation interaction logs for mentors/admins.
  // Reviewing multiple mentee check-ins in a batch justifies a higher allowance than
  // mentee generative tools, while 10 per 10m buffers LLM token consumption.
  interaction_summary: { limit: 10, windowMs: 10 * 60 * 1000 },

  // Open-text insights (POST /api/admin/insights/*, #2046).
  // 10 calls / 10 minutes: one summary reads up to 400 rows, so a call is the
  // largest prompt an admin can start. Changing the date range or cohort a few
  // times is the legitimate pattern; an unchanged set is answered from the
  // stored artefact without reaching this limit's provider call at all.
  open_text_insights: { limit: 10, windowMs: 10 * 60 * 1000 },

  // Analytics "what changed" paragraph (POST /api/admin/analytics/narrative, #2046).
  // 10 calls / 10 minutes: a small prompt, but one an admin can re-trigger per
  // date range. An unchanged range is answered from the stored paragraph.
  analytics_narrative: { limit: 10, windowMs: 10 * 60 * 1000 },

  // Thread catch-up (POST /api/conversations/[id]/summary, #2048).
  // 10 calls / 10 minutes: a participant catching up on a few long threads in a
  // row is the legitimate pattern; an unchanged thread (same last message) is
  // answered from the stored summary without reaching the provider at all.
  thread_summary: { limit: 10, windowMs: 10 * 60 * 1000 },

  // Suggested reply (POST /api/conversations/[id]/suggest-reply, #2048).
  // 15 calls / 10 minutes: trying the three tones on one message is three calls,
  // so the allowance is a few messages' worth; the same tone on the same last
  // message is answered from the stored draft.
  suggested_reply: { limit: 15, windowMs: 10 * 60 * 1000 },

  // Grounded outreach draft (POST /api/mentorship/[id]/ai-draft, #2048).
  // 15 calls / 10 minutes: a mentor working through their quiet or newly
  // assigned mentees drafts one message each; the same relation state is
  // answered from the stored draft.
  outreach_draft: { limit: 15, windowMs: 10 * 60 * 1000 },

  // Bulk e-mail draft (POST /api/ai/bulk-draft, #2048).
  // 6 calls / 10 minutes: one call drafts the mail for up to 200 recipients,
  // so a handful of rewordings is the legitimate pattern.
  bulk_draft: { limit: 6, windowMs: 10 * 60 * 1000 },

  // Coarse per-organization burst limit across all AI routes.
  // 120 calls / 10 minutes: Prevents a single tenant from starving shared capacity
  // or exhausting provider burst rates before fine-grained per-tenant quotas land (#1555).
  org_burst: { limit: 120, windowMs: 10 * 60 * 1000 },
} as const;
