# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/). The app
version is shown in the sidebar footer of every page (links to the
[user-facing release notes](src/lib/releaseNotes.ts), rendered at
`/release-notes`) and in the landing-page footer.

## [Unreleased]

### Fixed
- Onboarding checklist card on the dashboard was nearly unreadable in dark mode (#389).

## [0.2.0] - 2026-07-01

### Added
- **Dark mode** — OS-aware by default, user-togglable, preference persisted per-user (#343).
- **CV tools**:
  - Local, no-AI parsing of an uploaded CV → suggests contact links and skills for the profile (#361).
  - Reusable per-user consent framework (GDPR) gating optional data processing (#362).
  - Optional AI-assisted CV extraction (name, city, university, department, target position), gated behind explicit consent and only active when configured (#363).
- **Document templates v2** — multilingual (EN/TR/DE) catalog with an in-app preview and export to PDF / TXT / Markdown (#357).
- **Public profile**: language + theme toggles, a link back to the product, and a spam-protected contact form that notifies the profile owner (#382).
- **Skill self-assessment** — replaced the 1–5 numeric dropdown with a click-to-set star rating (#384).
- **App version display** + this changelog + a user-facing "What's new" page at `/release-notes`.
- Secure local-dev database setup docs (Docker MySQL, no shared-DB exposure) (#366).

### Fixed
- CV URL field no longer shows the internal upload path; hidden once a file CV exists (#355).
- Dark-mode contrast/visibility issues: hover states, native `<input>`/`<select>`, the translucent landing header, role cards, and the impersonation banner (#364, #380).
- Mentee portal sidebar now highlights the active page (#380).
- Public contact form's honeypot no longer leaks the anti-spam trap via a validation error.

## [0.1.0] - 2026-01-01

Initial platform baseline (predates formal changelog tracking): mentor↔mentee
pipeline tracking, role-scoped dashboards (admin/mentor/mentee/company/source),
interaction logging, Kanban board, calendar & reminders, analytics, document
uploads with versioning, two-factor authentication, invitation-based
registration, and English/Turkish/German localization.

[Unreleased]: https://github.com/mersahin/Internship/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mersahin/Internship/releases/tag/v0.2.0
[0.1.0]: https://github.com/mersahin/Internship/releases/tag/v0.1.0
