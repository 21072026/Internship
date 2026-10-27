# Accessibility — manual test protocol (#2864)

The VPAT (`src/lib/vpat.ts` → `docs/legal/vpat.md`) marks a row **Partially Supports** whenever
the only thing between it and **Supports** is a test a machine cannot run: listening to a page
with a screen reader, walking it with the keyboard alone, zooming it, judging whether a link text
makes sense. This file is that test — the procedure, and the log a person fills in. Every row
whose remark says *manual verification pending* cites this file as evidence.

**A row moves to `Supports` only when the log below has a dated `pass` for that criterion on
every page in scope with both screen-reader setups** (or a `pass` with a named, filed issue for
each deviation). Then edit the row in `src/lib/vpat.ts`, run `npm run vpat:evidence`, and keep
this file in the row's `evidence`.

Nobody has run it yet. An agent cannot: the result is a human's judgement of what they heard.

## Setup

| Id | Assistive technology | Browser | OS |
|----|----------------------|---------|----|
| **NVDA** | NVDA (latest stable), default settings, browse + focus mode | Firefox (latest ESR or stable) | Windows 11 |
| **VO** | VoiceOver, default settings, rotor in use | Safari (latest) | macOS (latest) |
| **KB** | keyboard only, no AT — mouse unplugged or untouched | Chrome (latest) | any |
| **ZOOM** | browser zoom 200 % and 400 %, plus a 320 CSS px wide window | Chrome (latest) | any |

Accounts: a local database with `npx prisma db seed` + `npm run seed:demo`
(`admin.demo@demo.example.com` / `DemoPass123!` and the demo mentor / mentee / company).
**Never on production or preview data** (`docs/DATA_ACCESS_POLICY.md`). Light and dark theme
both, where the criterion is visual.

## Pages in scope

The same page states the automated scan covers (`e2e/a11y-scan.spec.ts`, appendix of the VPAT),
so manual and automated evidence speak about the same URLs:

| Area | Pages |
|------|-------|
| Public | `/`, `/auth/signin`, `/accessibility`, `/apply/:mentorId` |
| Mentee | `/portal`, `/portal/journey`, `/portal/goals`, `/portal/calendar`, `/portal/requests`, `/portal/profile`, `/portal/projects`, `/portal/interactions`, `/portal/notes`, `/account`, `/messages`, `/notifications` |
| Mentor | `/mentor`, `/mentor/mentees`, `/mentor/board` |
| Admin | `/admin`, `/admin/candidates`, `/admin/board`, `/admin/settings`, `/admin/companies/:id` |
| Company | `/company` |

## Procedure per criterion

Each check names which setups it needs. "Pass" means: no instance on the page fails the check.

| Criterion | Setups | What to do — and what fails |
|-----------|--------|-----------------------------|
| 1.1.1 Non-text Content | NVDA, VO | Move through every image, icon button and chart. Fails: an image announced by file name, an icon button without a name, a decorative image that is announced, a chart with no text equivalent. |
| 1.3.1 Info and Relationships | NVDA, VO | Use the headings, landmarks, lists and tables rotors. Fails: something that *looks* like a heading, list, table or group and is not announced as one; a form field announced without its visible label. |
| 1.3.2 Meaningful Sequence | NVDA, VO | Read the page top to bottom in browse mode. Fails: content read in an order that changes its meaning (e.g. a value before its label, a sidebar in the middle of a form). |
| 1.3.3 Sensory Characteristics | review | Read every instruction. Fails: an instruction that only works by shape, colour, size or position ("click the green button on the right"). |
| 1.3.5 Identify Input Purpose | review (DevTools) | Inspect personal-data fields (name, e-mail, phone, address). Fails: missing or wrong `autocomplete`. |
| 1.4.1 Use of Color | review, both themes | Look at every status, chart and link. Fails: a state or a link told apart by colour alone. |
| 1.4.5 Images of Text | review | Fails: text shipped as an image (logos excepted). |
| 1.4.10 Reflow | ZOOM | 320 px wide / 400 %. Fails: horizontal scrolling for anything but tables, maps, the board; content cut off or overlapping. |
| 1.4.11 Non-text Contrast | review, both themes | Measure input borders, focus rings, icon buttons, chart marks against their background. Fails: under 3:1. |
| 1.4.12 Text Spacing | bookmarklet | Apply the WCAG text-spacing bookmarklet. Fails: clipped or overlapping text. |
| 1.4.13 Content on Hover or Focus | KB + mouse | Open every tooltip/popover. Fails: it cannot be dismissed with Esc without moving focus, it disappears when the pointer moves onto it, or it vanishes on its own. |
| 2.1.1 Keyboard | KB | Do every task of the page (open, edit, save, delete, drag on the board via its select). Fails: anything reachable only with a mouse. |
| 2.4.3 Focus Order | KB | Tab through the page and every dialog. Fails: an order that does not follow the reading order, focus lost to `<body>` after a dialog closes. |
| 2.4.4 Link Purpose (In Context) | NVDA, VO | Open the links list. Fails: a link whose purpose is unclear even with its sentence/row ("here", a bare "more" in a list). |
| 2.4.6 Headings and Labels | NVDA, VO | Headings and labels list. Fails: a heading or label that does not describe its section/field. |
| 2.5.2 Pointer Cancellation | mouse | Press on a control, move off, release. Fails: the action fires on press. |
| 2.5.3 Label in Name | VO (voice control) or DevTools | Fails: a control whose accessible name does not contain its visible label. |
| 3.2.1 On Focus | KB | Tab onto every control. Fails: focus alone submits, navigates or opens a dialog. |
| 3.2.2 On Input | KB | Change every select, checkbox, radio. Fails: a change of context without prior warning. |
| 3.2.4 Consistent Identification | review | Fails: the same function named or iconed differently on two pages. |
| 3.3.1 Error Identification | NVDA, VO | Submit each form empty and with bad values. Fails: an error not announced, or not tied to its field. |
| 3.3.2 Labels or Instructions | NVDA, VO | Fails: a field whose format or requirement is only discoverable after an error. |
| 3.3.3 Error Suggestion | NVDA, VO | Fails: an error that says *that* something is wrong but not *how* to fix it, where a fix is known. |
| 4.1.2 Name, Role, Value | NVDA, VO | Operate every custom widget (search combobox, calendar grid, board stage select, dialogs, tabs, toggles). Fails: missing role, name or state; a state change not announced. |

## Results log

One line per run. `pass` / `fail #<issue>` / `n/a`. Never delete a line — a later run is a new line.

| Date | Tester | Setup | Page | Criteria | Result | Notes |
|------|--------|-------|------|----------|--------|-------|
| — | — | — | — | — | not run yet | — |
