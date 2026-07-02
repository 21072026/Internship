# Research spike: auto-fill profile from an uploaded CV

**Issue:** #356 · **Status:** findings + recommendation · **Date:** 2026-07

## Goal

When a user uploads a CV, extract its content and **suggest** values for profile
fields (name, city, university, department, skills, target position, links, …)
so the profile can be filled in seconds instead of by hand. Long term we may use
an LLM for high-quality extraction — **only after explicit, revocable user
consent**, because CVs are real personal data (GDPR).

This document evaluates the options and proposes how to break the work into
implementation EPICs. **It introduces no code path that sends PII anywhere.**

## Constraints that shaped the analysis

- **Runtime:** Next.js 15 server inside Docker on Plesk. No headless Chromium;
  prefer pure-JS, no native build steps.
- **Privacy:** production data is real. The preview DB gets dummy data only.
  Anything that transmits a CV off-box needs consent + a data-handling note.
- **Languages:** CVs arrive in TR / DE / EN, often mixed, with varied layouts.

## Option A — No-AI, local parsing

Extract text on the server, then apply heuristics to guess fields.

| Format | Library | Notes |
|--------|---------|-------|
| PDF (text) | `pdf-parse` / `pdfjs-dist` | Pure JS. Good on text-based PDFs. |
| PDF (scanned) | (OCR, e.g. `tesseract.js`) | Heavy, slow, accuracy varies; out of scope for v1. |
| DOCX | `mammoth` | Reliable text + basic structure extraction. |

**Field heuristics that work reasonably well (high precision):**
- **E-mail / phone / URLs** (LinkedIn, GitHub, portfolio) — regex; ~high hit rate.
- **Skills** — match against our existing skills vocabulary; precise, no guessing.

**Field heuristics that are unreliable (low recall / precision):**
- **Name, city, university, department, dates, job titles** — depend heavily on
  layout. Multi-column PDFs interleave text; section headers vary by language
  ("Education" / "Ausbildung" / "Eğitim"). Naive parsing produces noisy guesses
  that users must correct — often more annoying than typing.

**Verdict:** cheap, fully private, **safe to ship for the easy fields**
(contact links + skills-vocabulary match). Weak for the structured biographical
fields, which are exactly the tedious ones.

## Option B — AI extraction (Claude) with a strict schema

Send the extracted text (not the raw file) to an LLM with a JSON schema for our
profile fields; show the result as **editable suggestions**, never auto-saved.

- **Quality:** strong across languages and layouts — handles the fields Option A
  can't. Best-in-class for "fill my profile from this CV."
- **Cost/latency:** one bounded call per upload; acceptable.
- **Privacy/GDPR — the gating concern:**
  - Requires **explicit opt-in** ("Use AI to read my CV and suggest fields"),
    revocable, off by default.
  - A clear data-handling note (what is sent, to whom, retention).
  - Send **parsed text**, not the file; strip nothing the user can't see.
  - A **no-AI fallback** (Option A) for users who decline.
  - Confirm provider data terms before enabling in production.

**Verdict:** the right long-term experience, but it must ride on a consent
framework we don't have yet.

## Recommendation

**Phased, consent-first.** Do not build one big feature.

1. **EPIC B1 — Local parse + safe suggestions (no AI).**
   Server-side text extraction (`pdf-parse` + `mammoth`); suggest only the
   high-precision fields (e-mail, phone, LinkedIn/GitHub/portfolio, and
   skills matched against our vocabulary). Present as a **review panel** with
   per-field "apply" — nothing auto-saved. Fully private; ships value fast.

2. **EPIC B2 — Consent framework.**
   A reusable, revocable per-user consent record + UI + data-handling copy
   (EN/TR/DE). Generic enough to gate any future external processing.

3. **EPIC B3 — AI extraction (depends on B1 + B2).**
   Behind the B2 consent gate, send parsed text to Claude with a strict JSON
   schema; map results into the B1 review panel. Keep the no-AI path as default.

Sequencing B1 → B2 → B3 means each EPIC ships independently, the privacy-risky
part is isolated and opt-in, and we never block the easy wins on the hard ones.

## Open questions for the product owner

- Is AI-assisted extraction desired at all, or is the no-AI version (B1) enough?
- Which fields are most worth auto-filling for *your* mentees in practice?
- Any provider/data-residency requirements for B3?

## Proposed follow-up issues

- [ ] **B1** local parse + safe suggestions (no AI) — review panel, per-field apply
- [ ] **B2** reusable user-consent framework (record + UI + EN/TR/DE copy)
- [ ] **B3** AI extraction behind the consent gate (strict schema, no-AI fallback)
