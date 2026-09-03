# Accessibility statement (canonical source)

**Status:** partially conformant — WCAG 2.2 level AA
**Last reviewed:** 2026-09-02
**Published at:** `/accessibility` (EN/TR/DE) — `src/app/accessibility/page.tsx`

This is the long form of the public conformance statement (#2035, story #2033). The
page renders the same claims in three languages; this file is where the reasoning,
the evidence trail and the review rule live. **If you change one, change the other**
— the page's facts come from `src/lib/accessibility.ts` and its prose from the
`accessibility` i18n namespace.

The distinguishing feature of a credible statement is that it names its own open
defects. That is the whole point of the "Known limitations" section below: a
statement with an empty limitations list is a marketing claim, and
`e2e/accessibility-statement.spec.ts` fails if that list ever empties out.

---

## 1. The standard claimed

- **WCAG 2.2, level AA** — the success criteria everything else refers to.
- **EN 301 549** (clause 9, Web) — the harmonised European standard behind the
  **European Accessibility Act** (Directive (EU) 2019/882) and the **Web
  Accessibility Directive** (Directive (EU) 2016/2102). Clause 9 is WCAG 2.1 AA by
  reference; targeting 2.2 AA covers it.
- **Revised Section 508** (US) references WCAG 2.0 AA, which 2.2 AA contains.

No third-party audit has been commissioned against any of those documents. This is a
**self-assessment**, and the page says so.

## 2. Conformance status

**Partially conformant.** Most of the product meets the standard; the exceptions in
§5 do not. "Partially conformant" is the WCAG-defined wording for exactly this state
and is preferred here over a bare "we care about accessibility".

## 3. Scope

Covered: the InternshipCRM web application served from a given deployment — the
public pages, the sign-in flow, and the mentee, mentor, admin and company areas.

Not covered: files users upload (CVs, documents), e-mail as rendered by a third
party's mail client, and the embedded third-party services in §5.

**Measured automatically**, each in light *and* dark mode, in five role contexts
(public, mentee, mentor, admin, company) — `e2e/a11y-baseline.json` holds `<page>`
and `<page>#dark` for each:

```
/  ·  /auth/signin  ·  /accessibility  ·  /portal  ·  /portal/profile
/mentor  ·  /mentor/mentees  ·  /admin  ·  /admin/candidates  ·  /company
```

Everything else follows the same conventions but is **not** under the gate. That is
a limitation (§5), not a claim.

## 4. Method — how the claim is checked

| What | Where |
| --- | --- |
| axe-core scan, WCAG 2.0/2.1/2.2 A + AA rule sets, ten pages × five role contexts × light/dark | `e2e/a11y-scan.spec.ts` |
| Runs on **every pull request** as its own required step, outside the `@smoke` grep | `.github/workflows/e2e.yml` |
| Severity-classified result, regenerated with the baseline | `docs/a11y-audit.md` |
| Skip-to-content link on the app shell and every public page | `src/app/layout.tsx`, `src/components/landing/PublicShell.tsx` |
| Global `:focus-visible` ring, thickened under `prefers-contrast: more` | `src/app/globals.css` |
| Dialog focus management: initial focus, two-way tab trap, Escape, focus restore | `src/components/ui/useModalFocus.ts` |
| WCAG 2.2 Target Size — 44×44 on touch viewports, desktop density preserved | `src/components/ui/Button.tsx`, `src/components/ui/Input.tsx` |
| Keyboard alternative to board drag-and-drop | `src/components/board/CardStageSelect.tsx`, `e2e/board-a11y.spec.ts` |
| User-controlled text size | `src/components/FontSizeControl.tsx` |
| `prefers-reduced-motion`, `prefers-contrast`, `forced-colors` | `src/app/globals.css`, `src/lib/motion.ts`, `e2e/a11y-media-preferences.spec.ts` |
| EN/TR/DE with CI-enforced key parity; `lang` on the document | `scripts/check-i18n.ts`, `src/app/layout.tsx` |

At the last review `docs/a11y-audit.md` read **critical: 0 · serious: 0 · moderate: 0
· minor: 0** for the pages in scope.

**What the method does not do:** automated rules cover only part of a standard. There
is no external audit, no structured screen-reader test programme and no VPAT yet
(§5).

## 5. Known limitations

| Limitation | Tracked |
| --- | --- |
| The language and theme selects on `/account` have no accessible name (`select-name`, critical) — `src/components/AccountSettings.tsx` | [#2041](https://github.com/21072026/Internship/issues/2041) |
| Six screens have never been scanned: `/messages`, `/notifications`, `/mentor/board`, `/admin/board`, `/admin/settings`, `/apply*` | [#2043](https://github.com/21072026/Internship/issues/2043) |
| The scan's mentee has no `MentorshipRelation`, so the stage tracker, mentor card, goals and calendar never render and are measured as clean | [#1412](https://github.com/21072026/Internship/issues/1412) (story [#1400](https://github.com/21072026/Internship/issues/1400)) |
| Self-assessment only — no external audit, no screen-reader test programme, no VPAT | [#2033](https://github.com/21072026/Internship/issues/2033) |
| No right-to-left support: `src/app/layout.tsx` sets `lang` but never `dir` | not yet scheduled |
| Embedded third parties we do not control: the tawk.to live chat on the home page (marketing-cookie gated) and the Jitsi meeting room | not yet scheduled |

## 6. Feedback channel

The address on the page is **never a literal**. It is `operatorIdentity().email` from
`src/lib/imprint.ts`, the same source `/privacy` and `/imprint` use — this project is
AGPL and other people run their own instances, so an address written into the source
would print our operator's details on their statement. When a deployment has
published no identity, the page says so and points at the public issue tracker
instead of promising a channel that does not exist.

**Response target: 5 working days** (`ACCESSIBILITY_RESPONSE_DAYS`). A reporter is
explicitly told they do not need to know *why* something is broken or which criterion
it breaks — naming the page and what happened is enough.

Second channel, for anyone who prefers it: the public issue tracker, which is where
the fix is tracked either way.

## 7. Enforcement procedure

The page tells an unsatisfied reporter to escalate to the national authority
designated under the European Accessibility Act in the country they are in, and
points at `/imprint` for the operator those procedures apply to. **No specific
authority is named**: the operator is per-deployment (§6) and so is the competent
body — naming ours would be wrong for every other instance.

## 8. Review rule

Re-read this statement, and move the date at the top of both files, whenever:

1. a regenerate **widens** `e2e/a11y-baseline.json` — new violations frozen in rather
   than fixed. `e2e/a11y-scan.spec.ts` prints `⚠️ This regenerate WIDENS the
   accessibility baseline` and writes the same list into `docs/a11y-audit.md`; that
   warning invalidates the "zero critical, zero serious" sentence in §4;
2. a page joins or leaves the scan (`ACCESSIBILITY_SCANNED_PAGES` in
   `src/lib/accessibility.ts` must match `e2e/a11y-baseline.json`, and the "ten URLs"
   wording in the dictionaries must match both);
3. one of the limitations in §5 is closed, or a new one is found.
