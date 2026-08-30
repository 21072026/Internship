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

  // Coarse per-organization burst limit across all AI routes.
  // 120 calls / 10 minutes: Prevents a single tenant from starving shared capacity
  // or exhausting provider burst rates before fine-grained per-tenant quotas land (#1555).
  org_burst: { limit: 120, windowMs: 10 * 60 * 1000 },
} as const;
